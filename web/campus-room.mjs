const ROOM = "hebei-shenzhou-campus-v1";
const PRESENCE = "/api/campus/presence";
const hexID = /^[a-f0-9]{24}$/;
const directions = new Set(["up", "down", "left", "right"]);
const glyphs = new Set(["👋", "😀", "😂", "🥰", "😭", "👍", "👏", "❤️", "🔥", "🎉", "😴", "🤔", "🙏", "🍜", "🌙", "☀️", "⚽"]);
const pollInterval = 800;
const minInterval = 350;
const emoteLifetime = 3_000;

function randomTabID(crypto) {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, "0")).join("");
}

function position(value) {
  if (!value || !Number.isFinite(value.x) || value.x <= 0 || value.x >= 62 ||
      !Number.isFinite(value.y) || value.y <= 0 || value.y >= 68 || !directions.has(value.dir)) return undefined;
  const place = typeof value.place === "string" ? Array.from(value.place).slice(0, 20).join("") : "校园里";
  return { x: value.x, y: value.y, dir: value.dir, place };
}

function stateOf(message) {
  const findable = message.findable === true;
  const pos = findable ? position(message.pos) : undefined;
  return { findable: findable && Boolean(pos), ...(pos ? { pos } : {}) };
}

function peerOf(value) {
  if (!hexID.test(value?.tabId) || !hexID.test(value.personId) || typeof value.nick !== "string" ||
      !value.nick.trim() || Array.from(value.nick).length > 24 || typeof value.findable !== "boolean") return undefined;
  return { v: 1, type: "state", tabId: value.tabId, personId: value.personId, nick: value.nick,
    ...(value.nameStar === true ? { nameStar: true } : {}), ...stateOf(value) };
}

