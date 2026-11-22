import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { validPng } from './album.mjs';
import { createCampusChat, parseChatText } from './chat.mjs';
import { migrate } from './migrate.mjs';
import { campusRoom, createPresenceRoom } from './presence.mjs';
import { parseNickname, validProgress } from './progress.mjs';
import { createCampusServer } from './server.mjs';
import { createPool, createStore } from './store.mjs';

const origin = 'https://campus.example.invalid';
const guest = { user: null, state: null };
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const journey = { v: 1, x: 26.5, y: 64.6, d: 'up', n: 0, r: 0, s: 1, mu: 0, sf: 1, z: 1.82, run: 0, t: 100 };
const profile = { age: '17', education: [{ stage: '高中', school: '深州市中学', schoolId: 'hebei-shenzhou', year: '2020', grade: '一', group: '二' }] };
const progress = {
  journey,
  outfit: { grade: '高二', hair: '短发', hairC: '黑', skin: '白', glass: true },
  toy: { plane: true, badge: true, worn: false, hints: false },
  presence: { findable: false },
  profile,
};

test('validates private state and nickname shape', () => {
  assert.equal(parseNickname(' 校园🚀 '), '校园🚀');
  assert.equal(parseNickname('含\u202e格式符'), null);
  assert.equal(parseNickname('超'.repeat(25)), null);
  assert.equal(validProgress(progress), true);
  assert.equal(validProgress({ ...progress, journey: { ...journey, z: 45 } }), false);
  assert.equal(validProgress({ ...progress, memoir: {} }), false);
  assert.equal(validProgress({ profile: { ...profile, realName: 'x' } }), false);
  assert.equal(validProgress({ profile: { age: '017' } }), false);
  assert.equal(validPng(tinyPng), true);
  assert.equal(validPng(Buffer.concat([tinyPng, Buffer.from('trailing')])), false);
  const invalidCRC = Buffer.from(tinyPng);
  invalidCRC[42] ^= 0x01;
  assert.equal(validPng(invalidCRC), false);
  assert.equal(parseChatText(' 校园😀 '), '校园😀');
  assert.equal(parseChatText('好'.repeat(41)), null);
  assert.equal(parseChatText('a\nb'), null);
  assert.equal(parseChatText('\u200d'), null);
});

const provisionDSN = process.env.WECONQ_TEST_POSTGRES_DSN;
const roomPosition = { x: 26.5, y: 64.6, dir: 'up', place: '西南门附近' };
const roomPacket = (tabId, fields = {}) => ({ room: campusRoom, tabId, findable: true, pos: roomPosition, emotes: [], ...fields });

test('an older heartbeat cannot reactivate a closed or revoked tab', () => {
  let time = 0;
  const room = createPresenceRoom(() => time);
  const first = { id: randomUUID(), nickname: '一' };
  const second = { id: randomUUID(), nickname: '二' };
  const firstTab = 'a'.repeat(24);
  const secondTab = 'b'.repeat(24);
  const firstPacket = roomPacket(firstTab);
  const secondPacket = roomPacket(secondTab);
  room.leave(first, firstTab, time += 200);
  room.update(first, firstPacket, 100);
  assert.deepEqual(room.update(second, secondPacket, time += 350).body.players, []);
  room.update(first, firstPacket, time += 350);
  assert.equal(room.update(second, secondPacket, time += 350).body.players.length, 1);
  room.revoke(first.id);
  room.update(first, roomPacket('c'.repeat(24)), time - 1);
  assert.deepEqual(room.update(second, secondPacket, time += 350).body.players, []);
});

