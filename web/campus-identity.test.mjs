import test from "node:test";
import assert from "node:assert/strict";
import { createCampusIdentity } from "./campus-identity.mjs";

const actor = "239f5b41-b251-4d72-9f2b-60780c24972e";
const name = "合成校友";
const principal = "trial:" + actor;
const journeyKey = "paperplane_sz_mobile_save_v1";
const profileKey = "paperplane-demo-profile-v1";
const outfitKey = "paperplane_sz_mobile_look_v1";
const initialJourney = { v: 1, x: 26.5, y: 64.6, d: "up", n: 0, r: 0, s: 0, mu: 0, sf: 0, z: 1.82, run: 0, t: 1 };
const outfit = { grade: "2023", hair: "short", hairC: "#432234", skin: "#ffffff" };
const education = { stage: "高中", school: "河北深州市中学", schoolId: "hebei-shenzhou", year: "2023", grade: "", group: "" };
const signed = (revision = 0, progress = {}, nickname = name) => ({ user: { id: actor, nickname }, state: { revision, progress } });

function storage() {
  const records = new Map();
  return {
    getItem: key => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
    removeItem: key => records.delete(key),
  };
}

function server(react) {
  const traffic = [];
  const fetcher = async (path, input) => {
    assert.equal(input.credentials, "same-origin");
    assert.equal(input.cache, "no-store");
    assert.equal(input.redirect, "error");
    const request = { path, method: input.method ?? "GET", body: input.body && JSON.parse(input.body),
      headers: input.headers };
    traffic.push(request);
    const { data, status = 200 } = react(request);
    return Response.json(data, { status });
  };
  return { traffic, fetcher };
}

function child(initial = { principal: "guest", displayName: "旧访客" }, fragment = "") {
  const window = new EventTarget();
  const document = new EventTarget();
  const button = { hidden: false };
  document.getElementById = id => id === "pp-back-home" ? button : null;
  let identity = initial;
  let entered = false;
  const activity = { saved: 0, restored: 0, outfits: [] };
  return Object.assign(window, {
    document, location: { hash: fragment }, activity, button,
    PPIdentity: {
      current: () => identity,
      authentication: () => ({ verifiedSession: identity.principal.startsWith("trial:") }),
    },
    PPGame: { isEntered: () => entered },
    __ppEngine: {
      goHome() { activity.restored++; },
      restoreAppearance(value) { activity.outfits.push(value); },
      save() { activity.saved++; },
    },
    enter() { entered = true; window.dispatchEvent(new Event("pp:entered")); },
    identify(nextPrincipal, displayName) {
      identity = { principal: nextPrincipal, displayName };
      window.dispatchEvent(new Event("pp:principal-change"));
    },
  });
}

const nextTurn = () => new Promise(resolve => setTimeout(resolve, 5));

test("real nickname session hydrates only its UUID-scoped game data", async () => {
  const disk = storage();
  disk.setItem(journeyKey, "unrelated guest data");
  const { traffic, fetcher } = server(({ path, method, body }) => {
    assert.equal(path, "/api/campus/session");
    if (method === "GET") return { data: { user: null, state: null } };
    assert.deepEqual(body, { nickname: name });
    return { data: signed(2, { journey: initialJourney, outfit }) };
  });
  const identity = createCampusIdentity({ fetcher, storage: disk });
  const emitted = [];
  identity.subscribe(session => emitted.push(session));
  assert.equal(await identity.load(), null);
  await assert.rejects(identity.login(" \u202e "), /昵称/);
  assert.equal(traffic.length, 1);
  assert.equal((await identity.login(" " + name + " ")).user.id, actor);
  assert.equal(emitted.length, 2);
  assert.equal(disk.getItem(journeyKey), "unrelated guest data");
  assert.deepEqual(JSON.parse(disk.getItem(journeyKey + ":" + principal)), initialJourney);
  assert.deepEqual(JSON.parse(disk.getItem(outfitKey + ":" + principal)), outfit);
  identity.destroy();
});

test("authenticated child waits for matching account and avoids duplicate guest entrance", async () => {
  const { fetcher } = server(() => ({ data: signed(2, { journey: initialJourney }) }));
  const identity = createCampusIdentity({ fetcher, storage: storage() });
  await identity.load();
  const campus = child();
  const view = identity.connect(campus);
  campus.enter();
  assert.equal(campus.activity.restored, 0);
  campus.identify(principal, name);
  await view.ready;
  assert.equal(campus.activity.restored, 1);
  assert.equal(campus.button.hidden, true);
  campus.identify("guest", "");
  assert.equal(identity.current(), null);
  view.destroy();
  identity.destroy();
});

