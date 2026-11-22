import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { maxAlbumBytes, maxAlbumPhotos, maxStoredPhotoBytes, maxStoredPhotos } from './album.mjs';

export const sessionLifetimeSeconds = 365 * 24 * 60 * 60;

export function createPool(connectionString) {
  return new pg.Pool({
    connectionString,
    max: 12,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    lock_timeout: 4_000,
    idle_in_transaction_session_timeout: 5_000,
  });
}

export function readDatabaseURL(variable) {
  const inline = process.env[variable];
  const file = process.env[variable + '_FILE'];
  if (Boolean(inline) === Boolean(file)) throw new Error('Configure one database URL source for ' + variable);
  let value = inline;
  if (file) {
    if (process.platform !== 'win32' && !file.startsWith('/')) throw new Error('Database URL file must be absolute');
    const fd = openSync(file, 'r');
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile() || stats.size > 4096) throw new Error('Invalid database URL file');
      value = readFileSync(fd, 'utf8').trim();
    } finally {
      closeSync(fd);
    }
  }
  if (value.length > 4096 || !/^postgres(?:ql)?:\/\//.test(value)) throw new Error('Invalid database URL configuration');
  return value;
}

export async function transaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const playerColumns = 'p.id, p.nickname, p.nickname_conflict, p.revision, p.progress';
const validSession = 's.revoked_at IS NULL AND s.expires_at > clock_timestamp()';

function digest(token) {
  return createHash('sha256').update(token).digest();
}

function view(row) {
  if (!row) return { user: null, state: null };
  return {
    user: { id: row.id, nickname: row.nickname, ...(row.nickname_conflict ? { nicknameConflict: true } : {}) },
    state: { revision: Number(row.revision), progress: row.progress },
  };
}

export function isNicknameTaken(error) {
  return error?.code === '23505' && error.constraint === 'players_active_nickname_idx';
}

export async function sessionPlayer(client, token, lock = false, allowNicknameConflict = false) {
  if (!token) return undefined;
  const { rows } = await client.query(
    `SELECT s.player_id FROM paperplane_campus.sessions AS s
     JOIN paperplane_campus.players AS p ON p.id = s.player_id
     WHERE s.token_sha256 = $1 AND ${validSession}
       AND ($2::boolean OR NOT p.nickname_conflict)${lock ? ' FOR UPDATE OF s' : ''}`,
    [digest(token), allowNicknameConflict],
  );
  return rows[0]?.player_id;
}

async function readAlbum(client, playerID) {
  const { rows } = await client.query(
    `SELECT a.revision,
      COALESCE(
        jsonb_agg(jsonb_build_object('id', p.id, 'version', p.version, 'metadata', p.metadata)
                  ORDER BY (p.metadata ->> 'taken')::bigint DESC, p.id)
          FILTER (WHERE p.id IS NOT NULL), '[]'::jsonb
      ) AS photos
     FROM paperplane_campus.albums AS a
     LEFT JOIN paperplane_campus.photos AS p ON p.player_id = a.player_id
     WHERE a.player_id = $1 GROUP BY a.revision`,
    [playerID],
  );
  return rows[0] ? { revision: Number(rows[0].revision), photos: rows[0].photos } : { revision: 0, photos: [] };
}

async function canStorePhoto(client, playerID, photoID, size) {
  // Protect the shared byte budget across concurrent writes from separate accounts.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('paperplane_campus.photo_quota'))");
  const { rows: [usage] } = await client.query(
    `SELECT COUNT(*)::integer AS total_count, COALESCE(SUM(octet_length(png)), 0)::integer AS total_bytes,
            COUNT(*) FILTER (WHERE player_id = $1)::integer AS album_count,
            COALESCE(SUM(octet_length(png)) FILTER (WHERE player_id = $1), 0)::integer AS album_bytes
     FROM paperplane_campus.photos WHERE (player_id, id) <> ($1, $2)`,
    [playerID, photoID],
  );
  return usage.album_count < maxAlbumPhotos && usage.album_bytes + size <= maxAlbumBytes &&
    usage.total_count < maxStoredPhotos && usage.total_bytes + size <= maxStoredPhotoBytes;
}