test('PostgreSQL persists isolated accounts, CAS state, albums and revocation across server restart', {
  skip: !provisionDSN && 'Set WECONQ_TEST_POSTGRES_DSN to an isolated local PostgreSQL maintenance database',
}, async (context) => {
  const provisionURL = new URL(provisionDSN);
  assert.ok(['127.0.0.1', '[::1]', 'localhost'].includes(provisionURL.hostname));
  assert.equal(provisionURL.pathname, '/postgres');
  assert.equal(provisionURL.search, '');

  const suffix = randomBytes(8).toString('hex');
  const database = 'paperplane_campus_db_' + suffix;
  const role = 'paperplane_campus_app_' + suffix;
  const runtimePassword = randomBytes(24).toString('hex');
  const admin = createPool(provisionURL.href);
  const databaseURL = new URL(database, provisionURL.href);
  const runtimeURL = new URL(databaseURL.href);
  runtimeURL.username = role;
  runtimeURL.password = runtimePassword;
  let owner;
  let pool;
  let app;
  let root;

  async function stopApp() {
    if (app) {
      await new Promise((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
      app = undefined;
    }
    if (pool) {
      await pool.end();
      pool = undefined;
    }
  }

  context.after(async () => {
    await stopApp();
    if (owner) await owner.end();
    try {
      await admin.query('DROP DATABASE IF EXISTS ' + database);
      await admin.query('DROP ROLE IF EXISTS ' + role);
    } finally {
      await admin.end();
    }
  });

  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${runtimePassword}'`);
  await admin.query('CREATE DATABASE ' + database);
  owner = createPool(databaseURL.href);
  const priorMigrations = ['001_accounts.sql', '002_album.sql', '003_chat.sql'];
  const prior = await mkdtemp(path.join(tmpdir(), 'paperplane-campus-legacy-'));
  try {
    for (const name of priorMigrations) await cp(new URL('./migrations/' + name, import.meta.url), path.join(prior, name));
    await migrate(owner, pathToFileURL(prior + path.sep));
  } finally {
    for (const name of priorMigrations) await rm(path.join(prior, name), { force: true });
    await rmdir(prior);
  }
  const legacy = ['Ａｕｄｉｔ同学', 'audit同学'].map(nickname => {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    return { id, nickname, token, cookie: '__Host-paperplane-campus=' + token };
  });
  for (const [index, player] of legacy.entries()) {
    await owner.query(`INSERT INTO paperplane_campus.players (id,nickname,progress,revision,created_at)
      VALUES ($1,$2,$3,7,clock_timestamp() - make_interval(days => $4))`,
      [player.id, player.nickname, JSON.stringify(progress), 2 - index]);
    await owner.query(`INSERT INTO paperplane_campus.sessions (token_sha256,player_id,expires_at)
      VALUES ($1,$2,clock_timestamp()+interval '1 day')`,
      [createHash('sha256').update(player.token).digest(), player.id]);
  }
  await owner.query('INSERT INTO paperplane_campus.albums (player_id,revision) VALUES ($1,5)', [legacy[1].id]);
  const legacyMessageID = randomUUID();
  const legacyMessageBody = '改名后仍能看到的旧留言';
  await owner.query(`INSERT INTO paperplane_campus.chat_messages (id,player_id,request_id,nickname,text_sha256,body)
    VALUES ($1,$2,$3,$4,$5,$6)`, [legacyMessageID, legacy[1].id, randomUUID(), legacy[1].nickname,
    createHash('sha256').update(legacyMessageBody).digest(), legacyMessageBody]);
  await migrate(owner);
  await migrate(owner);
  const migrations = await owner.query('SELECT name FROM paperplane_campus.migrations ORDER BY ordinal');
  assert.deepEqual(migrations.rows.map((row) => row.name), [...priorMigrations, '004_unique_nicknames.sql']);
  await owner.query('GRANT USAGE ON SCHEMA paperplane_campus TO ' + role);
  await owner.query('GRANT SELECT ON paperplane_campus.migrations TO ' + role);
  await owner.query('GRANT SELECT, INSERT, UPDATE ON paperplane_campus.players, paperplane_campus.sessions, paperplane_campus.albums TO ' + role);
  await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON paperplane_campus.photos TO ' + role);
  await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON paperplane_campus.chat_messages TO ' + role);

  const errors = [];
  const buildRevision = '1'.repeat(40);
  let roomTime = 0;
  const starName = 'QA Star Fixture';
  const starEgg = { txt: 'Synthetic star message', fx: { star: true, toast: 'Synthetic toast' } };
  const weatherName = 'QA Snow Fixture';
  const weatherEgg = { txt: 'Synthetic weather message', fx: { wx: 'snow' } };
  const nameEggs = new Map([
    [starName, starEgg],
    [weatherName, weatherEgg],
    [legacy[1].nickname, { txt: 'Synthetic conflict message', fx: {} }],
  ]);
  async function startApp() {
    pool = createPool(runtimeURL.href);
    const store = createStore(pool);
    assert.equal(await store.ready(), true);
    const presence = createPresenceRoom(() => roomTime);
    const chat = createCampusChat(pool);
    assert.equal(await chat.ready(), true);
    app = createCampusServer({ store, presence, chat, nameEggs, revision: buildRevision,
      onError: (error) => errors.push(error) }).listen(0, '127.0.0.1');
    await once(app, 'listening');
    root = 'http://127.0.0.1:' + app.address().port;
  }

  await startApp();
  await assert.rejects(pool.query('CREATE TABLE paperplane_campus.forbidden (x int)'), { code: '42501' });
  await assert.rejects(pool.query('DELETE FROM paperplane_campus.players'), { code: '42501' });

  function request(path, { method = 'GET', cookie, id, json, body, headers = {} } = {}) {
    const options = { method, headers: { ...headers } };
    if (cookie) options.headers.cookie = cookie;
    if (id) options.headers['X-Campus-User-ID'] = id;
    if (method !== 'GET' && !('origin' in headers)) options.headers.origin = origin;
    if (json !== undefined) {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(json);
    } else if (body) {
      options.body = body;
    }
    return fetch(root + path, options);
  }

  async function expectJSON(responsePromise, status, body) {
    const response = await responsePromise;
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    if (body !== undefined) assert.deepEqual(result, body);
    return result;
  }

  const accountURL = '/api/campus/session';
  const stateURL = '/api/campus/state';
  const albumURL = '/api/campus/album';
  await expectJSON(request('/healthz'), 200, { ready: true });
  const anonymous = await request(accountURL);
  assert.equal(anonymous.headers.get('x-campus-revision'), buildRevision);
  await expectJSON(anonymous, 200, guest);
  await expectJSON(request('/api/auth/session'), 200, { user: null, mode: 'demo' });
  const [oldest, flagged] = legacy;
  const savedBeforeUpgrade = { revision: 7, progress };
  const rejected = await request(accountURL, { method: 'POST', json: { nickname: 'aUDIT同学' } });
  assert.equal(rejected.headers.get('set-cookie'), null);
  await expectJSON(rejected, 409, { error: 'nickname_taken' });
  await expectJSON(request(accountURL, oldest), 200, { user: { id: oldest.id, nickname: oldest.nickname }, state: savedBeforeUpgrade });
  await expectJSON(request(accountURL, flagged), 200, {
    user: { id: flagged.id, nickname: flagged.nickname, nicknameConflict: true }, state: savedBeforeUpgrade,
  });
  await expectJSON(request('/api/auth/session', flagged), 200, { user: null, mode: 'demo' });
  await expectJSON(request(albumURL, flagged), 401);
  await expectJSON(request('/api/campus/chat', flagged), 401);
  await expectJSON(request('/api/campus/chat', oldest), 200, { messages: [] });
  await expectJSON(request('/api/campus/presence', { method: 'POST', ...flagged, json: roomPacket('f'.repeat(24)) }), 401);
  const repair = (nickname, suppliedProgress = {}) => request(stateURL, {
    method: 'PUT', ...flagged, json: { revision: 7, progress: suppliedProgress, ...(nickname ? { nickname } : {}) },
  });
  await expectJSON(repair(), 409, { error: 'nickname_required' });
  await expectJSON(repair('ａｕｄｉｔ同学'), 409, { error: 'nickname_taken' });
  await expectJSON(repair('迁移后新人'), 200, {
    user: { id: flagged.id, nickname: '迁移后新人' }, state: { revision: 8, progress },
  });
  await expectJSON(request(albumURL, flagged), 200, { revision: 5, photos: [] });
  const restoredMessages = (await expectJSON(request('/api/campus/chat', oldest), 200)).messages;
  assert.equal(restoredMessages[0]?.id, legacyMessageID);
  assert.equal(restoredMessages[0]?.nickname, '迁移后新人');
  assert.equal(restoredMessages[0]?.text, legacyMessageBody);
  await owner.query('DELETE FROM paperplane_campus.chat_messages WHERE id = $1', [legacyMessageID]);
  const concurrent = await Promise.all(['Ｃａｍｐ同学', 'camp同学'].map(nickname =>
    request(accountURL, { method: 'POST', json: { nickname } })));
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
  const declined = concurrent.find(r => r.status === 409);
  assert.equal(declined.headers.get('set-cookie'), null);
  await expectJSON(declined, 409, { error: 'nickname_taken' });
  await expectJSON(request(accountURL, {
    method: 'POST', json: { nickname: '深州' }, headers: { origin: 'https://example.com' },
  }), 403);
  await expectJSON(request(accountURL, {
    method: 'POST', json: { nickname: '深州' }, headers: { 'sec-fetch-site': 'same-site' },
  }), 403);

  async function join(nickname) {
    const response = await request(accountURL, { method: 'POST', json: { nickname: ' ' + nickname + ' ' } });
    assert.equal(response.status, 200);
    const rawCookie = response.headers.get('set-cookie');
    assert.match(rawCookie, /^__Host-paperplane-campus=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=31536000$/);
    const payload = await response.json();
    assert.equal(payload.user.nickname, nickname);
    assert.deepEqual(payload.state, { revision: 0, progress: {} });
    return { cookie: rawCookie.split(';')[0], id: payload.user.id };
  }

  const first = await join('深州');
  const second = await join('另一位同学');
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.cookie, second.cookie);
  const resumed = await request(accountURL, {
    method: 'POST', cookie: first.cookie, json: { nickname: '另一个名字' },
  });
  assert.equal(resumed.headers.get('set-cookie'), null);
  assert.equal((await resumed.json()).user.id, first.id);
  await expectJSON(request('/api/auth/session', first), 200, {
    user: { id: first.id, displayName: '深州' }, mode: 'demo',
  });

  const firstRoomTab = 'a'.repeat(24);
  const firstExtraTab = 'c'.repeat(24);
  const secondRoomTab = 'b'.repeat(24);
  const eventId = 'd'.repeat(24);
  const heartbeat = (account, tabId, fields, headers) => {
    roomTime += 400;
    return request('/api/campus/presence', { method: 'POST', ...account, json: roomPacket(tabId, fields), headers });
  };
  const leave = (account, tabId) => {
    roomTime += 400;
    return request('/api/campus/presence', { method: 'DELETE', ...account, json: { room: campusRoom, tabId } });
  };
  await expectJSON(heartbeat({ id: first.id }, firstRoomTab), 401);
  await expectJSON(heartbeat({ ...first, id: second.id }, firstRoomTab), 403);
  await expectJSON(heartbeat(first, firstRoomTab, {}, { origin: 'https://example.com' }), 403);
  await expectJSON(heartbeat(first, firstRoomTab, { room: 'another-room' }), 400);
  await expectJSON(heartbeat(first, firstRoomTab, { nickname: 'forged' }), 400);
  await expectJSON(heartbeat(first, firstRoomTab, { text: 'free text' }), 400);
  await expectJSON(heartbeat(first, firstRoomTab, { emotes: [{ eventId, glyph: 'free text' }] }), 400);
  await expectJSON(heartbeat(first, firstRoomTab, { pos: { ...roomPosition, x: 70 } }), 400);
  await expectJSON(heartbeat(first, firstRoomTab), 200, { players: [], emotes: [] });
  let peers = await expectJSON(heartbeat(second, secondRoomTab), 200);
  assert.equal(peers.players.length, 1);
  const peer = peers.players[0];
  assert.equal(peer.nick, '深州');
  assert.equal(peer.findable, true);
  assert.deepEqual(peer.pos, roomPosition);
  assert.match(peer.personId, /^[0-9a-f]{24}$/);
  assert.match(peer.tabId, /^[0-9a-f]{24}$/);
  assert.notEqual(peer.personId, first.id);
  assert.notEqual(peer.tabId, firstRoomTab);
  assert.equal((await expectJSON(heartbeat(first, firstExtraTab), 200)).players.length, 1);
  await expectJSON(heartbeat(first, firstRoomTab, {
    pos: { ...roomPosition, place: 'free text' }, emotes: [{ eventId, glyph: '👋' }],
  }), 200);
  peers = await expectJSON(heartbeat(second, secondRoomTab), 200);
  assert.deepEqual(peers, {
    players: [{ ...peer, pos: { ...roomPosition, place: '校园里' } }],
    emotes: [{ personId: peer.personId, tabId: peer.tabId, eventId, glyph: '👋' }],
  });
  await expectJSON(heartbeat(first, firstRoomTab, { findable: false, pos: undefined }), 200);
  peers = await expectJSON(heartbeat(second, secondRoomTab), 200);
  assert.deepEqual(peers.players, [{ personId: peer.personId, tabId: peer.tabId, nick: '深州', findable: false }]);
  await expectJSON(leave(first, firstRoomTab), 200);
  peers = await expectJSON(heartbeat(second, secondRoomTab), 200);
  assert.deepEqual(peers.players, [peer]);
  await expectJSON(leave(first, firstExtraTab), 200);
  await expectJSON(heartbeat(second, secondRoomTab), 200, { players: [], emotes: [] });
  await expectJSON(heartbeat(first, firstRoomTab), 200);
  roomTime += 12_000;
  await expectJSON(heartbeat(second, secondRoomTab), 200, { players: [], emotes: [] });

  const save = (account, changes) => request(stateURL, { method: 'PUT', ...account, json: changes });
  await expectJSON(save({ ...first, id: second.id }, { revision: 0, progress }), 403);
  await expectJSON(save(first, { revision: 0, progress: { journey, publicMemoir: {} } }), 400);

  const saved = {
    user: { id: first.id, nickname: '第一位玩家' },
    state: { revision: 1, progress },
  };
  await expectJSON(save(first, { revision: 0, progress, nickname: saved.user.nickname }), 200, saved);
  await expectJSON(save(first, { revision: 0, progress: {} }), 409, saved);
  const races = await Promise.all([
    save(first, { revision: 1, progress }),
    save(first, { revision: 1, progress }),
  ]);
  assert.deepEqual(races.map((response) => response.status).sort(), [200, 409]);
  assert.deepEqual(await races[0].json(), await races[1].json());
  const committed = { ...saved, state: { revision: 2, progress } };
  await expectJSON(request(accountURL, first), 200, committed);
  assert.deepEqual((await expectJSON(request(accountURL, second), 200)).state, { revision: 0, progress: {} });

  const photoID = randomUUID();
  const photoURL = albumURL + '/' + photoID;
  const photoMetadata = { taken: 1660000000000, caption: '在校门口留影', placeId: 'gate', placeName: '校门口',
    nearby: false, schoolName: '河北深州市中学', shotPreset: { light: 'night', zoom: 1.82, facing: 'down' } };
  const putPhoto = (revision, png = tinyPng, metadata = photoMetadata, id = photoID) => request(albumURL + '/' + id, {
    method: 'PUT', ...first, body: png,
    headers: { 'content-type': 'image/png', 'if-match': '"' + revision + '"',
      'x-campus-photo-metadata': encodeURIComponent(JSON.stringify(metadata)) },
  });
  await expectJSON(request(albumURL, first), 200, { revision: 0, photos: [] });
  await expectJSON(putPhoto(0, Buffer.from('not an image')), 422, { error: 'invalid_png' });
  await expectJSON(putPhoto(0, Buffer.alloc(2 * 1024 * 1024 + 1)), 413, { error: 'body_too_large' });
  await expectJSON(putPhoto(0), 200, { revision: 1, photos: [{ id: photoID, version: 1, metadata: photoMetadata }] });
  await expectJSON(putPhoto(0), 409, { revision: 1, photos: [{ id: photoID, version: 1, metadata: photoMetadata }] });
  await expectJSON(request(photoURL, second), 404);
  await expectJSON(request(photoURL, { ...second, id: first.id }), 403);

  await stopApp();
  await startApp();
  await expectJSON(request(accountURL, first), 200, committed);
  const image = await request(photoURL, first);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), tinyPng);
  const updatedCaption = { ...photoMetadata, caption: '修改过的照片说明' };
  await expectJSON(putPhoto(1, tinyPng, updatedCaption), 200, {
    revision: 2, photos: [{ id: photoID, version: 2, metadata: updatedCaption }],
  });
  await expectJSON(request(photoURL, { method: 'DELETE', ...first, headers: { 'if-match': '"1"' } }), 409);
  await expectJSON(request(photoURL, { method: 'DELETE', ...first, headers: { 'if-match': '"2"' } }), 200, { revision: 3, photos: [] });
  await expectJSON(request(photoURL, first), 404);

  await expectJSON(request('/api/auth/logout', { method: 'POST', ...first, id: second.id, json: {} }), 403);
  const logout = await request('/api/auth/logout', { method: 'POST', ...first, json: {} });
  assert.match(logout.headers.get('set-cookie'), /; Max-Age=0$/);
  await expectJSON(Promise.resolve(logout), 200, { user: null, mode: 'demo' });
  await expectJSON(request(accountURL, first), 200, guest);
  await expectJSON(save(first, { revision: 2, progress }), 401, guest);
  await expectJSON(request(albumURL, first), 401);
  await expectJSON(request('/api/auth/session', second), 200, {
    user: { id: second.id, displayName: '另一位同学' }, mode: 'demo',
  });

  const outfit = { grade: '高一', hair: '短发', hairC: '黑', skin: '白', glass: true };
  await expectJSON(request(accountURL, { method: 'POST', json: { nickname: '新同学', outfit: { ...outfit, glass: 3 } } }), 400);
  const joinedWithOutfit = await request(accountURL, { method: 'POST', json: { nickname: '新同学', outfit } });
  const newlyJoined = await expectJSON(Promise.resolve(joinedWithOutfit), 200);
  const newcomer = { id: newlyJoined.user.id, cookie: joinedWithOutfit.headers.get('set-cookie').split(';')[0] };
  assert.deepEqual(newlyJoined.state, { revision: 0, progress: { outfit } });
  await expectJSON(request(accountURL, { method: 'POST', ...newcomer,
    json: { nickname: '另一个昵称', outfit: { ...outfit, glass: false } } }), 200, newlyJoined);

  const chatURL = '/api/campus/chat';
  const say = (account, requestId, text, headers) => request(chatURL, {
    method: 'POST', ...account, json: { requestId, text }, headers,
  });
  const deleteMessage = (account, id) => request(chatURL + '/' + id, { method: 'DELETE', ...account });
  await expectJSON(request(chatURL, { id: second.id }), 401);
  await expectJSON(say({ id: second.id }, randomUUID(), '缺少登录'), 401);
  await expectJSON(request(chatURL, { ...second, id: newcomer.id }), 403);
  await expectJSON(say(second, randomUUID(), '没授权', { origin: 'https://example.com' }), 403);
  await expectJSON(say(second, randomUUID(), '字'.repeat(41)), 400);
  await expectJSON(request(chatURL, newcomer), 200, { messages: [] });

  const requestID = randomUUID();
  const sent = await expectJSON(say(second, requestID, ' 校门口见 '), 200);
  assert.equal(sent.status, 'published');
  assert.deepEqual(sent.message, {
    id: sent.message.id, nickname: '另一位同学', text: '校门口见', created_at: sent.message.created_at, own: true,
  });
  assert.equal(new Date(sent.message.created_at).toISOString(), sent.message.created_at);
  await expectJSON(say(second, requestID, '校门口见'), 200, sent);
  await expectJSON(say(second, requestID, '旧编号换内容'), 409);
  const quick = await expectJSON(say(second, randomUUID(), '十分钟后'), 200);
  const next = await expectJSON(say(second, randomUUID(), '带书包'), 200);
  assert.equal(quick.status, 'published');
  assert.equal(next.status, 'published');
  await expectJSON(say(second, randomUUID(), '发太快'), 429);
  await expectJSON(deleteMessage(second, quick.message.id), 200, { revoked: true });
  await expectJSON(deleteMessage(second, next.message.id), 200, { revoked: true });
  await expectJSON(request(chatURL, newcomer), 200, { messages: [{ ...sent.message, own: false }] });
  await expectJSON(deleteMessage(newcomer, sent.message.id), 404);

  const newRequest = randomUUID();
  const simultaneous = await Promise.all([
    say(newcomer, newRequest, '我在操场'),
    say(newcomer, newRequest, '我在操场'),
  ]);
  const [fresh, repeat] = await Promise.all(simultaneous.map(response => expectJSON(Promise.resolve(response), 200)));
  assert.equal(fresh.status, 'published');
  assert.deepEqual(repeat, fresh);
  const other = { ...fresh.message, own: false };
  await expectJSON(request(chatURL, second), 200, { messages: [sent.message, other] });

  await stopApp();
  await startApp();
  await expectJSON(request(chatURL, second), 200, { messages: [sent.message, other] });
  await expectJSON(deleteMessage(second, sent.message.id), 200, { revoked: true });
  await expectJSON(deleteMessage(second, sent.message.id), 200, { revoked: true });
  await expectJSON(say(second, requestID, '校门口见'), 200, { status: 'revoked', message: null });
  await expectJSON(request(chatURL, second), 200, { messages: [other] });
  const { rows: [withdrawn] } = await owner.query(
    'SELECT body, revoked_at FROM paperplane_campus.chat_messages WHERE id = $1', [sent.message.id],
  );
  assert.equal(withdrawn.body, null);
  assert.ok(withdrawn.revoked_at instanceof Date);

  await expectJSON(request('/api/auth/logout', { method: 'POST', ...newcomer, json: {} }), 200);
  await expectJSON(say(newcomer, randomUUID(), '退出后不能发'), 401);
  await expectJSON(deleteMessage(newcomer, fresh.message.id), 401);
  await owner.query("UPDATE paperplane_campus.chat_messages SET published_at = now() - interval '8 days' WHERE id = $1", [fresh.message.id]);
  await expectJSON(request(chatURL, second), 200, { messages: [] });
  const later = await join('又见面的同学');
  await expectJSON(say(later, randomUUID(), '又见面了'), 200);
  const expired = await owner.query('SELECT 1 FROM paperplane_campus.chat_messages WHERE id = $1', [fresh.message.id]);
  assert.equal(expired.rowCount, 0);

  const candidate = (nickname, fields = {}) => request(accountURL, {
    method: 'POST', json: { nickname }, ...fields,
  });
  await expectJSON(request(accountURL + '?nickname=' + encodeURIComponent(starName)), 404, { error: 'not_found' });
  await expectJSON(request('/api/campus/name-eggs'), 404, { error: 'not_found' });
  const starSignup = await candidate(starName);
  const starSession = await expectJSON(starSignup, 200);
  const starPlayer = { id: starSession.user.id, cookie: starSignup.headers.get('set-cookie').split(';')[0] };
  assert.deepEqual(starSession, {
    user: { id: starPlayer.id, nickname: starName }, state: { revision: 0, progress: {} }, nameEgg: starEgg,
  });
  await expectJSON(request(accountURL, starPlayer), 200, starSession);
  await expectJSON(candidate(weatherName, starPlayer), 200, starSession);
  await expectJSON(request('/api/auth/session', starPlayer), 200, {
    user: { id: starPlayer.id, displayName: starName }, mode: 'demo',
  });
  await expectJSON(request(accountURL), 200, guest);
  await expectJSON(heartbeat(starPlayer, firstRoomTab, { nameStar: true }), 400);
  await expectJSON(heartbeat(starPlayer, firstRoomTab), 200, { players: [], emotes: [] });
  const starredPeers = (await expectJSON(heartbeat(later, secondRoomTab), 200)).players;
  assert.equal(starredPeers[0].nick, starName);
  assert.equal(starredPeers[0].nameStar, true);
  assert.deepEqual(Object.keys(starredPeers[0]).sort(), ['findable', 'nameStar', 'nick', 'personId', 'pos', 'tabId']);

  const variant = await join(weatherName.toLowerCase());
  const variantView = { user: { id: variant.id, nickname: weatherName.toLowerCase() }, state: { revision: 0, progress: {} } };
  await expectJSON(request(accountURL, variant), 200, variantView);
  await expectJSON(candidate(weatherName, variant), 200, variantView);
  const weatherSession = {
    user: { id: variant.id, nickname: weatherName }, state: { revision: 1, progress: {} }, nameEgg: weatherEgg,
  };
  await expectJSON(save(variant, { revision: 0, progress: {}, nickname: weatherName }), 200, weatherSession);
  await expectJSON(request(accountURL, variant), 200, weatherSession);
  const { nameEgg, ...weatherView } = weatherSession;
  await expectJSON(save(variant, { revision: 0, progress: {}, nickname: starName }), 409, weatherView);
  const weatherNoOp = { ...weatherView, state: { revision: 2, progress: {} } };
  await expectJSON(save(variant, { revision: 1, progress: {}, nickname: weatherName }), 200, weatherNoOp);
  await expectJSON(save(variant, { revision: 2, progress: {} }), 200, { ...weatherView, state: { revision: 3, progress: {} } });

  const ordinaryName = 'QA Ordinary Fixture';
  const ordinaryProfile = {
    user: { id: starPlayer.id, nickname: ordinaryName }, state: { revision: 1, progress: {} },
  };
  await expectJSON(save(starPlayer, { revision: 0, progress: {}, nickname: ordinaryName }), 200, ordinaryProfile);
  await expectJSON(heartbeat(starPlayer, firstRoomTab), 200);
  const regularPeers = (await expectJSON(heartbeat(later, secondRoomTab), 200)).players;
  assert.equal(regularPeers[0].nick, ordinaryName);
  assert.equal(Object.hasOwn(regularPeers[0], 'nameStar'), false);
  await expectJSON(save(starPlayer, { revision: 1, progress: {}, nickname: weatherName }), 409, { error: 'nickname_taken' });
  for (let attempt = 0; attempt < 4; attempt++) {
    await expectJSON(save(starPlayer, { revision: 0, progress: {}, nickname: starName }), 409, ordinaryProfile);
  }
  const limitedRename = await save(starPlayer, { revision: 1, progress: {}, nickname: starName });
  assert.match(limitedRename.headers.get('Retry-After'), /^[1-9]\d*$/);
  await expectJSON(limitedRename, 429, { error: 'nickname_rate_limited' });
  await expectJSON(save(starPlayer, { revision: 1, progress: {}, nickname: ordinaryName }), 200, {
    ...ordinaryProfile, state: { revision: 2, progress: {} },
  });
  assert.deepEqual((await expectJSON(heartbeat(later, secondRoomTab), 200)).players, regularPeers);
  await expectJSON(save(starPlayer, { revision: 2, progress: {} }), 200, {
    ...ordinaryProfile, state: { revision: 3, progress: {} },
  });

  // Three registrations have run since restart, including the variant and star fixtures.
  for (let attempt = 0; attempt < 5; attempt++) {
    await expectJSON(candidate(weatherName, { headers: { 'X-Campus-Client-IP': '192.0.2.' + (10 + attempt) } }),
      409, { error: 'nickname_taken' });
  }
  const limitedSignup = await candidate(starName, { headers: { 'X-Campus-Client-IP': '192.0.2.200' } });
  assert.match(limitedSignup.headers.get('Retry-After'), /^[1-9]\d*$/);
  assert.equal(limitedSignup.headers.get('Set-Cookie'), null);
  await expectJSON(limitedSignup, 429, { error: 'nickname_rate_limited' });
  await expectJSON(candidate(starName, variant), 200, { ...weatherView, state: { revision: 3, progress: {} }, nameEgg });
  assert.deepEqual(errors, []);
});