test("a hidden campus can finish authenticated admission after its tab returns", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { fetcher } = server(() => ({ data: signed(2, { journey: initialJourney }) }));
  const identity = createCampusIdentity({ fetcher, storage: storage() });
  await identity.load();
  const campus = child({ principal, displayName: name });
  const view = identity.connect(campus);
  context.mock.timers.tick(3000);
  campus.document.hidden = true;
  campus.document.dispatchEvent(new Event("visibilitychange"));
  context.mock.timers.tick(13_000);
  campus.document.hidden = false;
  campus.document.dispatchEvent(new Event("visibilitychange"));
  campus.enter();
  await view.ready;
  context.mock.timers.tick(6500);
  assert.equal(campus.activity.restored, 1);
  campus.identify("guest", "");
  assert.equal(identity.current(), null, "the admitted bridge remains live");
  identity.destroy();
});

test("an unready visible iframe can still time out after returning to its tab", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { fetcher } = server(() => ({ data: signed() }));
  const identity = createCampusIdentity({ fetcher, storage: storage() });
  await identity.load();
  const campus = child();
  campus.document.hidden = true;
  const view = identity.connect(campus);
  const expired = assert.rejects(view.ready, /did not verify the durable nickname session/);
  context.mock.timers.tick(13_000);
  campus.document.hidden = false;
  campus.document.dispatchEvent(new Event("visibilitychange"));
  context.mock.timers.tick(6000);
  await expired;
  identity.destroy();
});

test("invite stays on its original landing while progress, private profile and rename save under actor", async () => {
  const disk = storage();
  const moved = { ...initialJourney, x: 28, t: 2 };
  const renamed = "校友新称呼";
  const { traffic, fetcher } = server(({ method, body, headers }) => {
    if (method === "GET") return { data: signed(2, { journey: initialJourney }) };
    assert.equal(method, "PUT");
    assert.equal(headers["X-Campus-User-ID"], actor);
    return { data: signed(body.revision + 1, body.progress, body.nickname) };
  });
  const identity = createCampusIdentity({ fetcher, storage: disk, interval: 30_000 });
  await identity.load();
  const campus = child({ principal, displayName: name }, "#place=field");
  campus.enter();
  const view = identity.connect(campus);
  await view.ready;
  assert.equal(campus.activity.restored, 0);
  disk.setItem(journeyKey + ":" + principal, JSON.stringify(moved));
  disk.setItem(profileKey + ":" + principal, JSON.stringify({ nickname: renamed, accountName: name, age: "22",
    education: [{ ...education, ignored: true }], realName: "本机旧名" }));
  disk.setItem("paperplane_sz_mobile_chat_v1:" + principal, JSON.stringify([{ text: "本机聊天" }]));
  campus.identify(principal, renamed);
  await nextTurn();
  assert.deepEqual(traffic[1].body, { revision: 2, progress: {
    journey: moved, profile: { age: "22", education: [education] },
  }, nickname: renamed });
  disk.setItem(journeyKey + ":" + principal, JSON.stringify({ ...moved, t: 3 }));
  campus.dispatchEvent(new Event("pagehide"));
  await nextTurn();
  assert.equal(traffic.length, 2, "a fresh timestamp alone does not trigger an update");
  assert.equal(identity.current().user.nickname, renamed);
  identity.destroy();
});

test("a conflict keeps newer canonical groups and retries unrelated outfit changes", async () => {
  const disk = storage();
  const canonicalJourney = { ...initialJourney, y: 60, t: 2 };
  let attempts = 0;
  const { traffic, fetcher } = server(({ method, body }) => {
    if (method === "GET") return { data: signed(2, { journey: initialJourney }) };
    if (attempts++ === 0) return { status: 409, data: signed(3, { journey: canonicalJourney }) };
    return { data: signed(body.revision + 1, body.progress) };
  });
  const identity = createCampusIdentity({ fetcher, storage: disk, interval: 30_000 });
  await identity.load();
  const campus = child({ principal, displayName: name });
  campus.enter();
  await identity.connect(campus).ready;
  disk.setItem(journeyKey + ":" + principal, JSON.stringify({ ...initialJourney, y: 65, t: 3 }));
  disk.setItem(outfitKey + ":" + principal, JSON.stringify(outfit));
  campus.dispatchEvent(new Event("pagehide"));
  await nextTurn();
  assert.deepEqual(traffic[2].body, { revision: 3, progress: { journey: canonicalJourney, outfit } });
  assert.equal(identity.current().state.revision, 4);
  assert.deepEqual(JSON.parse(disk.getItem(journeyKey + ":" + principal)), canonicalJourney);
  identity.destroy();
});


