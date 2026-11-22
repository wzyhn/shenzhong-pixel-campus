import { createHmac, randomBytes } from 'node:crypto';
import { exactObject } from './progress.mjs';

export const campusRoom = 'hebei-shenzhou-campus-v1';
const playerTTL = 12_000;
const emoteTTL = 3300;
const minHeartbeat = 275;
const maxPlayers = 256;
const maxTabs = 5;
const wireID = /^[0-9a-f]{24}$/;
const directions = new Set(['up', 'down', 'left', 'right']);
const glyphs = new Set(['👋', '😀', '😂', '🥰', '😭', '👍', '👏', '❤️', '🔥', '🎉', '😴', '🤔', '🙏', '🍜', '🌙', '☀️', '⚽']);

// Labels from the supplied 深中地图锚点.json safeAnchors and original LAN room.
const labels = [
  '北门', '西南门', '东南门', '操场', '主席台', '篮球场', '羽毛球场', '乒乓球场',
  '红色百年广场', '知古苑', '文瑞苑', '博陵苑', '六号学生公寓', '三号学生公寓',
  '五号学生公寓', '二号学生公寓', '食堂', '一号学生公寓', '超市', '风雨操场',
  '教师公寓', '大厕所', '西教学楼', '教研楼', '东教学楼', '四号学生公寓',
  '主教学楼', '文瑞大讲堂', '综合楼', '图书馆', '实验楼', '校园里', '校园', '校园中', '校园内',
];
const safePlaces = new Set(labels.flatMap((label) => [label, label + '附近']));

function validID(value) {
  return typeof value === 'string' && wireID.test(value);
}

function validPosition(pos) {
  return exactObject(pos, ['x', 'y', 'dir', 'place']) &&
    Number.isFinite(pos.x) && pos.x > 0 && pos.x < 62 &&
    Number.isFinite(pos.y) && pos.y > 0 && pos.y < 68 &&
    directions.has(pos.dir) && typeof pos.place === 'string' && pos.place.length <= 80;
}

export function roomPacket(body, leaving) {
  if (leaving) {
    return exactObject(body, ['room', 'tabId']) && body.room === campusRoom && validID(body.tabId) ? body : null;
  }
  if (!exactObject(body, ['room', 'tabId', 'findable', 'emotes'], ['pos']) ||
      body.room !== campusRoom || !validID(body.tabId) || typeof body.findable !== 'boolean' ||
      !Array.isArray(body.emotes) || body.emotes.length > 4 ||
      !body.emotes.every((emote) => exactObject(emote, ['eventId', 'glyph']) && validID(emote.eventId) && glyphs.has(emote.glyph)) ||
      (body.findable ? !validPosition(body.pos) : Object.hasOwn(body, 'pos'))) return null;
  if (!body.findable) return body;
  return { ...body, pos: { ...body.pos, place: safePlaces.has(body.pos.place) ? body.pos.place : '校园里' } };
}

function actorProjection(actor) {
  let latest;
  let findable = true;
  for (const tab of actor.tabs.values()) {
    if (tab.left) continue;
    if (!latest || tab.at > latest.at) latest = tab;
    if (!tab.findable) findable = false;
  }
  return latest ? {
    personId: actor.personId, tabId: actor.channelID, nick: actor.nickname, findable,
    ...(actor.nameStar ? { nameStar: true } : {}),
    ...(findable ? { pos: latest.pos } : {}),
  } : null;
}

export function createPresenceRoom(now = () => performance.now()) {
  const actors = new Map();
  const roomKey = randomBytes(32);
  const publicID = (kind, id) => createHmac('sha256', roomKey).update(kind + ':' + id).digest('hex').slice(0, 24);

  function prune(time) {
    for (const [id, actor] of actors) {
      for (const [tabID, tab] of actor.tabs) {
        if (time - tab.at >= playerTTL) actor.tabs.delete(tabID);
      }
      for (const [eventID, event] of actor.emotes) {
        if (time - event.at >= playerTTL) actor.emotes.delete(eventID);
      }
      if (!actor.tabs.size && time - actor.revokedAt >= playerTTL) actors.delete(id);
    }
  }

  function actorFor(user) {
    let actor = actors.get(user.id);
    if (!actor && actors.size < maxPlayers) {
      actor = { personId: publicID('person', user.id), channelID: publicID('channel', user.id),
        nickname: user.nickname, tabs: new Map(), emotes: new Map(), lastEmote: -Infinity, revokedAt: -Infinity };
      actors.set(user.id, actor);
    }
    return actor;
  }

  function snapshot(id, time) {
    const players = [];
    const emotes = [];
    for (const [peerID, actor] of actors) {
      if (peerID === id) continue;
      const peer = actorProjection(actor);
      if (!peer) continue;
      players.push(peer);
      for (const event of actor.emotes.values()) {
        if (time - event.at >= emoteTTL) continue;
        emotes.push({ personId: peer.personId, tabId: peer.tabId, eventId: event.eventId, glyph: event.glyph });
      }
      if (players.length >= 100) break;
    }
    return { players, emotes };
  }

  return {
    now,
    update(user, packet, at) {
      const time = now();
      prune(time);
      if (time - at >= playerTTL) return { status: 429 };
      const actor = actorFor(user);
      if (!actor) return { status: 429 };
      const prior = actor.tabs.get(packet.tabId);
      if (at <= actor.revokedAt || (prior && at <= prior.at)) return { status: 200, body: snapshot(user.id, time) };
      if ((!prior && actor.tabs.size >= maxTabs) ||
          (prior && !prior.left && prior.findable === packet.findable && at - prior.at < minHeartbeat)) {
        return { status: 429 };
      }

      actor.nickname = user.nickname;
      actor.nameStar = user.nameStar === true;
      actor.tabs.set(packet.tabId, { at, findable: packet.findable, pos: packet.pos });
      for (const emote of packet.emotes) {
        if (actor.emotes.has(emote.eventId)) continue;
        // Limit rapid bursts while retaining a retry's event ID for the whole lease.
        if (at - actor.lastEmote < 400) break;
        actor.emotes.set(emote.eventId, { ...emote, at });
        actor.lastEmote = at;
      }
      return { status: 200, body: snapshot(user.id, time) };
    },

    leave(user, tabID, at) {
      const time = now();
      prune(time);
      const actor = actorFor(user);
      const prior = actor?.tabs.get(tabID);
      if (actor && (prior ? at >= prior.at : actor.tabs.size < maxTabs)) actor.tabs.set(tabID, { at, left: true });
      return snapshot(user.id, time);
    },

    revoke(playerID) {
      const at = now();
      prune(at);
      const actor = actorFor({ id: playerID, nickname: '' });
      if (!actor) return;
      actor.revokedAt = at;
      for (const tabID of actor.tabs.keys()) actor.tabs.set(tabID, { at, left: true });
      actor.emotes.clear();
    },
  };
}
