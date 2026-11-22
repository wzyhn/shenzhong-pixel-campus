import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkCampusHtml, contactPath, hash, isHash, mapPath, readAsset, requiredAssets } from './asset-contract.mjs';

const source = import.meta.dirname;
const compiled = path.resolve(process.argv[2] || '/app/compiled-web');
const runtime = path.resolve(process.argv[3] || '/run/campus');
const mode = process.env.PAPERPLANE_CAMPUS_ASSET_MODE;
const revision = process.env.PAPERPLANE_CAMPUS_BUILD_SHA || 'local';
const useIngress = process.env.PAPERPLANE_CAMPUS_PROXY_APPEND || '0';
if (!['production', 'demo'].includes(mode) || !['0', '1'].includes(useIngress) ||
    (revision !== 'local' && !/^[a-f0-9]{40}$/.test(revision))) {
  throw new Error('Invalid web release settings');
}

const web = path.join(runtime, 'web');
let policy = "'self'";
let manifestDigest = null;
let campusHtmlDigest = null;
let wechatID = '';
await mkdir(web, { recursive: true });
if (mode === 'production') {
  if (revision === 'local') throw new Error('Coolify must supply SOURCE_COMMIT as a build argument');
  const root = process.env.PAPERPLANE_CAMPUS_ASSETS_DIR || '/app/assets';
  const manifestBytes = await readAsset(root, 'manifest.json');
  manifestDigest = hash(manifestBytes);
  if (manifestDigest !== process.env.PAPERPLANE_CAMPUS_ASSET_SHA256) {
    throw new Error('Protected campus asset manifest does not match the configured SHA-256');
  }
  const { files } = JSON.parse(manifestBytes);
  const names = Object.keys(files);
  if (requiredAssets.some((name) => !isHash(files[name])) ||
      names.some((name) => name !== contactPath && !requiredAssets.includes(name))) {
    throw new Error('Invalid protected campus asset manifest');
  }
  await cp(compiled, web, { recursive: true });
  for (const name of names) {
    const bytes = await readAsset(root, name);
    if (hash(bytes) !== files[name]) throw new Error('Protected campus asset mismatch: ' + name);
    if (name === contactPath) {
      wechatID = bytes.toString('utf8').trim();
      if (!/^[A-Za-z0-9_-]{3,64}$/.test(wechatID)) throw new Error('Invalid optional author contact');
      continue;
    }
    if (name === mapPath) {
      policy = checkCampusHtml(bytes);
      campusHtmlDigest = files[name];
    }
    const destination = path.join(web, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
} else {
  await cp(path.join(source, 'fixture'), web, { recursive: true });
  await cp(path.join(compiled, 'Web-LICENSES.txt'), path.join(web, 'Web-LICENSES.txt'));
  const destination = path.join(web, mapPath);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(source, 'fixture', 'map.html'), destination);
}
await writeFile(path.join(web, 'campus-contact.mjs'), 'export const wechatID = ' + JSON.stringify(wechatID) + ';\n');
await writeFile(path.join(web, 'release.json'), JSON.stringify({ revision, mode, assetManifestSha256: manifestDigest, campus_html_sha256: campusHtmlDigest }) + '\n');
const nginx = await readFile(path.join(source, 'campus-nginx.conf'), 'utf8');
const ingress = String.raw`map $http_x_forwarded_for $campus_client_ip {
  default $remote_addr;
  "~(?:^|,)[ \t]*(?<campus_ingress_client>[0-9A-Fa-f:.]+)[ \t]*$" $campus_ingress_client;
}
`;
const config = nginx.replace('__CAMPUS_SCRIPT_POLICY__', policy)
  .replace('__CAMPUS_CLIENT_IP__', useIngress === '1' ? '$campus_client_ip' : '$remote_addr');
await writeFile(path.join(runtime, 'site.conf'), (useIngress === '1' ? ingress : '') + config);
