import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import { exactObject, parseNickname, validText } from './progress.mjs';

const decoder = new TextDecoder('utf-8', { fatal: true });
const weather = new Set(['day', 'night', 'rain', 'snow']);

export function readNameEggs(path) {
  try {
    if (!isAbsolute(path)) throw new Error();
    const file = openSync(path, 'r');
    let rows;
    try {
      const stats = fstatSync(file);
      if (!stats.isFile() || stats.size > 256 * 1024) throw new Error();
      rows = JSON.parse(decoder.decode(readFileSync(file)));
    } finally {
      closeSync(file);
    }

    if (!Array.isArray(rows)) throw new Error();
    const eggs = new Map();
    for (const row of rows) {
      if (!exactObject(row, ['nickname', 'txt', 'fx'])) throw new Error();
      const { nickname, txt, fx } = row;
      if (typeof nickname !== 'string' || parseNickname(nickname) !== nickname || eggs.has(nickname) ||
          !validText(txt, 1, 256) || !exactObject(fx, [], ['star', 'wx', 'toast']) ||
          (Object.hasOwn(fx, 'star') && fx.star !== true) ||
          (Object.hasOwn(fx, 'wx') && !weather.has(fx.wx)) ||
          (Object.hasOwn(fx, 'toast') && !validText(fx.toast, 1, 256))) throw new Error();
      eggs.set(nickname, { txt, fx });
    }
    return eggs;
  } catch {
    // JSON parser errors can contain private catalog text.
    throw Object.assign(new Error('Invalid campus name egg configuration'), { code: 'CAMPUS_NAME_EGGS_CONFIG' });
  }
}
