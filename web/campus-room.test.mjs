import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { installCampusRoom } from "./campus-room.mjs";

const room = "hebei-shenzhou-campus-v1";
const principalID = "d4ecb890-5b45-42bd-949a-16f0db2bd2df";
const other = "123456789012345678901234";
const otherTab = "ffffffffffffffffffffffff";
const eventId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const here = { x: 26.5, y: 64.6, dir: "up", place: "西南门", private: true };
function context() {
  class DetailEvent extends Event {
    constructor(type, detail = {}) { super(type); Object.assign(this, detail); }
  }
  const child = Object.assign(new EventTarget(), {
    navigator: { onLine: true },
    document: Object.assign(new EventTarget(), { hidden: false }),
    crypto,
    PageTransitionEvent: DetailEvent,
    CustomEvent: DetailEvent,
    PPIdentity: {
      current: () => ({ principal: "trial:" + principalID }),
      authentication: () => ({ verifiedSession: true }),
    },
    PPGame: { isEntered: () => true },
  });
  return { child, auth: { principalID, current: () => ({ user: { id: principalID } }) } };
}
async function until(observe, message) {
  const deadline = Date.now() + 4_000;
  do {
    const result = observe();
    if (result) return result;
    await delay(20);
  } while (Date.now() < deadline);
  throw Error(message);
}
function spy(requirement) {
  const calls = [];
  return { calls, fetcher: async (path, init) => {
    assert.equal(path, "/api/campus/presence");
    assert.equal(init.headers["X-Campus-User-ID"], principalID);
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.cache, "no-store");
    const request = { method: init.method, body: JSON.parse(init.body), keepalive: init.keepalive };
    calls.push(request);
    return requirement(request, calls.length);
  } };
}
const snapshot = (players = [], emotes = []) => Response.json({ players, emotes });
const peer = { personId: other, tabId: otherTab, nick: "同学", findable: true, pos: here };
const wave = { personId: other, tabId: otherTab, eventId, glyph: "👋" };

test("late install reopens intact B401 transport once and preserves persisted name state", () => {
  const { child, auth } = context();
  const lifecycle = [];
  let opened;
  child.addEventListener("pagehide", event => lifecycle.push(event.persisted));
  child.addEventListener("pageshow", event => {
    lifecycle.push(event.persisted);
    opened = child.PPCreateRoomChannel(room);
  });
  const adapter = installCampusRoom(child, auth);
  assert.equal(child.PPCreateRoomChannel("other"), null);
  adapter.ensureJoined();
  adapter.ensureJoined();
  assert.deepEqual(lifecycle, [false, true]);
  assert.equal(opened.mode, "connecting");
  adapter.destroy();
  assert.equal(child.PPCreateRoomChannel, undefined);
});

test("snapshot arrives before emote, duplicate emote is dropped, privacy wins and missing peer leaves", async () => {
  const { child, auth } = context();
  let posts = 0;
  const mock = spy(({ method }) => {
    if (method === "DELETE") return new Response(null, { status: 204 });
    return posts++ < 2 ? snapshot([peer], [wave]) : snapshot();
  });
  const adapter = installCampusRoom(child, { ...auth, fetcher: mock.fetcher });
  try {
    const channel = child.PPCreateRoomChannel(room);
    const events = [];
    channel.onmessage = ({ data }) => events.push(data);
    channel.postMessage({ v: 1, type: "hello", findable: true, pos: here, nick: "ignored", rawID: principalID });
    await until(() => events.some(event => event.type === "emoji"), "No live emoji");
    assert.deepEqual(events.map(event => event.type), ["state", "emoji"]);
    assert.deepEqual(events[0].pos, { x: 26.5, y: 64.6, dir: "up", place: "西南门" });
    channel.postMessage({ v: 1, type: "text", text: "不广播这段文字" });
    channel.postMessage({ v: 1, type: "state", findable: false, pos: here });
    channel.postMessage({ v: 1, type: "emoji", eventId, glyph: "👋", findable: true, pos: here });
    await until(() => events.some(event => event.type === "bye"), "Missing snapshot did not remove peer");
    const privacy = mock.calls[1].body;
    assert.equal(privacy.findable, false);
    assert.deepEqual(Object.keys(privacy).sort(), ["emotes", "findable", "room", "tabId"]);
    assert.deepEqual(privacy.emotes, [{ eventId, glyph: "👋" }]);
    assert.equal(events.filter(event => event.type === "emoji").length, 1);
  } finally { adapter.destroy(); }
});