function createRoomChannel(child, { principalID, authorized, fetcher, room, onClose }) {
  const headers = { "Content-Type": "application/json", "X-Campus-User-ID": principalID };
  const doc = child.document;
  const visible = new Map();
  const played = new Set();
  const queued = new Map();
  let tabId;
  let state;
  let closed = false;
  let hasPresence = false;
  let pending;
  let generation = 0;
  let failures = 0;
  let timer;
  let deadline = Infinity;
  let lastCall = -Infinity;
  let nextAllowed = -Infinity;
  let stateChanged = false;

  function canPoll() {
    return !closed && child.navigator.onLine !== false && doc?.hidden !== true;
  }

  function cancelPoll() {
    clearTimeout(timer);
    deadline = Infinity;
  }

  function emit(packet) {
    channel.onmessage?.({ data: packet });
  }

  function mode(value) {
    if (channel.mode === value) return;
    channel.mode = value;
    if (value !== "lan") visible.clear();
    child.dispatchEvent(new child.CustomEvent("pp:room-status", { detail: { mode: value } }));
  }

  function schedule(ms) {
    if (!canPoll() || pending || !tabId || !state) return;
    const now = Date.now();
    const next = Math.max(nextAllowed, now + Math.max(ms, minInterval - (now - lastCall)));
    if (next >= deadline) return;
    cancelPoll();
    deadline = next;
    timer = setTimeout(() => {
      deadline = Infinity;
      void exchange();
    }, Math.max(0, next - now));
  }

  function request(method, payload, options) {
    return fetcher(PRESENCE, {
      method, headers, credentials: "same-origin", cache: "no-store", redirect: "error",
      body: JSON.stringify(payload), ...options,
    });
  }

  function forget(tabId) {
    void request("DELETE", { room, tabId }, { keepalive: true }).catch(() => {});
  }

  function leave() {
    cancelPoll();
    generation++;
    nextAllowed = -Infinity;
    const retiring = tabId;
    const shouldLeave = retiring && hasPresence;
    hasPresence = false;
    tabId = undefined;
    state = undefined;
    queued.clear();
    if (shouldLeave) {
      // Send once for page unload, and again after any in-flight update ends.
      // A fresh channel uses a different tab ID, so it cannot be removed here.
      if (pending) pending.retiring = retiring;
      forget(retiring);
    }
  }

  function render(snapshot) {
    if (!Array.isArray(snapshot?.players) || !Array.isArray(snapshot.emotes)) throw new Error("Invalid room response");
    const observed = new Map();
    for (const row of snapshot.players.slice(0, 100)) {
      const participant = peerOf(row);
      if (participant) observed.set(participant.tabId, participant);
    }
    mode("lan");
    for (const [id, previous] of visible) {
      if (observed.get(id)?.personId !== previous.personId) {
        emit({ v: 1, type: "bye", tabId: id, personId: previous.personId });
      }
    }
    visible.clear();
    for (const [id, participant] of observed) {
      visible.set(id, participant);
      emit(participant);
    }
    for (const event of snapshot.emotes.slice(0, 100)) {
      const actor = visible.get(event?.tabId);
      if (!actor || actor.personId !== event.personId || !hexID.test(event.eventId) || !glyphs.has(event.glyph)) continue;
      const key = actor.personId + ":" + event.eventId;
      if (played.has(key)) continue;
      played.add(key);
      if (played.size > 256) played.delete(played.values().next().value);
      emit({ ...actor, type: "emoji", eventId: event.eventId, glyph: event.glyph });
    }
  }

  async function exchange() {
    if (!canPoll() || pending || !tabId || !state) return;
    if (!authorized()) {
      mode("offline");
      return;
    }
    const epoch = generation;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    const requestState = { controller, retiring: undefined };
    pending = requestState;
    stateChanged = false;
    lastCall = Date.now();
    for (const [id, event] of queued) {
      if (lastCall - event.at > emoteLifetime) queued.delete(id);
    }
    const emotes = Array.from(queued.values()).slice(0, 4).map(({ eventId, glyph }) => ({ eventId, glyph }));
    hasPresence = true;
    try {
      const response = await request("POST", { room, tabId, ...state, emotes }, { signal: controller.signal });
      if (!canPoll() || epoch !== generation || !authorized()) return;
      if (response.status === 429) {
        const seconds = Number(response.headers.get("Retry-After"));
        const delay = Number.isFinite(seconds) ? seconds * 1000 : 0;
        nextAllowed = Date.now() + Math.min(4_000, Math.max(pollInterval, delay));
        return;
      }
      if (!response.ok) throw new Error("Room request failed");
      const snapshot = await response.json();
      if (!canPoll() || epoch !== generation || !authorized()) return;
      render(snapshot);
      failures = 0;
      for (const { eventId } of emotes) queued.delete(eventId);
    } catch {
      if (!canPoll() || epoch !== generation) return;
      failures = Math.min(failures + 1, 4);
      mode(child.navigator.onLine === false ? "offline" : "connecting");
    } finally {
      clearTimeout(timeout);
      pending = undefined;
      if (requestState.retiring) forget(requestState.retiring);
      const pause = failures ? Math.min(4_000, pollInterval * failures) : stateChanged || queued.size ? minInterval : pollInterval;
      schedule(pause);
    }
  }

  function online() {
    failures = 0;
    schedule(0);
  }
  function offline() {
    cancelPoll();
    pending?.controller.abort();
    mode("offline");
  }

  function visibility() {
    if (doc.hidden) cancelPoll();
    else online();
  }

  const channel = {
    mode: child.navigator.onLine === false ? "offline" : "connecting",
    onmessage: null,
    postMessage(message) {
      if (closed || message?.v !== 1) return;
      switch (message.type) {
        case "bye":
          leave();
          break;
        case "hello":
        case "state": {
          tabId ||= randomTabID(child.crypto);
          const next = stateOf(message);
          if (JSON.stringify(next) !== JSON.stringify(state)) {
            stateChanged = true;
            state = next;
            schedule(0);
          }
          break;
        }
        case "emoji":
          if (state && hexID.test(message.eventId) && glyphs.has(message.glyph)) {
            queued.set(message.eventId, { eventId: message.eventId, glyph: message.glyph, at: Date.now() });
            if (queued.size > 4) queued.delete(queued.keys().next().value);
            schedule(0);
          }
          break;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      leave();
      child.removeEventListener("online", online);
      child.removeEventListener("offline", offline);
      doc?.removeEventListener("visibilitychange", visibility);
      visible.clear();
      played.clear();
      channel.onmessage = null;
      onClose(channel);
    },
  };
  child.addEventListener("online", online);
  child.addEventListener("offline", offline);
  doc?.addEventListener("visibilitychange", visibility);
  return channel;
}

export function installCampusRoom(child, {
  principalID, current, fetcher = globalThis.fetch.bind(globalThis),
}) {
  const channels = new Set();
  let destroyed = false;
  let triedRejoin = false;
  const original = child.PPCreateRoomChannel;
  const expected = "trial:" + encodeURIComponent(principalID);
  const authorized = () => !destroyed && current()?.user.id === principalID &&
    child.PPIdentity?.current().principal === expected && child.PPIdentity.authentication().verifiedSession;
  function open(room) {
    if (destroyed || room !== ROOM) return null;
    const channel = createRoomChannel(child, {
      principalID, authorized, fetcher, room, onClose: closed => channels.delete(closed),
    });
    channels.add(channel);
    return channel;
  }
  child.PPCreateRoomChannel = open;
  return {
    ensureJoined() {
      if (triedRejoin || channels.size || !authorized() || !child.PPGame?.isEntered()) return;
      triedRejoin = true;
      // The intact inline game may have opened BroadcastChannel before the
      // parent iframe load handler. Use its lifecycle to switch transport once
      // before showing the game and before the player can open any overlays.
      child.dispatchEvent(new child.PageTransitionEvent("pagehide", { persisted: false }));
      child.dispatchEvent(new child.PageTransitionEvent("pageshow", { persisted: true }));
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const channel of channels) channel.close();
      if (child.PPCreateRoomChannel === open) {
        if (original === undefined) delete child.PPCreateRoomChannel;
        else child.PPCreateRoomChannel = original;
      }
    },
  };
}