export function createStore(pool) {
  return {
    async ready() {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::integer AS applied FROM paperplane_campus.migrations
         WHERE name IN ('001_accounts.sql', '002_album.sql', '004_unique_nicknames.sql')
           AND has_table_privilege('paperplane_campus.players', 'SELECT')
           AND has_table_privilege('paperplane_campus.players', 'INSERT')
           AND has_table_privilege('paperplane_campus.players', 'UPDATE')
           AND has_table_privilege('paperplane_campus.sessions', 'SELECT')
           AND has_table_privilege('paperplane_campus.sessions', 'INSERT')
           AND has_table_privilege('paperplane_campus.sessions', 'UPDATE')
           AND has_table_privilege('paperplane_campus.albums', 'SELECT')
           AND has_table_privilege('paperplane_campus.albums', 'INSERT')
           AND has_table_privilege('paperplane_campus.albums', 'UPDATE')
           AND has_table_privilege('paperplane_campus.photos', 'SELECT')
           AND has_table_privilege('paperplane_campus.photos', 'INSERT')
           AND has_table_privilege('paperplane_campus.photos', 'UPDATE')
           AND has_table_privilege('paperplane_campus.photos', 'DELETE')`,
      );
      return rows[0].applied === 3;
    },

    async session(token) {
      if (!token) return view();
      const { rows } = await pool.query(
        `SELECT ${playerColumns} FROM paperplane_campus.sessions AS s
         JOIN paperplane_campus.players AS p ON p.id = s.player_id
         WHERE s.token_sha256 = $1 AND ${validSession}`,
        [digest(token)],
      );
      return view(rows[0]);
    },

    async player(token) {
      return sessionPlayer(pool, token);
    },

    async presenceUser(token) {
      if (!token) return undefined;
      const { rows } = await pool.query(
        `SELECT p.id, p.nickname FROM paperplane_campus.sessions AS s
         JOIN paperplane_campus.players AS p ON p.id = s.player_id
         WHERE s.token_sha256 = $1 AND ${validSession} AND NOT p.nickname_conflict`,
        [digest(token)],
      );
      return rows[0];
    },

    async createSession(nickname, progress = {}) {
      const token = randomBytes(32).toString('base64url');
      return transaction(pool, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO paperplane_campus.players AS p (id, nickname, progress) VALUES ($1, $2, $3::jsonb)
           RETURNING ${playerColumns}`,
          [randomUUID(), nickname, JSON.stringify(progress)],
        );
        await client.query(
          `INSERT INTO paperplane_campus.sessions (token_sha256, player_id, expires_at)
           VALUES ($1, $2, clock_timestamp() + make_interval(secs => $3))`,
          [digest(token), rows[0].id, sessionLifetimeSeconds],
        );
        return { token, profile: view(rows[0]) };
      });
    },

    async writeState(token, expectedID, { revision, progress, nickname }, checkRenameLimit) {
      if (!token) return { status: 401, profile: view() };
      return transaction(pool, async (client) => {
        const id = await sessionPlayer(client, token, true, true);
        if (!id) return { status: 401, profile: view() };
        if (id !== expectedID) return { status: 403, profile: { error: 'account_mismatch' } };

        let nicknameChanged = false;
        if (nickname !== undefined) {
          // Compare against the latest stored name, even with concurrent sessions for this player.
          const { rows: [current] } = await client.query(
            'SELECT nickname, nickname_conflict FROM paperplane_campus.players WHERE id = $1 FOR UPDATE',
            [id],
          );
          nicknameChanged = current.nickname_conflict || current.nickname !== nickname;
          if (nicknameChanged) {
            const retryAfter = checkRenameLimit?.(id);
            if (retryAfter) return { status: 429, retryAfter };
          }
        }

        const { rows: changed } = await client.query(
          `UPDATE paperplane_campus.players AS p
           SET revision = revision + 1,
               progress = CASE WHEN p.nickname_conflict THEN p.progress ELSE $3::jsonb END,
               nickname = COALESCE($4, nickname),
               nickname_conflict = CASE WHEN $4::text IS NULL THEN p.nickname_conflict ELSE false END,
               updated_at = clock_timestamp()
           WHERE p.id = $1 AND p.revision = $2 AND p.revision < 9007199254740991
             AND (NOT p.nickname_conflict OR $4::text IS NOT NULL)
           RETURNING ${playerColumns}`,
          [id, revision, JSON.stringify(progress), nickname ?? null],
        );
        if (changed[0]) return { status: 200, profile: view(changed[0]), nicknameChanged };

        const { rows: current } = await client.query(
          `SELECT ${playerColumns} FROM paperplane_campus.players AS p WHERE p.id = $1`,
          [id],
        );
        if (current[0]?.nickname_conflict && nickname === undefined) {
          return { status: 409, profile: { error: 'nickname_required' } };
        }
        return { status: 409, profile: view(current[0]) };
      });
    },

    async revoke(token, expectedID) {
      if (!token) return true;
      const { rows } = await pool.query(
        `UPDATE paperplane_campus.sessions AS s SET revoked_at = clock_timestamp()
         WHERE s.token_sha256 = $1 AND ${validSession}
           AND ($2::uuid IS NULL OR s.player_id = $2::uuid)
         RETURNING player_id`,
        [digest(token), expectedID ?? null],
      );
      if (rows[0] || !expectedID) return true;
      return !(await sessionPlayer(pool, token, false, true));
    },

    async album(playerID) {
      return readAlbum(pool, playerID);
    },

    async photo(playerID, photoID) {
      const { rows } = await pool.query(
        'SELECT png FROM paperplane_campus.photos WHERE player_id = $1 AND id = $2',
        [playerID, photoID],
      );
      return rows[0]?.png;
    },

    async writeAlbum(token, expectedID, revision, photoID, photo) {
      if (!token) return { status: 401, body: { error: 'not_authenticated' } };
      return transaction(pool, async (client) => {
        const playerID = await sessionPlayer(client, token, true);
        if (!playerID) return { status: 401, body: { error: 'not_authenticated' } };
        if (playerID !== expectedID) return { status: 403, body: { error: 'account_mismatch' } };

        await client.query(
          'INSERT INTO paperplane_campus.albums (player_id) VALUES ($1) ON CONFLICT (player_id) DO NOTHING',
          [playerID],
        );
        const { rows: [album] } = await client.query(
          'SELECT revision FROM paperplane_campus.albums WHERE player_id = $1 FOR UPDATE',
          [playerID],
        );
        if (Number(album.revision) !== revision || revision === Number.MAX_SAFE_INTEGER) {
          return { status: 409, body: await readAlbum(client, playerID) };
        }

        if (photo) {
          if (!(await canStorePhoto(client, playerID, photoID, photo.png.length))) {
            return { status: 422, body: { error: 'album_capacity' } };
          }
          await client.query(
            `INSERT INTO paperplane_campus.photos (player_id, id, version, metadata, png)
             VALUES ($1, $2, $3, $4::jsonb, $5)
             ON CONFLICT (player_id, id) DO UPDATE
             SET version = EXCLUDED.version, metadata = EXCLUDED.metadata, png = EXCLUDED.png`,
            [playerID, photoID, revision + 1, JSON.stringify(photo.metadata), photo.png],
          );
        } else {
          const { rowCount } = await client.query(
            'DELETE FROM paperplane_campus.photos WHERE player_id = $1 AND id = $2',
            [playerID, photoID],
          );
          if (!rowCount) return { status: 200, body: await readAlbum(client, playerID) };
        }
        await client.query(
          'UPDATE paperplane_campus.albums SET revision = revision + 1 WHERE player_id = $1',
          [playerID],
        );
        return { status: 200, body: await readAlbum(client, playerID) };
      });
    },
  };
}
