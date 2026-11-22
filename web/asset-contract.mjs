import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';

export const mapPath = '手机校园/深中随身校园.html';
export const requiredAssets = [
  mapPath, '手机校园/TDesign-LICENSE.txt',
  'images/paperplane.png', 'audio/campus-bgm.mp3',
  'campus-avatar-original.mjs', 'campus-camera-install.mjs',
  'images/clues/q-7f2a9c4d.webp', 'images/clues/q-a1e6038b.webp', 'images/clues/q-c5927d4e.webp',
];
export const contactPath = 'campus-author-contact.txt';
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export async function readAsset(root, name) {
  const file = path.join(root, name);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > 64 * 1024 * 1024) {
    throw new Error('Protected campus asset is not a regular, non-empty file: ' + name);
  }
  return readFile(file);
}

export function checkCampusHtml(bytes) {
  const html = bytes.toString('utf8').replace(/\r\n?/g, '\n');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length !== 21 || !html.includes('campus:refresh-name-egg') ||
      /PPNameEggs\??\.lookup|hasNameStar|const messages = Object\.freeze/.test(html)) {
    throw new Error('Expected the browser-safe campus HTML from the private release build');
  }
  return ["'self'", ...new Set(scripts.map((body) =>
    "'sha256-" + createHash('sha256').update(body).digest('base64') + "'"))].join(' ');
}