test("depart sends immediate and after-write deletes and ignores stale responses", async () => {
  const { child, auth } = context();
  let resolvePost;
  const mock = spy(({ method }) => method === "POST"
    ? new Promise(resolve => { resolvePost = resolve; })
    : new Response(null, { status: 204 }));
  const adapter = installCampusRoom(child, { ...auth, fetcher: mock.fetcher });
  const channel = child.PPCreateRoomChannel(room);
  const packets = [];
  channel.onmessage = ({ data }) => packets.push(data);
  channel.postMessage({ v: 1, type: "hello", findable: true, pos: here });
  await until(() => resolvePost, "No initial lease");
  channel.close();
  await until(() => mock.calls.length === 2, "No immediate departure");
  resolvePost(snapshot([peer], [wave]));
  await until(() => mock.calls.length === 3, "No final departure after in-flight write");
  assert.deepEqual(mock.calls.map(call => call.method), ["POST", "DELETE", "DELETE"]);
  assert.deepEqual(mock.calls[1].body, { room, tabId: mock.calls[0].body.tabId });
  assert.deepEqual(mock.calls[1], mock.calls[2]);
  assert.deepEqual(packets, []);
  adapter.destroy();
});

test("transport failure clears roster mode and reconnects with the same authenticated local tab", async () => {
  const { child, auth } = context();
  let posts = 0;
  const mock = spy(({ method }) => {
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (++posts === 2) return new Response(null, { status: 503 });
    return snapshot([peer]);
  });
  const adapter = installCampusRoom(child, { ...auth, fetcher: mock.fetcher });
  try {
    const modes = [];
    child.addEventListener("pp:room-status", e => modes.push(e.detail.mode));
    const channel = child.PPCreateRoomChannel(room);
    channel.postMessage({ v: 1, type: "hello", findable: true, pos: here });
    await until(() => modes.length >= 3, "Transport did not recover after failure");
    assert.deepEqual(modes, ["lan", "connecting", "lan"]);
    assert.equal(new Set(mock.calls.map(call => call.body.tabId)).size, 1);
  } finally { adapter.destroy(); }
});

test("a throttled heartbeat keeps the last roster and its retry delay while movement changes", async () => {
  const { child, auth } = context();
  const at = [];
  const mock = spy(({ method }) => {
    if (method === "DELETE") return new Response(null, { status: 204 });
    at.push(Date.now());
    return at.length === 2
      ? new Response(null, { status: 429, headers: { "Retry-After": "1" } })
      : snapshot([peer]);
  });
  const adapter = installCampusRoom(child, { ...auth, fetcher: mock.fetcher });
  try {
    const channel = child.PPCreateRoomChannel(room);
    const packets = [];
    channel.onmessage = ({ data }) => packets.push(data);
    channel.postMessage({ v: 1, type: "hello", findable: true, pos: here });
    await until(() => at.length === 2, "Expected a rate-limited heartbeat");
    channel.postMessage({ v: 1, type: "state", findable: true, pos: { ...here, x: 27 } });
    assert.equal(channel.mode, "lan");
    await until(() => at.length >= 3, "Expected heartbeat retry");
    assert.ok(at[2] - at[1] >= 900, "Movement must not override Retry-After");
    assert.equal(packets.every(packet => packet.type === "state"), true);
  } finally { adapter.destroy(); }
});

test("hidden and offline tabs stop polling and reconnect once each becomes available", async () => {
  const { child, auth } = context();
  const mock = spy(({ method }) => method === "DELETE" ? new Response(null, { status: 204 }) : snapshot([peer]));
  const adapter = installCampusRoom(child, { ...auth, fetcher: mock.fetcher });
  try {
    const channel = child.PPCreateRoomChannel(room);
    channel.postMessage({ v: 1, type: "hello", findable: true, pos: here });
    await until(() => channel.mode === "lan", "Expected first heartbeat");
    child.document.hidden = true;
    child.document.dispatchEvent(new Event("visibilitychange"));
    channel.postMessage({ v: 1, type: "state", findable: false });
    await delay(900);
    assert.equal(mock.calls.length, 1);
    child.document.hidden = false;
    child.document.dispatchEvent(new Event("visibilitychange"));
    await until(() => mock.calls.length === 2, "Expected foreground update");
    assert.equal(mock.calls[1].body.findable, false);
    child.navigator.onLine = false;
    child.dispatchEvent(new Event("offline"));
    await delay(900);
    assert.equal(channel.mode, "offline");
    assert.equal(mock.calls.length, 2);
    child.navigator.onLine = true;
    child.dispatchEvent(new Event("online"));
    await until(() => mock.calls.length === 3 && channel.mode === "lan", "Expected reconnect");
    assert.equal(new Set(mock.calls.map(call => call.body.tabId)).size, 1);
  } finally { adapter.destroy(); }
});
