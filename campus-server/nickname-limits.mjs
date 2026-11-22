import { isIP } from 'node:net';

const minute = 60_000;
const maxKeys = 8192;
const sweepInterval = 30_000;

function sourceKey(address) {
  if (typeof address !== 'string' || address.includes('%')) return undefined;
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return undefined;

  const canonical = new URL('http://[' + address + ']/').hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  const [left, right] = canonical.split('::');
  const prefix = left ? left.split(':') : [];
  if (right !== undefined) {
    const suffix = right ? right.split(':') : [];
    prefix.push(...Array(8 - prefix.length - suffix.length).fill('0'), ...suffix);
  }
  return prefix.slice(0, 4).join(':') + '::/64';
}

export function nicknameSource(request, trustProxy) {
  // The private backend's reverse proxy replaces this header on every request.
  const fromProxy = trustProxy ? sourceKey(request.headers['x-campus-client-ip']) : undefined;
  return fromProxy ?? sourceKey(request.socket.remoteAddress) ?? 'unknown';
}

function attemptWindow(limit, duration) {
  const attempts = new Map();
  let nextSweep = 0;

  function retryAfter(key, now) {
    const cutoff = now - duration;
    if (now >= nextSweep) {
      for (const [address, timestamps] of attempts) {
        if (timestamps.at(-1) <= cutoff) attempts.delete(address);
      }
      nextSweep = now + sweepInterval;
    }
    const timestamps = attempts.get(key);
    if (!timestamps) return attempts.size >= maxKeys ? Math.ceil((nextSweep - now) / 1000) : 0;
    while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();
    if (!timestamps.length) attempts.delete(key);
    return timestamps.length >= limit ? Math.ceil((timestamps[0] - cutoff) / 1000) : 0;
  }

  function record(key, now) {
    const timestamps = attempts.get(key);
    if (timestamps) timestamps.push(now);
    else attempts.set(key, [now]);
  }

  return { retryAfter, record };
}

export function createNicknameLimits(now = () => performance.now()) {
  const signups = attemptWindow(8, 10 * minute);
  const actorRenames = attemptWindow(6, 5 * minute);
  const sourceRenames = attemptWindow(20, 10 * minute);
  return {
    signup(source) {
      const at = now();
      const retryAfter = signups.retryAfter(source, at);
      if (!retryAfter) signups.record(source, at);
      return retryAfter;
    },
    rename(actor, source) {
      const at = now();
      const retryAfter = Math.max(actorRenames.retryAfter(actor, at), sourceRenames.retryAfter(source, at));
      if (!retryAfter) {
        actorRenames.record(actor, at);
        sourceRenames.record(source, at);
      }
      return retryAfter;
    },
  };
}
