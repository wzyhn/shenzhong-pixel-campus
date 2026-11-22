import assert from 'node:assert/strict';
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readNameEggs } from './name-eggs.mjs';
import { createNicknameLimits, nicknameSource } from './nickname-limits.mjs';

test('loads an exact, private catalog and reports invalid files without data', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'campus-egg-test-'));
  const file = path.join(directory, 'catalog.json');
  context.after(async () => {
    await rm(file, { force: true });
    await rmdir(directory);
  });
  const row = { nickname: 'FixtureCase', txt: 'Synthetic message', fx: { star: true, wx: 'snow', toast: 'Synthetic toast' } };
  await writeFile(file, JSON.stringify([row]));
  const result = readNameEggs(file);
  assert.deepEqual(result, new Map([[row.nickname, { txt: row.txt, fx: row.fx }]]));
  assert.equal(result.get(row.nickname.toLowerCase()), undefined);

  for (const input of [
    '{bad synthetic data',
    JSON.stringify([row, row]),
    JSON.stringify([{ ...row, nickname: ' LeadingSpace' }]),
    JSON.stringify([{ ...row, fx: { wx: 'wind' } }]),
    JSON.stringify([{ ...row, fx: { star: false } }]),
    JSON.stringify([{ ...row, fx: { arbitrary: true } }]),
    Buffer.from([0xff]),
  ]) {
    await writeFile(file, input);
    assert.throws(() => readNameEggs(file), {
      code: 'CAMPUS_NAME_EGGS_CONFIG', message: 'Invalid campus name egg configuration',
    });
  }
  assert.throws(() => readNameEggs(path.join(directory, 'missing.json')), { code: 'CAMPUS_NAME_EGGS_CONFIG' });
  assert.throws(() => readNameEggs('relative/catalog.json'), { code: 'CAMPUS_NAME_EGGS_CONFIG' });
});

test('uses the source supplied by the private proxy only when explicitly trusted', () => {
  const request = (address) => ({ headers: { 'x-campus-client-ip': address }, socket: { remoteAddress: '192.0.2.1' } });
  assert.equal(nicknameSource(request('198.51.100.20'), false), '192.0.2.1');
  assert.equal(nicknameSource(request('198.51.100.20'), true), '198.51.100.20');
  assert.equal(nicknameSource(request('198.51.100.20, 192.0.2.4'), true), '192.0.2.1');
  assert.equal(nicknameSource(request('::ffff:c000:201'), true), '192.0.2.1');
  assert.equal(nicknameSource(request('2001:0db8:0:15::1'), true), nicknameSource(request('2001:db8:0:15:f::2'), true));
  assert.notEqual(nicknameSource(request('2001:db8:0:15::2'), true), nicknameSource(request('2001:db8:0:16::2'), true));
});

test('bounds signup and rename windows by source, actor and expiry', () => {
  let now = 0;
  const limits = createNicknameLimits(() => now);
  for (let index = 0; index < 8; index++) assert.equal(limits.signup('shared'), 0);
  assert.equal(limits.signup('shared'), 600);
  assert.equal(limits.signup('other'), 0);
  for (let index = 0; index < 6; index++) assert.equal(limits.rename('actor', 'source-' + index), 0);
  assert.equal(limits.rename('actor', 'fresh-source'), 300);
  for (let index = 0; index < 20; index++) assert.equal(limits.rename('actor-' + index, 'shared'), 0);
  assert.equal(limits.rename('fresh-actor', 'shared'), 600);
  assert.equal(limits.rename('fresh-actor', 'other'), 0);
  now += 5 * 60_000;
  assert.equal(limits.rename('actor', 'fresh-source'), 0);
  assert.equal(limits.rename('another-actor', 'shared'), 300);
  assert.equal(limits.signup('shared'), 300);
  now += 5 * 60_000;
  assert.equal(limits.rename('another-actor', 'shared'), 0);
  assert.equal(limits.signup('shared'), 0);
});

test('refuses untracked sources at capacity and recovers when buckets expire', () => {
  let now = 0;
  const limits = createNicknameLimits(() => now);
  for (let index = 0; index < 8192; index++) assert.equal(limits.signup('source-' + index), 0);
  assert.equal(limits.signup('new'), 30);
  assert.equal(limits.signup('source-0'), 0);
  now = 10 * 60_000;
  assert.equal(limits.signup('new'), 0);
});
