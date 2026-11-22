import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hash, mapPath, requiredAssets } from './asset-contract.mjs';

test('only verified browser assets reach the deployed web root', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'campus-assets-'));
  try {
    const input = path.join(scratch, 'approved');
    const bundle = path.join(scratch, 'bundle');
    const compiled = path.join(scratch, 'compiled');
    const runtime = path.join(scratch, 'runtime');
    const fixture = '<!-- campus:refresh-name-egg -->' + '<script>void 0</script>'.repeat(21);
    await mkdir(compiled);
    await writeFile(path.join(compiled, 'index.html'), '<title>Fixture</title>');
    for (const name of requiredAssets) {
      const file = path.join(input, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, name === mapPath ? fixture : 'synthetic test file');
    }
    await writeFile(path.join(input, 'private-name-eggs.json'), '[{"nickname":"Synthetic private entry"}]');
    const packed = execFileSync(process.execPath, [
      path.join(import.meta.dirname, '../scripts/pack-approved-assets.mjs'), input, bundle, hash(fixture),
    ], { encoding: 'utf8' });
    const assemble = (out, digest) => spawnSync(process.execPath, [
      path.join(import.meta.dirname, 'assemble-web.mjs'), compiled, out,
    ], { env: {
      ...process.env,
      PAPERPLANE_CAMPUS_ASSET_MODE: 'production',
      PAPERPLANE_CAMPUS_ASSETS_DIR: bundle,
      PAPERPLANE_CAMPUS_ASSET_SHA256: digest,
      PAPERPLANE_CAMPUS_BUILD_SHA: 'f'.repeat(40),
    }, encoding: 'utf8' });
    assert.notEqual(assemble(path.join(scratch, 'bad-runtime'), '0'.repeat(64)).status, 0);
    const result = assemble(runtime, packed.trim().split('=')[1]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(path.join(runtime, 'web', mapPath), 'utf8'), fixture);
    await assert.rejects(stat(path.join(runtime, 'web', 'private-name-eggs.json')), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(runtime, 'web', 'manifest.json')), { code: 'ENOENT' });
    const release = JSON.parse(await readFile(path.join(runtime, 'web', 'release.json')));
    assert.equal(release.revision, 'f'.repeat(40));
    assert.equal(release.campus_html_sha256, hash(fixture));
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
});
