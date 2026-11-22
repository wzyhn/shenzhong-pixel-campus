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
while (Date.now() < deadline) {
  try {
    const response = await read('/release.json');
    lastStatus = String(response.status);
    if (response.ok) {
      const release = await response.json();
      if (release.revision === revision) break;
      lastStatus = /^[a-f\d]{40}$/.test(release.revision) ? 'Running revision ' + release.revision : 'Revision unavailable';
    }
  } catch (error) {
    lastStatus = error.name;
  }
  await delay(8_000);
}
assert(Date.now() < deadline, 'Expected production revision was not observed. Last observation: ' + lastStatus);

const [home, session, privateCatalog, administrator] = await Promise.all([
  read('/'), read('/api/campus/session'), read('/private/campus-name-eggs.json'), read('/admin/v1/status'),
]);
assert.equal(home.status, 200);
assert.equal(session.status, 200);
assert.match(session.headers.get('Cache-Control') ?? '', /no-store/);
assert.deepEqual(await session.json(), { user: null, state: null });
assert.equal(privateCatalog.status, 404);
assert.equal(administrator.status, 404);

const receipt = `Production verified for ${revision} at ${endpoint.origin}.`;
console.log(receipt);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, receipt + '\n');
