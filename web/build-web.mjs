import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const source = import.meta.dirname;
const out = path.resolve(process.argv[2] || path.join(source, '.build/web'));
await mkdir(out, { recursive: true });
const files = [
  'bgm.mjs', 'campus-album.mjs', 'campus-appearance.css', 'campus-appearance.mjs', 'campus-author.mjs',
  'campus-camera.mjs', 'campus-chat.css', 'campus-chat.mjs', 'campus-clues.css', 'campus-clues.mjs',
  'campus-embed.mjs', 'campus-floating-stick.mjs', 'campus-hud.css', 'campus-hud.mjs',
  'campus-identity.mjs', 'campus-mobile.css', 'campus-overview.css', 'campus-overview.mjs', 'campus-room.mjs',
];
for (const file of files) await cp(path.join(source, file), path.join(out, file));
for (const [from, to] of [
  ['campus-index.html', 'index.html'], ['campus-preview.css', 'preview.css'], ['campus-preview.mjs', 'preview.mjs'],
]) await cp(path.join(source, from), path.join(out, to));

const { metafile } = await build({
  absWorkingDir: source,
  entryPoints: ['tdesign-entry.mjs'],
  outfile: path.join(out, 'tdesign.mjs'),
  bundle: true,
  format: 'esm',
  target: ['chrome84', 'firefox83', 'safari14.1'],
  minify: true,
  metafile: true,
  define: {
    'process.env.NODE_ENV': '"production"',
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
});
const dependencies = new Set();
for (const { inputs } of Object.values(metafile.outputs)) {
  for (const [file, { bytesInOutput }] of Object.entries(inputs)) {
    const name = file.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1];
    if (bytesInOutput && name) dependencies.add(name);
  }
}
const notices = [];
for (const name of [...dependencies].sort()) {
  const root = path.join(source, 'node_modules', name);
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const licenses = (await readdir(root)).filter((file) => /^(license|notice)(\.|$)/i.test(file)).sort();
  if (!licenses.length) throw new Error('Missing bundled dependency license: ' + name);
  notices.push('## ' + name + ' ' + version);
  for (const file of licenses) notices.push((await readFile(path.join(root, file), 'utf8')).trim());
}
await writeFile(path.join(out, 'Web-LICENSES.txt'), notices.join('\n\n') + '\n');
