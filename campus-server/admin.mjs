import { createHash, timingSafeEqual } from 'node:crypto';
import { open } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isAbsolute } from 'node:path';
import { AdminError } from './admin-store.mjs';
import { exactObject, validText } from './progress.mjs';

const prefix = '/admin/v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const actorId = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const hash = /^[a-f0-9]{64}$/;
const token = /^Bearer ([A-Za-z0-9_-]{43})$/;
const timestamp = /^(?:20\d\d)-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
const maxBody = 384 * 1024;

function invalid(code = 'invalid_request') {
  throw new AdminError(400, code);
}

function date(value) {
  return typeof value === 'string' && timestamp.test(value) && Number.isFinite(Date.parse(value));
}

function reason(value) {
  if (typeof value !== 'string' || !validText(value, 1, 200) || !value.trim()) invalid();
  return value.trim();
}

function resourceID(value) {
  if (typeof value !== 'string' || !uuid.test(value)) invalid();
  return value;
}

function version(value) {
  const match = /^"(0|[1-9]\d{0,9})"$/.exec(value ?? '');
  if (!match || Number(match[1]) >= 2147483647) throw new AdminError(428, 'revision_required');
  return Number(match[1]);
}

function json(response, status, result) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  });
  response.end(JSON.stringify(result));
}

async function body(request, required, optional = []) {
  if (request.headers['content-type'] !== 'application/json' || request.headers['content-encoding'] !== undefined)
    throw new AdminError(415, 'unsupported_content_type');
  if (Number(request.headers['content-length']) > maxBody) throw new AdminError(413, 'body_too_large');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBody) throw new AdminError(413, 'body_too_large');
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(decoder.decode(Buffer.concat(chunks, bytes))); } catch { invalid(); }
  if (!exactObject(parsed, required, optional)) invalid();
  return parsed;
}

export async function readAdminCredentials(path) {
  try {
    if (!isAbsolute(path)) throw new Error();
    const fd = await open(path, 'r');
    try {
      const stats = await fd.stat();
      if (!stats.isFile() || stats.size > 32_768) throw new Error();
      const rows = JSON.parse(decoder.decode(await fd.readFile()));
      if (!Array.isArray(rows) || rows.length > 80) throw new Error();
      const seen = new Set();
      for (const row of rows) {
        if (!exactObject(row, ['actor', 'digest', 'expiresAt']) || typeof row.actor !== 'string' ||
            !actorId.test(row.actor) || typeof row.digest !== 'string' || !hash.test(row.digest) ||
            seen.has(row.digest) || !date(row.expiresAt)) throw new Error();
        seen.add(row.digest);
      }
      return rows;
    } finally {
      await fd.close();
    }
  } catch {
    throw Object.assign(new Error('Invalid private campus credential file'), { code: 'CAMPUS_ADMIN_CREDENTIALS' });
  }
}

async function authenticate(request, credentials) {
  const auth = request.headersDistinct.authorization;
  const value = auth?.length === 1 && token.exec(auth[0])?.[1];
  if (!value || Buffer.from(value, 'base64url').toString('base64url') !== value) return undefined;
  const digest = createHash('sha256').update(value).digest();
  const now = Date.now();
  let actor;
  for (const row of await credentials()) {
    if (timingSafeEqual(digest, Buffer.from(row.digest, 'hex')) && Date.parse(row.expiresAt) > now) actor = row.actor;
  }
  return actor;
}

function query(url, allowed = []) {
  const fields = {};
  for (const [name, value] of url.searchParams) {
    if (!allowed.includes(name) || Object.hasOwn(fields, name)) invalid('invalid_query');
    fields[name] = value;
  }
  if (fields.cursor !== undefined) resourceID(fields.cursor);
  return fields;
}

