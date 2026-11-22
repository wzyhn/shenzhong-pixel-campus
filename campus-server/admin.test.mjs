import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAdminServer, readAdminCredentials } from './admin.mjs';
import { createAdminStore } from './admin-store.mjs';
import { createCampusChat } from './chat.mjs';
import { migrate } from './migrate.mjs';
import { campusRoom, createPresenceRoom } from './presence.mjs';
import { createCampusServer } from './server.mjs';
import { createPool, createStore } from './store.mjs';

const dsn = process.env.WECONQ_TEST_POSTGRES_DSN;
const origin = 'https://campus.example.invalid';
const nickname = '管理验收甲';
const original = { txt: 'Original synthetic line', fx: { star: true } };
const expiresAt = new Date(Date.now() + 3600_000).toISOString();
const token = randomBytes(32).toString('base64url');
const expired = randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const credentialConfig = [
  { actor: 'fixture-operator', digest: digest(token), expiresAt },
  { actor: 'fixture-expired', digest: digest(expired), expiresAt: '2020-01-01T00:00:00Z' },
];

test('credentials reload and reject invalid configurations without exposing values', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'campus-admin-test-'));
  const file = path.join(directory, 'admin.json');
  try {
    await writeFile(file, JSON.stringify(credentialConfig));
    assert.deepEqual(await readAdminCredentials(file), credentialConfig);
    await writeFile(file, '[]');
    assert.deepEqual(await readAdminCredentials(file), []);
    await writeFile(file, JSON.stringify([{ ...credentialConfig[0], value: token }]));
    await assert.rejects(readAdminCredentials(file), { code: 'CAMPUS_ADMIN_CREDENTIALS' });
  } finally {
    await rm(file, { force: true });
    await rmdir(directory);
  }
});

