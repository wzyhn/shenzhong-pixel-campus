import { createHash, randomUUID } from 'node:crypto';
import { parseNameEggs } from './name-eggs.mjs';
import { transaction } from './store.mjs';

const db = 'paperplane_campus';
const operationFields = 'id, actor, action, target, result, created_at';

export class AdminError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

function requireRow(rows) {
  if (!rows.length) throw new AdminError(404, 'not_found');
  return rows[0];
}

function page(rows) {
  const items = rows.slice(0, 30);
  return { items, nextCursor: rows.length > items.length ? items.at(-1).id : null };
}

function catalogEntries(rows) {
  try {
    return parseNameEggs(rows);
  } catch {
    throw new AdminError(400, 'invalid_catalog');
  }
}

function mapEntries(eggs) {
  return Array.from(eggs, ([nickname, egg]) => ({ nickname, ...egg }));
}

export async function createAdminStore({ policyPool, pool, presence, originalEggs, onError = () => {} }) {
  let eggs = originalEggs;
  let catalogRevision = -1;
  let pauses = 0;
  const activeWrites = new Set();

  async function pauseWrites(operation) {
    pauses++;
    try {
      await Promise.all(activeWrites);
      return await operation();
    } finally {
      pauses--;
    }
  }

  async function refresh() {
    const { rows } = await policyPool.query(`SELECT s.revision, c.entries FROM ${db}.admin_settings s
      LEFT JOIN ${db}.admin_catalogs c ON c.id = s.active_catalog WHERE s.singleton`);
    if (rows.length !== 1) throw new Error('Campus admin migration is required');
    const { revision, entries } = rows[0];
    if (revision > catalogRevision) {
      try {
        eggs = entries ? catalogEntries(entries) : originalEggs;
      } catch {
        onError(Object.assign(new Error('Unable to validate the active campus catalog'), { code: 'CAMPUS_ACTIVE_CATALOG' }));
      }
      catalogRevision = revision;
    }
  }

  const { rows: [policy] } = await policyPool.query(`SELECT
    has_table_privilege('${db}.admin_settings', 'SELECT') AND has_table_privilege('${db}.admin_catalogs', 'SELECT')
    AND has_table_privilege('${db}.admin_bans', 'SELECT') AND has_table_privilege('${db}.admin_hidden_chat', 'SELECT') AS ready`);
  if (!policy.ready) throw new Error('Campus admin policy grants are required');
  await refresh();

  async function verifyWriter() {
    if (!pool) throw new Error('Campus admin database identity is required');
    const { rows: [privileges] } = await pool.query(`SELECT
    has_table_privilege('${db}.admin_settings', 'SELECT') AND has_table_privilege('${db}.admin_settings', 'UPDATE')
    AND has_table_privilege('${db}.admin_catalogs', 'SELECT') AND has_table_privilege('${db}.admin_catalogs', 'INSERT')
    AND has_table_privilege('${db}.admin_catalogs', 'UPDATE')
    AND has_table_privilege('${db}.admin_bans', 'SELECT') AND has_table_privilege('${db}.admin_bans', 'INSERT')
    AND has_table_privilege('${db}.admin_bans', 'UPDATE')
    AND has_table_privilege('${db}.admin_hidden_chat', 'SELECT') AND has_table_privilege('${db}.admin_hidden_chat', 'INSERT')
    AND has_table_privilege('${db}.admin_operations', 'SELECT') AND has_table_privilege('${db}.admin_operations', 'INSERT')
    AND has_table_privilege('${db}.admin_plans', 'SELECT') AND has_table_privilege('${db}.admin_plans', 'INSERT')
    AND has_table_privilege('${db}.admin_plans', 'UPDATE') AS ready`);
    if (!privileges.ready) throw new Error('Campus admin grants are required');
  }

  async function mutate(actor, key, action, target, input, apply) {
    const fingerprint = createHash('sha256').update(JSON.stringify([action, target, input])).digest();
    const outcome = await transaction(pool, async client => {
      const { rows: [settings] } = await client.query(`SELECT * FROM ${db}.admin_settings WHERE singleton FOR UPDATE`);
      const { rows: [previous] } = await client.query(`SELECT id, fingerprint, result FROM ${db}.admin_operations
        WHERE actor = $1 AND request_key = $2`, [actor, key]);
      if (previous) {
        if (!previous.fingerprint.equals(fingerprint)) throw new AdminError(409, 'idempotency_conflict');
        return { receipt: { operationId: previous.id, ...previous.result } };
      }
      const id = randomUUID();
      const { result, effect, plan } = await apply(client, settings, id);
      await client.query(`INSERT INTO ${db}.admin_operations (id, actor, request_key, fingerprint, action, target, result)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, actor, key, fingerprint, action, target, result]);
      if (plan) await client.query(`INSERT INTO ${db}.admin_plans (id, scope, expires_at) VALUES ($1, $2, $3)`,
        [id, plan.scope, plan.expiresAt]);
      return { receipt: { operationId: id, ...result }, effect };
    });
    outcome.effect?.();
    return outcome.receipt;
  }

  const active = id => `EXISTS (SELECT 1 FROM ${db}.admin_bans b WHERE b.player_id = ${id}
    AND b.lifted_at IS NULL AND b.ends_at > clock_timestamp())`;

  return {
    egg: nickname => eggs.get(nickname),
    verifyWriter,

    beginWrite() {
      if (pauses) return null;
      const { promise, resolve } = Promise.withResolvers();
      activeWrites.add(promise);
      return () => { activeWrites.delete(promise); resolve(); };
    },

    async access(token) {
      const digest = token ? createHash('sha256').update(token).digest() : null;
      const { rows: [row] } = await policyPool.query(`SELECT s.maintenance, s.revision,
        ${active('p.player_id')} AS banned FROM ${db}.admin_settings s LEFT JOIN ${db}.sessions p
        ON p.token_sha256 = $1 AND p.revoked_at IS NULL AND p.expires_at > clock_timestamp() WHERE s.singleton`, [digest]);
      if (row.revision > catalogRevision) await refresh();
      return row;
    },

    async status() {
      const { rows: [row] } = await pool.query(`SELECT maintenance, revision, active_catalog AS "activeCatalog"
        FROM ${db}.admin_settings WHERE singleton`);
      return { ...row, online: presence.count(), resetScopes: ['online'] };
    },

    async players(cursor, search = '') {
      const { rows } = await pool.query(`SELECT p.id, p.nickname, p.revision, p.nickname_conflict, p.updated_at,
        ${active('p.id')} AS banned FROM ${db}.players p WHERE ($1::uuid IS NULL OR p.id > $1)
        AND strpos(lower(p.nickname), lower($2)) > 0 ORDER BY p.id LIMIT 31`, [cursor, search]);
      return page(rows);
    },

    async player(id) {
      const { rows } = await pool.query(`SELECT p.id, p.nickname, p.revision, p.nickname_conflict, p.updated_at,
        ${active('p.id')} AS banned FROM ${db}.players p WHERE p.id = $1`, [id]);
      return requireRow(rows);
    },

    async bans(cursor, activeOnly) {
      const { rows } = await pool.query(`SELECT b.*, p.nickname FROM ${db}.admin_bans b
        JOIN ${db}.players p ON p.id = b.player_id WHERE ($1::uuid IS NULL OR b.id > $1)
        AND (NOT $2 OR (b.lifted_at IS NULL AND b.ends_at > clock_timestamp())) ORDER BY b.id LIMIT 31`, [cursor, activeOnly]);
      return page(rows);
    },

    ban(actor, key, { playerId, reason, until }) {
      return pauseWrites(() => mutate(actor, key, 'ban.create', playerId, { reason, until }, async client => {
        requireRow((await client.query(`SELECT id FROM ${db}.players WHERE id = $1`, [playerId])).rows);
        const { rows: [existing] } = await client.query(`SELECT ${active('$1')} AS active`, [playerId]);
        if (existing.active) throw new AdminError(409, 'player_already_banned');
        const id = randomUUID();
        const created = await client.query(`INSERT INTO ${db}.admin_bans (id, player_id, reason, ends_at)
          SELECT $1, $2, $3, $4::timestamptz WHERE $4::timestamptz > clock_timestamp() RETURNING ends_at`,
          [id, playerId, reason, until]);
        if (!created.rowCount) throw new AdminError(400, 'invalid_expiration');
        return { result: { banId: id, playerId, reason, until: created.rows[0].ends_at.toISOString() },
          effect: () => presence.revoke(playerId) };
      }));
    },

    lift(actor, key, banId, reason) {
      return mutate(actor, key, 'ban.lift', banId, { reason }, async client => {
        const { rows } = await client.query(`UPDATE ${db}.admin_bans SET lifted_at = COALESCE(lifted_at, clock_timestamp())
          WHERE id = $1 RETURNING player_id`, [banId]);
        return { result: { banId, playerId: requireRow(rows).player_id, lifted: true, reason } };
      });
    },

    async chat(cursor) {
      const { rows } = await pool.query(`SELECT m.id, m.player_id, p.nickname, m.body AS text, m.published_at,
        h.hidden_at IS NOT NULL AS hidden FROM ${db}.chat_messages m JOIN ${db}.players p ON p.id = m.player_id
        LEFT JOIN ${db}.admin_hidden_chat h ON h.message_id = m.id WHERE ($1::uuid IS NULL OR m.id > $1)
        AND m.revoked_at IS NULL AND m.published_at > clock_timestamp() - interval '7 days' ORDER BY m.id LIMIT 31`, [cursor]);
      return page(rows);
    },

    hideChat(actor, key, id, reason) {
      return mutate(actor, key, 'chat.hide', id, { reason }, async client => {
        requireRow((await client.query(`SELECT id FROM ${db}.chat_messages WHERE id = $1 FOR UPDATE`, [id])).rows);
        await client.query(`INSERT INTO ${db}.admin_hidden_chat (message_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
        return { result: { messageId: id, hidden: true, reason } };
      });
    },

    async activeCatalog() {
      const { rows: [row] } = await pool.query(`SELECT s.active_catalog AS id, s.revision, c.entries
        FROM ${db}.admin_settings s LEFT JOIN ${db}.admin_catalogs c ON s.active_catalog = c.id WHERE s.singleton`);
      return { id: row.id, revision: row.revision, entries: row.entries ?? mapEntries(originalEggs) };
    },

    async catalogs(cursor) {
      const { rows } = await pool.query(`SELECT id, revision, reviewed_revision, published_at, created_at
        FROM ${db}.admin_catalogs WHERE ($1::uuid IS NULL OR id > $1) ORDER BY id LIMIT 31`, [cursor]);
      return page(rows);
    },

    async catalog(id) {
      return requireRow((await pool.query(`SELECT id, revision, reviewed_revision, published_at, entries
        FROM ${db}.admin_catalogs WHERE id = $1`, [id])).rows);
    },

    draft(actor, key) {
      return mutate(actor, key, 'catalog.draft', null, {}, async (client, settings) => {
        const entries = settings.active_catalog ? requireRow((await client.query(`SELECT entries FROM ${db}.admin_catalogs
          WHERE id = $1`, [settings.active_catalog])).rows).entries : mapEntries(originalEggs);
        const id = randomUUID();
        await client.query(`INSERT INTO ${db}.admin_catalogs (id, entries) VALUES ($1, $2)`, [id, JSON.stringify(entries)]);
        return { result: { id, revision: 1, count: entries.length } };
      });
    },

    edit(actor, key, id, expected, entries) {
      return mutate(actor, key, 'catalog.edit', id, { expected, entries }, async client => {
        catalogEntries(entries);
        const { rowCount } = await client.query(`UPDATE ${db}.admin_catalogs SET entries = $3, revision = revision + 1,
          reviewed_revision = NULL WHERE id = $1 AND revision = $2 AND published_at IS NULL`, [id, expected, JSON.stringify(entries)]);
        if (!rowCount) throw new AdminError(409, 'catalog_changed_or_published');
        return { result: { id, revision: expected + 1, count: entries.length } };
      });
    },

    review(actor, key, id, expected) {
      return mutate(actor, key, 'catalog.review', id, { expected }, async client => {
        const { rows } = await client.query(`SELECT revision, entries FROM ${db}.admin_catalogs WHERE id = $1`, [id]);
        const catalog = requireRow(rows);
        if (catalog.revision !== expected) throw new AdminError(409, 'catalog_changed');
        const verified = catalogEntries(catalog.entries);
        await client.query(`UPDATE ${db}.admin_catalogs SET reviewed_revision = revision WHERE id = $1`, [id]);
        return { result: { id, revision: expected, reviewed: true, count: verified.size } };
      });
    },

    publish(actor, key, id, expected, version) {
      return mutate(actor, key, 'catalog.publish', id, { expected, version }, async (client, settings) => {
        if (settings.revision !== expected) throw new AdminError(409, 'settings_changed');
        let next = originalEggs;
        if (id !== null) {
          const { rows } = await client.query(`SELECT revision, reviewed_revision, entries FROM ${db}.admin_catalogs
            WHERE id = $1`, [id]);
          const catalog = requireRow(rows);
          if (catalog.revision !== version || catalog.reviewed_revision !== version) throw new AdminError(409, 'catalog_needs_review');
          next = catalogEntries(catalog.entries);
          await client.query(`UPDATE ${db}.admin_catalogs SET published_at = COALESCE(published_at, clock_timestamp()) WHERE id = $1`, [id]);
        }
        const revision = expected + 1;
        await client.query(`UPDATE ${db}.admin_settings SET active_catalog = $1, revision = $2 WHERE singleton`, [id, revision]);
        return { result: { activeCatalog: id, revision, count: next.size }, effect() {
          if (revision >= catalogRevision) { eggs = next; catalogRevision = revision; }
        } };
      });
    },

    maintenance(actor, key, enabled, expected, reason) {
      return pauseWrites(() => mutate(actor, key, 'maintenance.set', null, { enabled, expected, reason }, async (client, settings) => {
        if (settings.revision !== expected) throw new AdminError(409, 'settings_changed');
        const revision = expected + 1;
        await client.query(`UPDATE ${db}.admin_settings SET maintenance = $1, revision = $2 WHERE singleton`, [enabled, revision]);
        return { result: { maintenance: enabled, revision, reason } };
      }));
    },

    preview(actor, key, scope, reason) {
      return mutate(actor, key, 'reset.preview', scope, { reason }, async (client, settings) => {
        let count = presence.count();
        if (scope !== 'online') {
          const { rows: [counts] } = await client.query(`SELECT
            (SELECT count(*)::int FROM ${db}.sessions WHERE revoked_at IS NULL AND expires_at > clock_timestamp()) AS sessions,
            (SELECT count(*)::int FROM ${db}.players WHERE progress <> '{}'::jsonb) AS progress,
            (SELECT count(*)::int FROM ${db}.players) AS players`);
          count = counts[scope];
        }
        const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
        const result = { scope, count, reason, revision: settings.revision, expiresAt, executable: scope === 'online' };
        return { result, plan: { scope, expiresAt } };
      });
    },

    execute(actor, key, id, expected) {
      return pauseWrites(() => mutate(actor, key, 'reset.execute', id, { expected }, async (client, settings) => {
        const { rows } = await client.query(`SELECT p.*, o.actor, o.result FROM ${db}.admin_plans p
          JOIN ${db}.admin_operations o USING (id) WHERE p.id = $1 AND p.expires_at > clock_timestamp()`, [id]);
        const plan = requireRow(rows);
        if (plan.actor !== actor) throw new AdminError(403, 'plan_owner_mismatch');
        if (plan.scope !== 'online') throw new AdminError(409, 'reset_scope_disabled');
        if (plan.executed_at || expected !== settings.revision || expected !== plan.result.revision)
          throw new AdminError(409, 'stale_or_executed_plan');
        await client.query(`UPDATE ${db}.admin_plans SET executed_at = clock_timestamp() WHERE id = $1`, [id]);
        return { result: { planId: id, scope: 'online', cleared: presence.count() }, effect: () => presence.clear() };
      }));
    },

    async operation(id) {
      return requireRow((await pool.query(`SELECT ${operationFields} FROM ${db}.admin_operations WHERE id = $1`, [id])).rows);
    },

    async findOperation(actor, key) {
      return requireRow((await pool.query(`SELECT ${operationFields} FROM ${db}.admin_operations
        WHERE actor = $1 AND request_key = $2`, [actor, key])).rows);
    },

    async audit(cursor) {
      return page((await pool.query(`SELECT ${operationFields} FROM ${db}.admin_operations
        WHERE ($1::uuid IS NULL OR (created_at, id) < (
          SELECT created_at, id FROM ${db}.admin_operations WHERE id = $1))
        ORDER BY created_at DESC, id DESC LIMIT 31`, [cursor])).rows);
    },
  };
}
