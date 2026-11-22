import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const origin = 'http://localhost:18080';
const request = (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options });
const json = async (path, options, status = 200) => {
  const response = await request(path, options);
  assert.equal(response.status, status, path);
  return { response, data: await response.json() };
};
const release = await json('/release.json');
assert.equal(release.data.mode, 'demo');
assert.equal(release.data.revision, process.env.SOURCE_COMMIT || 'local');
assert.equal(release.data.assetManifestSha256, null);
assert.match(await (await request('/')).text(), /校园开发样例/);
assert.match(await (await request('/' + encodeURI('手机校园/深中随身校园.html'))).text(), /合成像素地图/);
assert.equal((await json('/api/campus/session')).data.user, null);

const { response, data } = await json('/api/campus/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
  body: JSON.stringify({ nickname: 'Demo-' + randomUUID().slice(0, 10) }),
});
assert.match(response.headers.get('set-cookie'), /; Secure; HttpOnly; SameSite=Strict/);
const cookie = response.headers.get('set-cookie').split(';', 1)[0];
assert.match(response.headers.get('cache-control'), /(?:^|[, ]+)no-store(?:$|[, ]+)/);
const recovered = await json('/api/campus/session', { headers: { cookie } });
assert.equal(recovered.data.user.id, data.user.id);
assert.equal(Object.hasOwn(recovered.data, 'nameEgg'), false);
assert.equal((await request('/private/campus-name-eggs.json')).status, 404);
assert.equal((await request('/manifest.json')).status, 404);
assert.equal((await request('/api/healthz')).status, 404);
console.log('Demo gateway, durable session, release identity and private path checks passed');
