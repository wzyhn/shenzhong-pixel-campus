import assert from "node:assert/strict";
import { test } from "node:test";
import { BGM_TRACKS, createBgmController, createShuffleBag } from "./bgm.mjs";

const playlist = ["first.mp3", "second.mp3", "third.mp3", "fourth.mp3"];

function audio() {
  const events = new Map();
  let src = "";
  return {
    paused: true,
    ended: false,
    duration: 10,
    currentTime: 0,
    playCalls: 0,
    get src() {
      return src;
    },
    set src(value) {
      src = value;
      this.paused = true;
      this.ended = false;
      this.currentTime = 0;
    },
    play() {
      this.playCalls++;
      if (this.delay) {
        const promise = this.delay;
        this.delay = null;
        return promise.then(() => {
          this.paused = false;
        });
      }
      if (this.reject) {
        const failure = this.reject;
        this.reject = null;
        return Promise.reject(failure);
      }
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    addEventListener(name, listener) {
      events.set(name, listener);
    },
    removeEventListener(name) {
      events.delete(name);
    },
    emit(name) {
      events.get(name)?.();
    },
    finish() {
      this.ended = true;
      this.paused = true;
      this.currentTime = this.duration;
      this.emit("ended");
    },
    removeAttribute() {
      this.src = "";
    },
    load() {},
  };
}

function fixture(preferences = new Map(), audioContextFactory = () => null, tracks = playlist) {
  const decks = [];
  const storage = {
    getItem: (key) => preferences.get(key),
    setItem: (key, item) => preferences.set(key, item),
  };
  let current = 0;
  let nextTimer = 0;
  const timers = new Map();
  const controller = createBgmController({
    storage,
    tracks,
    random: () => 0.999,
    audioFactory() {
      const deck = audio();
      decks.push(deck);
      return deck;
    },
    audioContextFactory,
    now: () => current,
    schedule(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { fn, time: current + delay });
      return id;
    },
    cancel: (id) => timers.delete(id),
  });
  const advance = (ms) => {
    const end = current + ms;
    for (;;) {
      const next = [...timers].sort(([, a], [, b]) => a.time - b.time)[0];
      if (!next || next[1].time > end) break;
      const [id, { fn, time }] = next;
      timers.delete(id);
      current = time;
      fn();
    }
    current = end;
  };
  return { controller, decks, advance, preferences };
}

const flush = () => new Promise(setImmediate);
const blockedError = () =>
  Object.assign(new Error("gesture required"), { name: "NotAllowedError" });

test("each bag plays every track and the boundary avoids consecutive repeats", () => {
  // Force the second shuffle to put the first bag's final track first.
  const values = [0.999, 0.999, 0.999, 0, 0.999, 0.999];
  const draw = createShuffleBag(playlist, () => values.shift() ?? 0.999);
  const first = Array.from({ length: 4 }, draw);
  const second = Array.from({ length: 4 }, draw);
  assert.deepEqual(new Set(first), new Set(playlist));
  assert.deepEqual(new Set(second), new Set(playlist));
  assert.notEqual(first.at(-1), second[0]);
});

test("the campus selection uses one audio element and loops without a standby track", async () => {
  assert.deepEqual(BGM_TRACKS, ["campus-bgm.mp3"]);
  const { controller, decks, advance } = fixture(undefined, undefined, BGM_TRACKS);
  const [playing] = decks;
  assert.equal(decks.length, 1);
  assert.equal(playing.loop, true);
  await controller.setInScene(true);
  advance(650);
  playing.currentTime = 9.7;
  playing.emit("timeupdate");
  assert.equal(playing.playCalls, 1);
  assert.equal(controller.getState().track, "campus-bgm.mp3");
  await controller.setEnabled(false);
  advance(650);
  assert.equal(playing.paused, true);
  await controller.setEnabled(true);
  assert.equal(playing.currentTime, 9.7);
  assert.equal(playing.paused, false);
});

