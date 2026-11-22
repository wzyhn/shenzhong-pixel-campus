import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';
import { createAdminServer, readAdminCredentials } from './admin.mjs';
import { createAdminStore } from './admin-store.mjs';
import { maxPhotoBytes, validPhotoMetadata, validPng } from './album.mjs';
import { createCampusChat, parseChatText } from './chat.mjs';
import { answerCampusClue, campusClues, findCampusClue } from './clues.mjs';
import { readNameEggs } from './name-eggs.mjs';
import { createNicknameLimits, nicknameSource } from './nickname-limits.mjs';
import { createPresenceRoom, roomPacket } from './presence.mjs';
import { exactObject, parseNickname, validProgress } from './progress.mjs';
import { createPool, createStore, isNicknameTaken, readDatabaseURL, sessionLifetimeSeconds } from './store.mjs';

const defaultOrigin = 'https://campus.example.invalid';
const cookieName = '__Host-paperplane-campus';
const cookieAttributes = '; Path=/; Secure; HttpOnly; SameSite=Strict';
const guest = { user: null, state: null };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const photoPath = /^\/api\/campus\/album\/([^/]+)$/;
const chatPath = '/api/campus/chat';
const cluePath = /^\/api\/campus\/clues\/([a-z0-9][a-z0-9-]{0,39})(\/answer)?$/;
function validConfiguredOrigin(value) {
  try {
    const url = new URL(value);
    return value === url.origin && (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch {
    return false;
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true });

class RequestError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

function sessionToken(request) {
  const matches = (request.headers.cookie ?? '').split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(cookieName + '='));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(cookieName.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) && Buffer.from(token, 'base64url').toString('base64url') === token
    ? token
    : null;
}

function legacyView(profile) {
  return {
    user: profile.user && !profile.user.nicknameConflict
      ? { id: profile.user.id, displayName: profile.user.nickname }
      : null,
    mode: 'demo',
  };
}

function scope(request, required = true) {
  const value = request.headers['x-campus-user-id'];
  if (!required && value === undefined) return undefined;
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new RequestError(403, 'account_mismatch');
  return value;
}

async function albumPlayer(store, token, request) {
  const expectedID = scope(request);
  const currentID = await store.player(token);
  if (!currentID) throw new RequestError(401, 'not_authenticated');
  if (currentID !== expectedID) throw new RequestError(403, 'account_mismatch');
  return currentID;
}

async function requestBody(request, contentType, maxBytes) {
  if (request.headers['content-type']?.toLowerCase() !== contentType ||
      request.headers['content-encoding'] !== undefined) {
    throw new RequestError(415, 'unsupported_content_type');
  }
  if (Number(request.headers['content-length']) > maxBytes) throw new RequestError(413, 'body_too_large');
  const buffers = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) throw new RequestError(413, 'body_too_large');
    buffers.push(chunk);
  }
  return Buffer.concat(buffers, size);
}

async function readJSON(request, maxBytes = 65_536) {
  const body = await requestBody(request, 'application/json', maxBytes);
  try {
    return JSON.parse(decoder.decode(body));
  } catch {
    throw new RequestError(400, 'invalid_json');
  }
}

function albumRevision(request) {
  const match = /^"(0|[1-9]\d{0,15})"$/.exec(request.headers['if-match'] ?? '');
  const revision = match && Number(match[1]);
  if (!Number.isSafeInteger(revision)) throw new RequestError(400, 'invalid_revision');
  return revision;
}

async function readPhoto(request) {
  let metadata;
  try {
    const value = request.headers['x-campus-photo-metadata'];
    if (typeof value !== 'string' || value.length > 4096) badData();
    metadata = JSON.parse(decodeURIComponent(value));
  } catch {
    badData();
  }
  if (!validPhotoMetadata(metadata)) badData();
  const png = await requestBody(request, 'image/png', maxPhotoBytes);
  if (!validPng(png)) throw new RequestError(422, 'invalid_png');
  return { metadata, png };
}

function json(response, status, data, headers) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  response.end(JSON.stringify(data));
}

