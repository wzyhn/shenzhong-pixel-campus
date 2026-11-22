import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { checkCampusHtml, contactPath, hash, isHash, mapPath, readAsset, requiredAssets } from '../web/asset-contract.mjs';

const [webDirectory, newDirectory, expectedHtmlSha, optionalContact] = process.argv.slice(2);
if (!webDirectory || !newDirectory || !isHash(expectedHtmlSha)) {
  throw new Error('Usage: node scripts/pack-approved-assets.mjs <protected-build/web> <new-host-bundle> <known-html-sha256> [approved-contact-file]');
}
const source = await realpath(webDirectory);
const destination = path.resolve(newDirectory);
const repo = await realpath(path.join(import.meta.dirname, '..'));
const destinationParent = await realpath(path.dirname(destination));
const resolvedDestination = path.join(destinationParent, path.basename(destination));
const relation = path.relative(repo, resolvedDestination);
if (relation === '' || (!relation.startsWith('..' + path.sep) && relation !== '..' && !path.isAbsolute(relation))) {
  throw new Error('Choose a protected destination outside the source repository');
}
const assets = new Map();
for (const name of requiredAssets) assets.set(name, await readAsset(source, name));
const html = assets.get(mapPath);
if (hash(html) !== expectedHtmlSha) throw new Error('Browser HTML differs from the authorized release receipt');
checkCampusHtml(html);
if (optionalContact) {
  const contact = await readFile(optionalContact, 'utf8');
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(contact.trim())) throw new Error('Invalid optional author contact');
  assets.set(contactPath, Buffer.from(contact.trim() + '\n'));
}

await mkdir(resolvedDestination, { mode: 0o750 });
for (const [name, bytes] of assets) {
  const destination = path.join(resolvedDestination, name);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o750 });
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o440 });
}
const files = Object.fromEntries([...assets].map(([name, bytes]) => [name, hash(bytes)]));
const manifest = Buffer.from(JSON.stringify({ files }, null, 2) + '\n');
await writeFile(path.join(resolvedDestination, 'manifest.json'), manifest, { flag: 'wx', mode: 0o440 });
console.log('PAPERPLANE_CAMPUS_ASSET_SHA256=' + hash(manifest));
