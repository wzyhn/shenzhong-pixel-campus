import { crc32 } from 'node:zlib';
import { exactObject, validText } from './progress.mjs';

export const maxPhotoBytes = 2 * 1024 * 1024;
export const maxAlbumBytes = 20 * 1024 * 1024;
export const maxAlbumPhotos = 12;
// Anonymous enrollment requires a service-wide budget on the dedicated volume.
export const maxStoredPhotoBytes = 128 * 1024 * 1024;
export const maxStoredPhotos = 10_000;

const directions = new Set(['up', 'down', 'left', 'right']);
const lighting = new Set(['day', 'night', 'rain', 'snow']);

export function validPhotoMetadata(metadata) {
  return exactObject(metadata, ['taken', 'caption', 'placeId', 'placeName', 'nearby', 'schoolName', 'shotPreset']) &&
    Number.isSafeInteger(metadata.taken) && metadata.taken >= 0 &&
    validText(metadata.caption, 0, 72) && typeof metadata.placeId === 'string' &&
    /^[a-z0-9-]{0,40}$/.test(metadata.placeId) && validText(metadata.placeName, 0, 48) &&
    typeof metadata.nearby === 'boolean' && metadata.schoolName === '河北深州市中学' &&
    validShotPreset(metadata.shotPreset);
}

function validShotPreset(preset) {
  return exactObject(preset, [], ['light', 'zoom', 'facing']) &&
    (!Object.hasOwn(preset, 'light') || lighting.has(preset.light)) &&
    (!Object.hasOwn(preset, 'zoom') || Number.isFinite(preset.zoom) && preset.zoom >= 1 && preset.zoom <= 2.6) &&
    (!Object.hasOwn(preset, 'facing') || directions.has(preset.facing));
}

const signature = Buffer.from('89504e470d0a1a0a', 'hex');

export function validPng(image) {
  if (image.length < 45 || !image.subarray(0, signature.length).equals(signature)) return false;
  let hasData = false;
  let offset = signature.length;
  while (offset + 12 <= image.length) {
    const length = image.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > image.length) return false;
    const type = image.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) ||
        crc32(image.subarray(offset + 4, end - 4)) !== image.readUInt32BE(end - 4)) return false;
    if (offset === signature.length) {
      if (type !== 'IHDR' || length !== 13) return false;
      const width = image.readUInt32BE(offset + 8);
      const height = image.readUInt32BE(offset + 12);
      if (width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 12_000_000) return false;
    } else if (type === 'IHDR') {
      return false;
    }
    if (type === 'IDAT' && length > 0) hasData = true;
    if (type === 'IEND') return hasData && length === 0 && end === image.length;
    offset = end;
  }
  return false;
}