function badData() {
  throw new RequestError(400, 'invalid_data');
}

function nicknameRateLimited(response, retryAfter) {
  return json(response, 429, { error: 'nickname_rate_limited' }, { 'Retry-After': String(retryAfter) });
}

export function createCampusServer({
  store, origin = defaultOrigin, presence = createPresenceRoom(), chat = null,
  nameEggs = new Map(), admin = null, trustProxy = false, onError = () => {}, revision = 'local',
}) {
  if (revision !== 'local' && !/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid campus API build revision');
  const limits = createNicknameLimits();
  const nameEggFor = nickname => admin ? admin.egg(nickname) : nameEggs.get(nickname);
  function sessionView(profile) {
    const user = profile.user;
    const nameEgg = user && !user.nicknameConflict && nameEggFor(user.nickname);
    return nameEgg ? { ...profile, nameEgg } : profile;
  }

  return createServer({ requestTimeout: 20_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (request, response) => {
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Referrer-Policy', 'no-referrer');

    let endWrite;
    try {
      const route = request.method + ' ' + request.url;
      const at = presence.now();
      if (route === 'GET /healthz') {
        const ready = await store.ready().then((ready) => ready && (!chat || chat.ready())).catch(() => false);
        return json(response, ready ? 200 : 503, { ready });
      }
      const isRead = request.method === 'GET';
      const originHeader = request.headers.origin;
      const site = request.headers['sec-fetch-site'];
      if (((!isRead || originHeader !== undefined) && originHeader !== origin) ||
          (site !== undefined && site !== 'same-origin' && !(isRead && site === 'none'))) {
        throw new RequestError(403, 'forbidden_origin');
      }

      if (route === 'GET /api/campus/clues') return json(response, 200, { clues: campusClues });
      const clueMatch = cluePath.exec(request.url);
      if (clueMatch) {
        const [, id, answerPath] = clueMatch;
        if (isRead && !answerPath) {
          const clue = findCampusClue(id);
          if (!clue) throw new RequestError(404, 'not_found');
          return json(response, 200, { clue });
        }
        if (request.method === 'POST' && answerPath) {
          const body = await readJSON(request, 256);
          if (!exactObject(body, ['choice']) || !['a', 'b', 'c'].includes(body.choice)) badData();
          const result = answerCampusClue(id, body.choice);
          if (!result) throw new RequestError(404, 'not_found');
          return json(response, 200, result);
        }
      }

      const token = sessionToken(request);
      if (admin && (request.url.startsWith('/api/campus/') || route === 'GET /api/auth/session') &&
          !request.url.startsWith('/api/campus/clues')) {
        const writesCampus = !isRead;
        if (writesCampus) {
          endWrite = admin.beginWrite();
          if (!endWrite) throw new RequestError(503, 'campus_maintenance');
        }
        const admission = await admin.access(token);
        if (admission.banned) throw new RequestError(403, 'player_banned');
        if (admission.maintenance && writesCampus && route !== 'DELETE /api/campus/presence')
          throw new RequestError(503, 'campus_maintenance');
      }
      if ((request.url === chatPath && (isRead || request.method === 'POST')) ||
          (request.method === 'DELETE' && request.url.startsWith(chatPath + '/'))) {
        if (!chat) throw new RequestError(503, 'chat_unavailable');
        const expectedID = scope(request);
        let result;
        if (isRead) {
          result = await chat.history(token, expectedID);
        } else if (request.method === 'DELETE') {
          const id = request.url.slice(chatPath.length + 1);
          if (!uuidPattern.test(id)) throw new RequestError(404, 'not_found');
          result = await chat.revoke(token, expectedID, id);
        } else {
          const body = await readJSON(request, 2048);
          if (!exactObject(body, ['requestId', 'text']) || typeof body.requestId !== 'string' || !uuidPattern.test(body.requestId)) badData();
          const message = parseChatText(body.text);
          if (!message) badData();
          result = await chat.submit(token, expectedID, body.requestId, message);
        }
        return json(response, result.status, result.body, result.status === 429 ? { 'Retry-After': '3' } : undefined);
      }

      if (route === 'POST /api/campus/presence' || route === 'DELETE /api/campus/presence') {
        const expectedID = scope(request);
        const leaving = request.method === 'DELETE';
        const packet = roomPacket(await readJSON(request, 2048), leaving);
        if (!packet) badData();
        const user = await store.presenceUser(token);
        if (!user) throw new RequestError(401, 'not_authenticated');
        if (user.id !== expectedID) throw new RequestError(403, 'account_mismatch');
        if (leaving) return json(response, 200, presence.leave(user, packet.tabId, at));
        const nameStar = nameEggFor(user.nickname)?.fx.star === true;
        const result = presence.update({ ...user, nameStar }, packet, at);
        return result.status === 429
          ? json(response, 429, { error: 'try_again' }, { 'Retry-After': '1' })
          : json(response, 200, result.body);
      }

      if (route === 'GET /api/campus/session') {
        return json(response, 200, sessionView(await store.session(token)), { 'X-Campus-Revision': revision });
      }
      if (route === 'GET /api/auth/session') {
        return json(response, 200, legacyView(await store.session(token)));
      }

      if (route === 'POST /api/campus/session') {
        const body = await readJSON(request);
        const nickname = exactObject(body, ['nickname'], ['outfit']) && parseNickname(body.nickname);
        if (!nickname || (Object.hasOwn(body, 'outfit') && !validProgress({ outfit: body.outfit }))) badData();
        const existing = await store.session(token);
        if (existing.user) return json(response, 200, sessionView(existing));
        const retryAfter = limits.signup(nicknameSource(request, trustProxy));
        if (retryAfter) return nicknameRateLimited(response, retryAfter);
        const created = await store.createSession(nickname, body.outfit === undefined ? {} : { outfit: body.outfit });
        return json(response, 200, sessionView(created.profile), {
          'Set-Cookie': cookieName + '=' + created.token + cookieAttributes + '; Max-Age=' + sessionLifetimeSeconds,
        });
      }

      if (route === 'PUT /api/campus/state') {
        const expectedID = scope(request);
        const body = await readJSON(request);
        if (!exactObject(body, ['revision', 'progress'], ['nickname']) ||
            !Number.isSafeInteger(body.revision) || body.revision < 0 || !validProgress(body.progress)) {
          badData();
        }
        const nickname = Object.hasOwn(body, 'nickname') ? parseNickname(body.nickname) : undefined;
        if (nickname === null) badData();
        const result = await store.writeState(token, expectedID, {
          revision: body.revision, progress: body.progress, nickname,
        }, (id) => limits.rename(id, nicknameSource(request, trustProxy)));
        if (result.retryAfter) return nicknameRateLimited(response, result.retryAfter);
        if (result.nicknameChanged) presence.revoke(result.profile.user.id);
        return json(response, result.status, result.nicknameChanged ? sessionView(result.profile) : result.profile);
      }

      if (route === 'POST /api/auth/logout') {
        const expectedID = scope(request, false);
        const body = await readJSON(request);
        if (!exactObject(body, [])) badData();
        const playerID = await store.player(token);
        if (!(await store.revoke(token, expectedID))) throw new RequestError(403, 'account_mismatch');
        if (playerID) presence.revoke(playerID);
        return json(response, 200, legacyView(guest), {
          'Set-Cookie': cookieName + '=' + cookieAttributes + '; Max-Age=0',
        });
      }

      const photoMatch = photoPath.exec(request.url);
      const photoID = photoMatch?.[1];
      if (photoID && !uuidPattern.test(photoID)) return json(response, 404, { error: 'not_found' });
      if (route === 'GET /api/campus/album' || (isRead && photoID)) {
        const playerID = await albumPlayer(store, token, request);
        if (!photoID) return json(response, 200, await store.album(playerID));
        const png = await store.photo(playerID, photoID);
        if (!png) return json(response, 404, { error: 'not_found' });
        response.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': png.length,
          'Content-Security-Policy': "default-src 'none'; sandbox",
        });
        return response.end(png);
      }
      if (photoID && (request.method === 'PUT' || request.method === 'DELETE')) {
        const expectedID = await albumPlayer(store, token, request);
        const revision = albumRevision(request);
        const photo = request.method === 'PUT' ? await readPhoto(request) : null;
        const result = await store.writeAlbum(token, expectedID, revision, photoID, photo);
        return json(response, result.status, result.body);
      }

      return json(response, 404, { error: 'not_found' });
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      request.resume();
      if (error instanceof RequestError) return json(response, error.status, { error: error.message });
      if (isNicknameTaken(error)) return json(response, 409, { error: 'nickname_taken' });
      onError(error);
      return json(response, 503, { error: 'unavailable' });
    } finally {
      endWrite?.();
    }
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.PORT ?? '8080');
  const origin = process.env.PAPERPLANE_CAMPUS_ORIGIN ?? defaultOrigin;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !validConfiguredOrigin(origin)) {
    throw new Error('Invalid campus HTTP configuration');
  }
  const pool = createPool(readDatabaseURL('PAPERPLANE_CAMPUS_DATABASE_URL'));
  const logError = (error) => console.error('Campus service error', error.code ?? error.name);
  pool.on('error', logError);
  const store = createStore(pool);
  let privateServer, adminPool;
  try {
    const catalogPath = process.env.PAPERPLANE_CAMPUS_NAME_EGGS_FILE;
    const nameEggs = catalogPath === undefined ? new Map() : readNameEggs(catalogPath);
    const credentialsPath = process.env.PAPERPLANE_CAMPUS_ADMIN_CREDENTIALS_FILE;
    const trustProxy = process.env.PAPERPLANE_CAMPUS_TRUST_PROXY === '1';
    if (!(await store.ready())) throw new Error('Campus database migrations are required');
    const presence = createPresenceRoom();
    const { rowCount } = await pool.query("SELECT 1 FROM paperplane_campus.migrations WHERE name = '005_private_admin.sql'");
    if (credentialsPath && rowCount === 1) {
      try {
        adminPool = createPool(readDatabaseURL('PAPERPLANE_CAMPUS_ADMIN_DATABASE_URL'));
        adminPool.on('error', logError);
      } catch (error) { logError(error); }
    }
    const admin = rowCount === 1 ? await createAdminStore({ policyPool: pool, pool: adminPool, presence,
      originalEggs: nameEggs, onError: logError }) : null;
    const chat = createCampusChat(pool, { adminEnabled: Boolean(admin) });
    if (!(await chat.ready())) throw new Error('Campus chat migration and grants are required');
    const revision = process.env.PAPERPLANE_CAMPUS_BUILD_SHA ?? 'local';
    const server = createCampusServer({ store, chat, origin, presence, nameEggs, admin, trustProxy, onError: logError, revision });
    server.listen(port, '0.0.0.0', () => console.log('Campus service listening on port ' + port));
    if (credentialsPath) {
      try {
        if (!admin) throw new Error('Campus admin migration is required');
        await admin.verifyWriter();
        const credentials = () => readAdminCredentials(credentialsPath);
        const environment = process.env.PAPERPLANE_CAMPUS_ADMIN_ENVIRONMENT ?? 'local';
        const binding = process.env.PAPERPLANE_CAMPUS_ADMIN_BIND ?? '127.0.0.1';
        if (!['production', 'staging', 'local'].includes(environment) || !['127.0.0.1', '0.0.0.0'].includes(binding))
          throw new Error('Invalid campus administration configuration');
        privateServer = createAdminServer({ store: admin, credentials, environment, revision, onError: logError });
        privateServer.listen(8443, binding);
        await once(privateServer, 'listening');
      } catch (error) {
        logError(error);
        privateServer?.close();
        privateServer = undefined;
      }
    }
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, async () => {
        await Promise.all([server, privateServer].filter(Boolean).map(listener => new Promise(resolve => listener.close(resolve))));
        await Promise.all([pool.end(), adminPool?.end()]);
      });
    }
  } catch (error) {
    logError(error);
    privateServer?.close();
    process.exitCode = 1;
    await Promise.all([pool.end(), adminPool?.end()]);
  }
}
