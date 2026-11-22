import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const [site, revision] = process.argv.slice(2);
const endpoint = new URL(site);
assert(endpoint.protocol === 'https:' && endpoint.href === endpoint.origin + '/');
assert.match(revision, /^[a-f\d]{40}$/);

function read(path) {
  return fetch(new URL(path, endpoint), {
    headers: { 'Cache-Control': 'no-cache' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
}

const deadline = Date.now() + 7 * 60_000;
let lastStatus = 'No response';
let session;
while (Date.now() < deadline) {
  try {
    const [web, api] = await Promise.all([read('/release.json'), read('/api/campus/session')]);
    const release = web.ok ? await web.json() : null;
    const apiRevision = api.headers.get('X-Campus-Revision');
    lastStatus = `Web ${web.status}, API ${api.status}`;
    if (/^[a-f\d]{40}$/.test(release?.revision)) lastStatus += `, Web revision ${release.revision}`;
    if (/^[a-f\d]{40}$/.test(apiRevision)) lastStatus += `, API revision ${apiRevision}`;
    if (release?.revision === revision && release.mode === 'production' && api.ok && apiRevision === revision) {
      session = api;
      break;
    }
    await api.body?.cancel();
  } catch (error) {
    lastStatus = error.name;
  }
  await delay(8_000);
}
assert(session, 'Expected Web and API revisions were not observed. Last observation: ' + lastStatus);

const [home, privateCatalog, administrator] = await Promise.all([
  read('/'), read('/private/campus-name-eggs.json'), read('/admin/v1/status'),
]);
assert.equal(home.status, 200);
assert.equal(session.status, 200);
assert.match(session.headers.get('Cache-Control') ?? '', /no-store/);
assert.deepEqual(await session.json(), { user: null, state: null });
assert.equal(privateCatalog.status, 404);
assert.equal(administrator.status, 404);

const receipt = `Production Web and API verified for ${revision} at ${endpoint.origin}.`;
console.log(receipt);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, receipt + '\n');