export function createAdminServer({ store, credentials, revision, environment, onError = () => {} }) {
  return createServer({ requestTimeout: 20_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (request, response) => {
    try {
      if (!request.url?.startsWith(prefix + '/') || request.headers.origin || request.headers['sec-fetch-site'])
        throw new AdminError(404, 'not_found');
      const actor = await authenticate(request, credentials);
      if (!actor) throw new AdminError(401, 'admin_auth_required');

      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname.slice(prefix.length);
      const [collection, id, part, extra] = path.slice(1).split('/');
      const method = request.method;
      let result;
      if (method === 'GET') {
        if (path === '/session') { query(url); result = { actor, environment }; }
        else if (path === '/status') { query(url); result = { ...(await store.status()), environment, revisionSHA: revision }; }
        else if (path === '/players') {
          const { cursor, q = '' } = query(url, ['cursor', 'q']);
          if (!validText(q, 0, 24)) invalid();
          result = await store.players(cursor, q);
        } else if (collection === 'players' && id && !part) { query(url); result = await store.player(resourceID(id)); }
        else if (path === '/bans') {
          const { cursor, active = '1' } = query(url, ['cursor', 'active']);
          if (!['0', '1'].includes(active)) invalid();
          result = await store.bans(cursor, active === '1');
        } else if (path === '/chat') result = await store.chat(query(url, ['cursor']).cursor);
        else if (path === '/name-eggs/active') { query(url); result = await store.activeCatalog(); }
        else if (path === '/name-eggs/versions') result = await store.catalogs(query(url, ['cursor']).cursor);
        else if (collection === 'name-eggs' && id === 'versions' && part && !extra) {
          query(url); result = await store.catalog(resourceID(part));
        } else if (path === '/audit') result = await store.audit(query(url, ['cursor']).cursor);
        else if (path === '/operations') result = await store.findOperation(actor, resourceID(query(url, ['key']).key));
        else if (collection === 'operations' && id && !part) { query(url); result = await store.operation(resourceID(id)); }
        else throw new AdminError(404, 'not_found');
        return json(response, 200, result);
      }

      if (method !== 'POST' && method !== 'PUT') throw new AdminError(404, 'not_found');
      if (request.headers['x-campus-admin-environment'] !== environment)
        throw new AdminError(409, 'admin_environment_mismatch');
      query(url);
      const key = resourceID(request.headers['idempotency-key']);
      const expected = () => version(request.headers['if-match']);
      if (method === 'POST' && path === '/bans') {
        const input = await body(request, ['playerId', 'reason', 'until']);
        if (!date(input.until) || Date.parse(input.until) > Date.now() + 366 * 86_400_000) invalid('invalid_expiration');
        result = await store.ban(actor, key, { playerId: resourceID(input.playerId), reason: reason(input.reason), until: input.until });
      } else if (method === 'POST' && collection === 'bans' && part === 'lift' && !extra) {
        result = await store.lift(actor, key, resourceID(id), reason((await body(request, ['reason'])).reason));
      } else if (method === 'POST' && collection === 'chat' && part === 'hide' && !extra) {
        result = await store.hideChat(actor, key, resourceID(id), reason((await body(request, ['reason'])).reason));
      } else if (method === 'POST' && path === '/name-eggs/versions') {
        await body(request, []);
        result = await store.draft(actor, key);
      } else if (method === 'PUT' && collection === 'name-eggs' && id === 'versions' && extra === 'entries' &&
          path === `/name-eggs/versions/${part}/entries`) {
        result = await store.edit(actor, key, resourceID(part), expected(), (await body(request, ['entries'])).entries);
      } else if (method === 'POST' && collection === 'name-eggs' && id === 'versions' && extra === 'preview' &&
          path === `/name-eggs/versions/${part}/preview`) {
        await body(request, []);
        result = await store.review(actor, key, resourceID(part), expected());
      } else if (method === 'PUT' && path === '/name-eggs/active') {
        const { versionId, versionRevision } = await body(request, ['versionId', 'versionRevision']);
        if (versionId !== null) resourceID(versionId);
        if (versionId === null ? versionRevision !== null : !Number.isInteger(versionRevision) || versionRevision < 1) invalid();
        result = await store.publish(actor, key, versionId, expected(), versionRevision);
      } else if (method === 'PUT' && path === '/maintenance') {
        const { enabled, reason: why } = await body(request, ['enabled', 'reason']);
        if (typeof enabled !== 'boolean') invalid();
        result = await store.maintenance(actor, key, enabled, expected(), reason(why));
      } else if (method === 'POST' && path === '/operations/preview') {
        const { scope, reason: why } = await body(request, ['scope', 'reason']);
        if (!['online', 'sessions', 'progress', 'players'].includes(scope)) invalid();
        result = await store.preview(actor, key, scope, reason(why));
      } else if (method === 'POST' && collection === 'operations' && part === 'execute' && !extra) {
        await body(request, []);
        result = await store.execute(actor, key, resourceID(id), expected());
      } else throw new AdminError(404, 'not_found');
      return json(response, 200, result);
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      request.resume();
      if (error instanceof AdminError) return json(response, error.status, { error: error.message });
      onError(error);
      return json(response, 503, { error: 'admin_unavailable' });
    }
  });
}