test("first visit submits validated appearance in the same registration request", async () => {
  const selected = { grade: "2021 级", hair: "pony", hairC: "#8d6a45", skin: "#c49a74" };
  const disk = storage();
  const { traffic, fetcher } = server(({ method, body }) => {
    if (method === "GET") return { data: { user: null, state: null } };
    assert.deepEqual(body, { nickname: name, outfit: selected });
    return { data: signed(0, { outfit: selected }) };
  });
  const identity = createCampusIdentity({ fetcher, storage: disk });
  await identity.load();
  await assert.rejects(identity.login(name, { ...selected, hair: "custom" }), /校服造型/);
  const result = await identity.login(name, selected);
  assert.deepEqual(result.state.progress.outfit, selected);
  assert.deepEqual(traffic.map(({ method }) => method), ["GET", "POST"]);
  assert.deepEqual(JSON.parse(disk.getItem(outfitKey + ":" + principal)), selected);
  identity.destroy();
});

test("same-origin admission lock reads the shared cookie before enrolling a second tab", async () => {
  let tail = Promise.resolve();
  let cookie;
  let startEnrollment;
  let releaseEnrollment;
  const enrolled = new Promise(resolve => { startEnrollment = resolve; });
  const hold = new Promise(resolve => { releaseEnrollment = resolve; });
  const traffic = [];
  const sessionLocks = {
    request(resource, operation) {
      assert.equal(resource, "paperplane-campus-session");
      const task = tail.then(operation);
      tail = task.catch(() => {});
      return task;
    },
  };
  const fetcher = async (url, { method = "GET", body }) => {
    assert.equal(url, "/api/campus/session");
    traffic.push(method);
    if (method === "POST") {
      startEnrollment();
      await hold;
      assert.equal(cookie, undefined);
      cookie = signed(0, {}, JSON.parse(body).nickname);
    }
    return Response.json(cookie || { user: null, state: null });
  };
  const first = createCampusIdentity({ fetcher, sessionLocks, storage: storage() });
  const second = createCampusIdentity({ fetcher, sessionLocks, storage: storage() });
  const one = first.login("先点进校的同学");
  await enrolled;
  const two = second.login("另一个标签页");
  assert.deepEqual(traffic, ["GET", "POST"]);
  releaseEnrollment();
  const result = await Promise.all([one, two]);
  assert.deepEqual(result[0], result[1]);
  assert.equal(result[1].user.nickname, "先点进校的同学");
  assert.deepEqual(traffic, ["GET", "POST", "GET"]);
  first.destroy();
  second.destroy();
});

test("confirmed native logout pulses other tabs before the original handler can detach", async () => {
  const disk = storage();
  const pulseKey = "paperplane-web-session-changed-v1";
  const { fetcher } = server(() => ({ data: signed() }));
  const identity = createCampusIdentity({ fetcher, storage: disk, sessionLocks: null });
  await identity.load();
  const campus = child({ principal, displayName: name });
  let response = 403;
  campus.fetch = (route, options) => {
    assert.equal(route, "/api/auth/logout");
    assert.equal(options.headers.get("X-Campus-User-ID"), actor);
    return Promise.resolve(Response.json({ user: null }, { status: response }));
  };
  campus.enter();
  await identity.connect(campus).ready;
  assert.equal((await campus.fetch("/api/auth/logout", { method: "POST" })).status, 403);
  assert.equal(disk.getItem(pulseKey), null);
  response = 200;
  assert.equal((await campus.fetch("/api/auth/logout", { method: "POST" })).status, 200);
  assert(disk.getItem(pulseKey));
  assert.equal(identity.current().user.id, actor, "B401 consumes the successful response after the pulse");
  identity.destroy();
});

test("a taken first nickname leaves admission open and preserves the next outfit submission", async () => {
  const available = "还没有人使用的昵称";
  const selected = { grade: "2021 级", hair: "pony", hairC: "#8d6a45", skin: "#c49a74" };
  const disk = storage();
  const { traffic, fetcher } = server(({ method, body }) => {
    if (method === "GET") return { data: { user: null, state: null } };
    if (body.nickname === name) return { status: 409, data: { error: "nickname_taken" } };
    assert.deepEqual(body, { nickname: available, outfit: selected });
    return { data: signed(0, { outfit: selected }, available) };
  });
  const identity = createCampusIdentity({ fetcher, storage: disk });
  assert.equal(await identity.load(), null);
  await assert.rejects(identity.login(name, selected), /昵称已被使用/);
  assert.equal(identity.current(), null);
  assert.equal(disk.getItem(outfitKey + ":" + principal), null);
  await identity.login(available, selected);
  assert.deepEqual(traffic.map(({ method }) => method), ["GET", "POST", "POST"]);
  assert.equal(identity.current().user.nickname, available);
  identity.destroy();
});

