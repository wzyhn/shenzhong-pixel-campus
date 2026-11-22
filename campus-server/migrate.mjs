import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createPool, readDatabaseURL } from './store.mjs';

export async function migrate(pool, directory = new URL('./migrations/', import.meta.url)) {
  const names = (await readdir(directory)).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('paperplane_campus.migrations'))");
    await client.query('CREATE SCHEMA IF NOT EXISTS paperplane_campus');
    await client.query(`CREATE TABLE IF NOT EXISTS paperplane_campus.migrations (
      ordinal integer PRIMARY KEY,
      name text NOT NULL UNIQUE,
      sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    const { rows } = await client.query('SELECT ordinal, name, sha256 FROM paperplane_campus.migrations ORDER BY ordinal');
    if (rows.length > names.length) throw new Error('Database has newer campus migrations');
    for (const [index, name] of names.entries()) {
      const ordinal = index + 1;
      if (Number(name.slice(0, 3)) !== ordinal) throw new Error('Campus migrations must be consecutive');
      const sql = await readFile(new URL(name, directory), 'utf8');
      const sha256 = createHash('sha256').update(sql.replaceAll('\r\n', '\n')).digest();
      const applied = rows[index];
      if (applied) {
        if (applied.ordinal !== ordinal || applied.name !== name || !sha256.equals(applied.sha256)) {
          throw new Error('Applied campus migration differs from bundled migration');
        }
        continue;
      }
      await client.query(sql);
      await client.query(
        'INSERT INTO paperplane_campus.migrations (ordinal, name, sha256) VALUES ($1, $2, $3)',
        [ordinal, name, sha256],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const pool = createPool(readDatabaseURL('PAPERPLANE_CAMPUS_MIGRATION_DATABASE_URL'));
  try {
    await migrate(pool);
    console.log('Campus migrations applied');
  } catch (error) {
    console.error('Campus migration failed', error.code ?? error.name);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
