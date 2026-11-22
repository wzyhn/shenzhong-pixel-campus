import { createHash, randomUUID } from 'node:crypto';
import { sessionPlayer, transaction } from './store.mjs';

const rows = 'paperplane_campus.chat_messages';
const messageFields = 'id, player_id, nickname, body, published_at';
const publicFields = 'm.id, m.player_id, p.nickname, m.body, m.published_at';

export function parseChatText(value) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cs}\u2028-\u202e\u2066-\u2069]/u.test(value)) return null;
  const text = value.trim();
  return /[^\p{Cf}\p{Z}\p{M}]/u.test(text) && [...text].length <= 40 ? text : null;
}

function publicMessage(row, viewer) {
  return {
    id: row.id,
    nickname: row.nickname,
    text: row.body,
    created_at: row.published_at.toISOString(),
    own: row.player_id === viewer,
  };
}

function receipt(row, viewer) {
  const body = row.revoked_at || row.hidden
    ? { status: 'revoked', message: null }
    : { status: 'published', message: publicMessage(row, viewer) };
  return { status: 200, body };
}

function error(status, code) {
  return { status, body: { error: code } };
}

async function withPlayer(pool, token, expectedID, lock, operation) {
  if (!token) return error(401, 'not_authenticated');
  return transaction(pool, async (client) => {
    const id = await sessionPlayer(client, token, lock);
    if (!id) return error(401, 'not_authenticated');
    if (id !== expectedID) return error(403, 'account_mismatch');
    return operation(client, id);
  });
}

async function publish(client, player, requestID, text, hidden) {
  const textDigest = createHash('sha256').update(text).digest();
  // This serializes admission budgets across independent accounts and API instances.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('paperplane_campus.chat_submission'))");
  await client.query(
    `DELETE FROM ${rows}
     WHERE published_at <= clock_timestamp() - interval '7 days'
       AND ((player_id = $1 AND request_id = $2) OR id IN (
         SELECT id FROM ${rows} WHERE published_at <= clock_timestamp() - interval '7 days'
         ORDER BY published_at LIMIT 64
       ))`,
    [player, requestID],
  );

  const { rows: [existing] } = await client.query(
    `SELECT ${publicFields}, m.text_sha256, m.revoked_at, ${hidden} AS hidden FROM ${rows} m
     JOIN paperplane_campus.players p ON p.id = m.player_id WHERE m.player_id = $1 AND m.request_id = $2`,
    [player, requestID],
  );
  if (existing) {
    return existing.text_sha256.equals(textDigest) ? receipt(existing, player) : error(409, 'request_conflict');
  }

  const { rows: [budget] } = await client.query(
    `SELECT count(*)::integer AS retained,
      count(*) FILTER (WHERE published_at > clock_timestamp() - interval '1 minute')::integer AS recent,
      count(*) FILTER (WHERE player_id = $1 AND published_at > clock_timestamp() - interval '1 hour')::integer AS author,
      count(*) FILTER (WHERE player_id = $1 AND published_at > clock_timestamp() - interval '6 seconds')::integer AS burst
     FROM ${rows}`,
    [player],
  );
  if (budget.retained >= 4096 || budget.recent >= 120 || budget.author >= 60 || budget.burst >= 3) {
    return error(429, 'chat_rate_limited');
  }

  const { rows: [created] } = await client.query(
    `INSERT INTO ${rows} (id, player_id, request_id, nickname, text_sha256, body)
     SELECT $1, p.id, $2, p.nickname, $3, $4 FROM paperplane_campus.players p WHERE p.id = $5
     RETURNING ${messageFields}, revoked_at`,
    [randomUUID(), requestID, textDigest, text, player],
  );
  return receipt(created, player);
}

export function createCampusChat(pool, { adminEnabled = false } = {}) {
  const hidden = adminEnabled ? 'EXISTS (SELECT 1 FROM paperplane_campus.admin_hidden_chat h WHERE h.message_id = m.id)' : 'false';
  return {
    async ready() {
      const { rowCount } = await pool.query(
        `SELECT 1 FROM paperplane_campus.migrations WHERE name = '003_chat.sql'
           AND has_table_privilege('${rows}', 'SELECT') AND has_table_privilege('${rows}', 'INSERT')
           AND has_table_privilege('${rows}', 'UPDATE') AND has_table_privilege('${rows}', 'DELETE')`,
      );
      return rowCount === 1;
    },

    history(token, expectedID) {
      return withPlayer(pool, token, expectedID, false, async (client, player) => {
        const { rows: result } = await client.query(
          `SELECT ${publicFields} FROM ${rows} m
           JOIN paperplane_campus.players p ON p.id = m.player_id
           WHERE NOT p.nickname_conflict AND m.revoked_at IS NULL AND NOT ${hidden}
             AND m.published_at > clock_timestamp() - interval '7 days'
           ORDER BY m.published_at DESC, m.id DESC LIMIT 30`,
        );
        return { status: 200, body: { messages: result.reverse().map((row) => publicMessage(row, player)) } };
      });
    },

    submit(token, expectedID, requestID, text) {
      return withPlayer(pool, token, expectedID, true, (client, player) => publish(client, player, requestID, text, hidden));
    },

    revoke(token, expectedID, id) {
      return withPlayer(pool, token, expectedID, true, async (client, player) => {
        const { rowCount } = await client.query(
          `UPDATE ${rows} SET revoked_at = COALESCE(revoked_at, clock_timestamp()), body = NULL
           WHERE id = $1 AND player_id = $2 AND published_at > clock_timestamp() - interval '7 days'`,
          [id, player],
        );
        return rowCount ? { status: 200, body: { revoked: true } } : error(404, 'not_found');
      });
    },
  };
}