test("conflict repair keeps the same account and retries only a newer canonical revision", async () => {
  const advanced = { ...initialJourney, y: 62, t: 2 };
  const renamed = "有效的新称呼";
  const disk = storage();
  const conflict = (revision, journey) => {
    const canonical = signed(revision, { journey, outfit });
    return { ...canonical, user: { ...canonical.user, nicknameConflict: true } };
  };
  const { traffic, fetcher } = server(({ method, body, headers }) => {
    if (method === "GET") return { data: conflict(2, initialJourney) };
    assert.equal(method, "PUT");
    assert.equal(headers["X-Campus-User-ID"], actor);
    if (body.nickname === name) return { status: 409, data: { error: "nickname_taken" } };
    if (body.revision === 2) return { status: 409, data: conflict(3, advanced) };
    assert.deepEqual(body, { revision: 3, progress: { journey: advanced, outfit }, nickname: renamed });
    return { data: signed(4, body.progress, renamed) };
  });
  const identity = createCampusIdentity({ fetcher, storage: disk });
  const notices = [];
  identity.subscribe(session => notices.push(session?.user));
  assert.equal((await identity.load()).user.nicknameConflict, true);
  assert.throws(() => identity.connect(child()), /requires a durable session/);
  await assert.rejects(identity.rename(name), /昵称已被使用/);
  assert.equal(identity.current().user.nicknameConflict, true);
  const repaired = await identity.rename(renamed);
  assert.deepEqual(repaired, signed(4, { journey: advanced, outfit }, renamed));
  assert.deepEqual(notices, [undefined, { id: actor, nickname: name, nicknameConflict: true }, { id: actor, nickname: renamed }]);
  assert.equal(traffic.some(({ method }) => method === "POST"), false);
  assert.deepEqual(JSON.parse(disk.getItem(journeyKey + ":" + principal)), advanced);
  assert.deepEqual(JSON.parse(disk.getItem(outfitKey + ":" + principal)), outfit);
  identity.destroy();
});

test("a taken optimistic settings alias returns to the scoped name without retrying it", async () => {
  const disk = storage();
  const existing = { nickname: name, accountName: name, age: "22", education: [education] };
  const alias = "别人已占用";
  const profile = { age: existing.age, education: existing.education };
  const { traffic, fetcher } = server(({ method, body }) => {
    if (method === "GET") return { data: signed(2, { profile }) };
    assert.equal(body.nickname, alias);
    return { status: 409, data: { error: "nickname_taken" } };
  });
  const identity = createCampusIdentity({ fetcher, storage: disk, interval: 30_000 });
  await identity.load();
  const campus = child({ principal, displayName: name });
  campus.enter();
  await identity.connect(campus).ready;
  disk.setItem(profileKey + ":" + principal, JSON.stringify({ ...existing, nickname: alias }));
  campus.identify(principal, alias);
  await nextTurn();
  assert.deepEqual(JSON.parse(disk.getItem(profileKey + ":" + principal)), existing);
  campus.dispatchEvent(new Event("pagehide"));
  await nextTurn();
  assert.deepEqual(traffic.map(({ method }) => method), ["GET", "PUT"]);
  assert.equal(identity.current().user.nickname, name);
  identity.destroy();
});

test("returning account gets its canonical outfit once and keeps navigation progress", async () => {
  const existing = { grade: "2020 级", hair: "buzz", hairC: "#6b4a2f", skin: "#f2d3b3" };
  const disk = storage();
  const { traffic, fetcher } = server(() => ({ data: signed(5, { journey: initialJourney, outfit: existing }) }));
  const identity = createCampusIdentity({ fetcher, storage: disk });
  await identity.load();
  const campus = child({ principal, displayName: name });
  // The inline entry may briefly write its first-look default before the
  // parent verifies admission. The confirmed account remains authoritative.
  disk.setItem(outfitKey + ":" + principal, JSON.stringify(outfit));
  campus.enter();
  const bridge = identity.connect(campus);
  await bridge.ready;
  campus.enter();
  assert.deepEqual(campus.activity.outfits, [{ ...existing, name }]);
  assert.equal(campus.activity.restored, 1);
  assert.deepEqual(JSON.parse(disk.getItem(outfitKey + ":" + principal)), existing);
  assert.deepEqual(traffic.map(({ method }) => method), ["GET"]);
  identity.destroy();
});