test("blocked autoplay waits for a gesture and explicit off survives a reload", async () => {
  const {
    controller,
    decks: [playing],
    advance,
    preferences,
  } = fixture();
  playing.reject = blockedError();
  await controller.setInScene(true);
  assert.equal(controller.getState().status, "blocked");
  assert.equal(controller.getState().enabled, true);
  const unlock = controller.toggle();
  assert.equal(playing.playCalls, 2);
  await unlock;
  assert.equal(controller.getState().status, "playing");
  assert.equal(playing.volume, 0);
  advance(650);
  assert.equal(playing.volume, 0.55);
  controller.toggle();
  assert.equal(controller.getState().status, "off");
  advance(325);
  assert.equal(playing.paused, false);
  assert.ok(playing.volume > 0 && playing.volume < 0.55);
  advance(325);
  assert.equal(playing.paused, true);
  const fresh = fixture(preferences);
  await fresh.controller.setInScene(true);
  assert.equal(fresh.controller.getState().enabled, false);
  assert.equal(fresh.decks[0].playCalls, 0);
});

test("campus and memoir share one playback and leaving their routes resumes the same position", async () => {
  const {
    controller,
    decks: [playing],
    advance,
  } = fixture();
  await controller.setInScene(true);
  advance(650);
  playing.currentTime = 2;
  await controller.setInScene(true);
  assert.equal(playing.playCalls, 1);
  controller.setInScene(false);
  assert.equal(controller.getState().status, "idle");
  assert.equal(playing.paused, false);
  advance(650);
  assert.equal(playing.paused, true);
  await controller.setInScene(true);
  assert.equal(playing.currentTime, 2);
  assert.equal(playing.playCalls, 2);
});

test("the next track crossfades while the current one fades and the old deck stops", async () => {
  const {
    controller,
    decks: [playing, next],
    advance,
  } = fixture();
  await controller.setInScene(true);
  advance(650);
  playing.currentTime = 8.5;
  playing.emit("timeupdate");
  await flush();
  assert.equal(controller.getState().track, playlist[1]);
  assert.equal(next.paused, false);
  assert.equal(next.volume, 0);
  advance(750);
  assert.ok(playing.volume > 0 && playing.volume < 0.55);
  assert.ok(next.volume > 0 && next.volume < 0.55);
  advance(750);
  assert.equal(playing.paused, true);
  assert.equal(next.volume, 0.55);
  assert.equal(playing.src, playlist[2]);
});

test("a browser that blocks the standby deck continues on the original playable element", async () => {
  const {
    controller,
    decks: [playing, next],
    advance,
  } = fixture();
  await controller.setInScene(true);
  advance(650);
  next.reject = blockedError();
  playing.currentTime = 8.5;
  playing.emit("timeupdate");
  await flush();
  assert.equal(controller.getState().track, playlist[0]);
  playing.finish();
  await flush();
  assert.equal(controller.getState().track, playlist[1]);
  assert.equal(playing.paused, false);
  assert.equal(next.paused, true);
});

test("late playback from a previous route cannot play audio or overwrite status", async () => {
  const {
    controller,
    decks: [playing],
  } = fixture();
  let complete;
  playing.delay = new Promise((resolve) => {
    complete = resolve;
  });
  const start = controller.setInScene(true);
  controller.setInScene(false);
  complete();
  await start;
  assert.equal(controller.getState().status, "idle");
  assert.equal(playing.paused, true);
  assert.equal(playing.volume, 0);
});

test("a gesture resumes the Web Audio graph and schedules music gain rather than element volume", async () => {
  const operations = [];
  const context = {
    state: "suspended",
    currentTime: 1,
    destination: {},
    createGain() {
      return {
        connect() {},
        gain: {
          value: 0,
          cancelScheduledValues() {},
          setValueAtTime() {},
          linearRampToValueAtTime(level, time) {
            operations.push({ level, time });
          },
        },
      };
    },
    createMediaElementSource() {
      return { connect() {} };
    },
    resume() {
      operations.push("resume");
      this.state = "running";
    },
    close() {},
  };
  const {
    controller,
    decks: [playing],
    advance,
  } = fixture(new Map(), () => context);
  playing.reject = blockedError();
  await controller.setInScene(true);
  const start = controller.toggle();
  assert.equal(operations[0], "resume");
  await start;
  assert.deepEqual(operations[1], { level: 0.55, time: 1.65 });
  assert.equal(playing.volume, 1);
  advance(300);
  controller.setInScene(false);
  assert.deepEqual(operations[2], { level: 0, time: 1.65 });
  assert.equal(playing.paused, false);
  advance(650);
  assert.equal(playing.paused, true);
  controller.destroy();
});