test('private admin end to end preserves public compatibility and persistent operation receipts', {
  skip: !dsn && 'Set WECONQ_TEST_POSTGRES_DSN to an isolated local PostgreSQL maintenance database',
}, async context => {
  const maintenance = new URL(dsn);
  assert.ok(['127.0.0.1', '[::1]', 'localhost'].includes(maintenance.hostname));
  assert.equal(maintenance.pathname, '/postgres');
  assert.equal(maintenance.search, '');
  const suffix = randomBytes(8).toString('hex');
  const database = 'paperplane_admin_test_' + suffix;
  const role = 'paperplane_admin_app_' + suffix;
  const adminRole = 'paperplane_admin_operator_' + suffix;
  const owner = createPool(maintenance.href);
  await owner.query('CREATE DATABASE ' + database);
  const isolated = new URL(database, maintenance.href);
  const setup = createPool(isolated.href);
  const password = randomBytes(24).toString('hex');
  const errors = [];
  let pool, adminPool, privateApp, publicApp, privateURL, publicURL;
  let clock = 1000;
  const rolesCreated = [];

  async function stop() {
    await Promise.all([publicApp, privateApp].filter(Boolean).map(server =>
      new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    publicApp = privateApp = undefined;
    await Promise.all([pool?.end(), adminPool?.end()]);
    pool = adminPool = undefined;
  }

  context.after(async () => {
    await stop();
    await setup.end();
    await owner.query('DROP DATABASE ' + database);
    for (const createdRole of rolesCreated) await owner.query('DROP ROLE ' + createdRole);
    await owner.end();
  });

  await migrate(setup);
  await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  rolesCreated.push(role);
  await owner.query(`CREATE ROLE ${adminRole} LOGIN PASSWORD '${password}'`);
  rolesCreated.push(adminRole);
  await setup.query(`GRANT USAGE ON SCHEMA paperplane_campus TO ${role}, ${adminRole}`);
  await setup.query(`GRANT SELECT ON paperplane_campus.migrations TO ${role}`);
  await setup.query(`GRANT SELECT, INSERT, UPDATE ON paperplane_campus.players, paperplane_campus.sessions,
    paperplane_campus.albums TO ${role}`);
  await setup.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON paperplane_campus.photos, paperplane_campus.chat_messages TO ${role}`);
  await setup.query(`GRANT SELECT ON paperplane_campus.admin_settings, paperplane_campus.admin_bans,
    paperplane_campus.admin_catalogs, paperplane_campus.admin_hidden_chat TO ${role}`);
  await setup.query(`GRANT SELECT (id,nickname,revision,nickname_conflict,updated_at,progress) ON paperplane_campus.players TO ${adminRole}`);
  await setup.query(`GRANT SELECT (revoked_at,expires_at) ON paperplane_campus.sessions TO ${adminRole}`);
  await setup.query(`GRANT SELECT, UPDATE ON paperplane_campus.chat_messages TO ${adminRole}`);
  await setup.query(`GRANT SELECT, UPDATE ON paperplane_campus.admin_settings TO ${adminRole}`);
  await setup.query(`GRANT SELECT, INSERT, UPDATE ON paperplane_campus.admin_bans, paperplane_campus.admin_catalogs,
    paperplane_campus.admin_plans TO ${adminRole}`);
  await setup.query(`GRANT SELECT, INSERT ON paperplane_campus.admin_hidden_chat, paperplane_campus.admin_operations TO ${adminRole}`);

  async function start(allowOperator = true) {
    const runtime = new URL(isolated.href);
    runtime.username = role;
    runtime.password = password;
    pool = createPool(runtime.href);
    if (allowOperator) {
      runtime.username = adminRole;
      adminPool = createPool(runtime.href);
    }
    const store = createStore(pool);
    const presence = createPresenceRoom(() => clock);
    const chat = createCampusChat(pool, { adminEnabled: true });
    assert.equal(await store.ready(), true);
    assert.equal(await chat.ready(), true);
    const admin = await createAdminStore({ policyPool: pool, pool: adminPool, presence, originalEggs: new Map([[nickname, original]]) });
    publicApp = createCampusServer({ store, presence, origin, chat, admin, onError: error => errors.push(error) });
    publicApp.listen(0, '127.0.0.1');
    await once(publicApp, 'listening');
    publicURL = 'http://127.0.0.1:' + publicApp.address().port;
    if (allowOperator) {
      await admin.verifyWriter();
      privateApp = createAdminServer({ store: admin, credentials: async () => credentialConfig, revision: 'local',
        environment: 'staging', onError: error => errors.push(error) });
      privateApp.listen(0, '127.0.0.1');
      await once(privateApp, 'listening');
      privateURL = 'http://127.0.0.1:' + privateApp.address().port;
    }
    return admin;
  }

  await start();
  await assert.rejects(pool.query('UPDATE paperplane_campus.admin_settings SET maintenance = true'), { code: '42501' });
  await assert.rejects(adminPool.query('DELETE FROM paperplane_campus.admin_operations'), { code: '42501' });
  await assert.rejects(adminPool.query('SELECT token_sha256 FROM paperplane_campus.sessions'), { code: '42501' });
  async function request(root, route, status, { method = 'GET', headers = {}, body } = {}) {
    const response = await fetch(root + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, status, `${route}: ${JSON.stringify(result)} ${errors[0]?.message ?? ''}`);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    return { result, headers: response.headers };
  }
  async function manage(route, { method = 'GET', json, status = 200, key = randomUUID(), revision,
    credential = token, additional = {} } = {}) {
    const headers = { ...additional };
    if (credential) headers.authorization = 'Bearer ' + credential;
    if (json !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'Idempotency-Key': key,
      'X-Campus-Admin-Environment': 'staging', ...additional });
    if (revision !== undefined) headers['If-Match'] = '"' + revision + '"';
    return (await request(privateURL, '/admin/v1' + route, status, { method, headers, body: json })).result;
  }
  async function campus(route, status, { account, method = 'GET', data } = {}) {
    const headers = account ? { cookie: account.cookie, 'X-Campus-User-ID': account.id } : {};
    if (method !== 'GET') headers.origin = origin;
    if (data !== undefined) headers['content-type'] = 'application/json';
    return request(publicURL, route, status, { method, headers, body: data });
  }

  await request(publicURL, '/admin/v1/status', 404, { headers: { authorization: 'Bearer ' + token } });
  await request(privateURL, '/api/campus/session', 404, { headers: { authorization: 'Bearer ' + token } });
  await manage('/status', { credential: null, status: 401 });
  await manage('/status', { credential: expired, status: 401 });
  await manage('/status', { additional: { Origin: origin }, status: 404 });
  assert.deepEqual(await manage('/session'), { actor: 'fixture-operator', environment: 'staging' });
  assert.equal((await manage('/status')).online, 0);

  async function join(name) {
    const { result, headers } = await campus('/api/campus/session', 200, { method: 'POST', data: { nickname: name } });
    return { cookie: headers.get('set-cookie').split(';')[0], id: result.user.id };
  }
  const first = await join(nickname);
  const second = await join('管理验收乙');
  assert.deepEqual((await campus('/api/campus/session', 200, { account: first })).result.nameEgg, original);
  assert.equal((await manage('/players?q=' + encodeURIComponent('验收甲'))).items[0].id, first.id);
  assert.equal((await manage('/players/' + first.id)).banned, false);

  async function heartbeat(account, letter, status = 200) {
    clock += 400;
    return (await campus('/api/campus/presence', status, { method: 'POST', account, data: {
      room: campusRoom, tabId: letter.repeat(24), findable: false, emotes: [],
    } })).result;
  }
  await heartbeat(first, 'a');
  assert.equal((await heartbeat(second, 'b')).players.length, 1);
  const banKey = randomUUID();
  const banData = { playerId: first.id, reason: '现场证据已确认', until: expiresAt };
  await manage('/bans', { method: 'POST', json: banData,
    additional: { 'X-Campus-Admin-Environment': 'production' }, status: 409 });
  const ban = await manage('/bans', { method: 'POST', json: banData, key: banKey });
  assert.deepEqual(await manage('/bans', { method: 'POST', json: banData, key: banKey }), ban);
  await manage('/bans', { method: 'POST', json: { ...banData, reason: '另一个动作' }, key: banKey, status: 409 });
  assert.equal((await manage('/operations/' + ban.operationId)).target, first.id);
  assert.equal((await manage('/operations?key=' + banKey)).id, ban.operationId);
  for (const route of ['/api/campus/session', '/api/auth/session', '/api/campus/album', '/api/campus/chat']) {
    assert.deepEqual((await campus(route, 403, { account: first })).result, { error: 'player_banned' });
  }
  await campus('/api/campus/session', 403, { account: first, method: 'POST', data: { nickname: '重注册' } });
  await heartbeat(first, 'a', 403);
  assert.equal((await heartbeat(second, 'b')).players.length, 0);
  await stop();
  await start(false);
  await campus('/api/campus/session', 403, { account: first });
  await stop();
  await start();
  await manage('/bans/' + ban.banId + '/lift', { method: 'POST', json: { reason: '确认解除' } });
  assert.equal((await campus('/api/campus/session', 200, { account: first })).result.user.id, first.id);
  assert.equal((await manage('/bans')).items.length, 0);

  const chatData = { requestId: randomUUID(), text: '合成公屏消息' };
  const published = (await campus('/api/campus/chat', 200, { account: first, method: 'POST', data: chatData })).result.message;
  assert.equal((await manage('/chat')).items[0].text, chatData.text);
  await manage('/chat/' + published.id + '/hide', { method: 'POST', json: { reason: '验收隐去' } });
  assert.deepEqual((await campus('/api/campus/chat', 200, { account: second })).result.messages, []);
  assert.deepEqual((await campus('/api/campus/chat', 200,
    { account: first, method: 'POST', data: chatData })).result, { status: 'revoked', message: null });

  const draft = await manage('/name-eggs/versions', { method: 'POST', json: {} });
  const draftPath = '/name-eggs/versions/' + draft.id;
  const note = { txt: 'Updated synthetic line', fx: { wx: 'snow' } };
  const edit = await manage(draftPath + '/entries', { method: 'PUT', revision: 1, json: { entries: [{ nickname, ...note }] } });
  const activate = { versionId: draft.id, versionRevision: edit.revision };
  await manage('/name-eggs/active', { method: 'PUT', revision: 0, json: activate, status: 409 });
  await manage(draftPath + '/preview', { method: 'POST', revision: 2, json: {} });
  await manage('/name-eggs/active', { method: 'PUT', revision: 0, json: activate });
  assert.deepEqual((await campus('/api/campus/session', 200, { account: first })).result.nameEgg, note);
  assert.equal((await campus('/api/campus/session', 200, { account: second })).result.nameEgg, undefined);
  const noCatalog = await campus('/api/campus/name-eggs', 404);
  assert.deepEqual(noCatalog.result, { error: 'not_found' });
  await manage(draftPath + '/entries', { method: 'PUT', revision: 2, json: { entries: [] }, status: 409 });
  await stop();
  const liveAdmin = await start();
  assert.deepEqual((await campus('/api/campus/session', 200, { account: first })).result.nameEgg, note);
  await manage('/name-eggs/active', { method: 'PUT', revision: 1, json: { versionId: null, versionRevision: null } });
  assert.deepEqual((await campus('/api/campus/session', 200, { account: first })).result.nameEgg, original);

  const releaseWrite = liveAdmin.beginWrite();
  const pending = manage('/maintenance', { method: 'PUT', revision: 2, json: { enabled: true, reason: '维护验收' } });
  await new Promise(resolve => setTimeout(resolve, 75));
  try {
    assert.equal(liveAdmin.beginWrite(), null);
    assert.equal((await manage('/status')).maintenance, false);
  } finally {
    releaseWrite();
  }
  assert.equal((await pending).maintenance, true);
  await campus('/api/campus/state', 503, { account: first, method: 'PUT', data: { revision: 0, progress: {} } });
  assert.equal((await campus('/api/campus/session', 200, { account: first })).result.user.id, first.id);
  await manage('/maintenance', { method: 'PUT', revision: 3, json: { enabled: false, reason: '维护完成' } });
  await campus('/api/campus/state', 200, { account: first, method: 'PUT', data: { revision: 0, progress: {} } });

  await heartbeat(first, 'a');
  await heartbeat(second, 'b');
  const plan = await manage('/operations/preview', { method: 'POST', json: { scope: 'online', reason: '本次仅清在场' } });
  assert.equal(plan.count, 2);
  const executePath = '/operations/' + plan.operationId + '/execute';
  const executeKey = randomUUID();
  await manage(executePath, { method: 'POST', revision: 3, json: {}, status: 409 });
  const result = await manage(executePath, { method: 'POST', revision: 4, json: {}, key: executeKey });
  assert.equal(result.cleared, 2);
  assert.equal((await manage('/status')).online, 0);
  await heartbeat(first, 'a');
  assert.deepEqual(await manage(executePath, { method: 'POST', revision: 4, json: {}, key: executeKey }), result);
  assert.equal((await manage('/status')).online, 1);
  for (const scope of ['sessions', 'progress', 'players']) {
    const preview = await manage('/operations/preview', { method: 'POST', json: { scope, reason: '仅查看影响' } });
    assert.equal(preview.executable, false);
    await manage('/operations/' + preview.operationId + '/execute', { method: 'POST', revision: 4, json: {}, status: 409 });
  }
  assert.equal((await campus('/api/campus/session', 200, { account: first })).result.state.revision, 1);
  assert.equal((await manage('/audit')).items.some(item => item.action === 'reset.execute'), true);
  assert.deepEqual(errors, []);
});
