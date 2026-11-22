export const BGM_TRACKS = Object.freeze(["campus-bgm.mp3"]);

const PREFERENCE_KEY = "paperplane.bgm.enabled.v1";
const DEFAULT_TRACKS = BGM_TRACKS.map((name) => new URL(`./audio/${name}`, import.meta.url).href);

export function createShuffleBag(tracks, random = Math.random) {
  const unique = [...new Set(tracks)];
  let remaining = [];
  let last;
  return () => {
    if (!remaining.length) {
      remaining = [...unique];
      for (let index = remaining.length - 1; index > 0; index--) {
        const next = Math.floor(random() * (index + 1));
        [remaining[index], remaining[next]] = [remaining[next], remaining[index]];
      }
      if (remaining.length > 1 && remaining[0] === last) {
        [remaining[0], remaining[1]] = [remaining[1], remaining[0]];
      }
    }
    last = remaining.shift();
    return last;
  };
}

export function createBgmController({
  tracks = DEFAULT_TRACKS,
  audioFactory = () => new Audio(),
  audioContextFactory = () => {
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    return Context ? new Context() : null;
  },
  storage,
  random = Math.random,
  now = () => performance.now(),
  schedule = setTimeout,
  cancel = clearTimeout,
  volume = 0.55,
  fadeMs = 650,
  crossfadeMs = 1800,
} = {}) {
  let enabled = true;
  try {
    storage ??= globalThis.localStorage;
    enabled = storage?.getItem(PREFERENCE_KEY) !== "off";
  } catch (_) {
    // Playback remains usable when storage is unavailable.
  }

  const listeners = new Set();
  const nextTrack = createShuffleBag(tracks, random);
  const multipleTracks = new Set(tracks).size > 1;
  const decks = Array.from({ length: multipleTracks ? 2 : 1 }, () => ({
    audio: audioFactory(),
    track: "",
    level: 0,
  }));
  let active = decks[0];
  let queued = "";
  let context;
  let contextAttempted = false;
  let transition;
  let crossfadeUnavailable = false;
  let generation = 0;
  let inScene = false;
  let destroyed = false;
  let state = Object.freeze({ enabled, inScene, status: enabled ? "idle" : "off", track: "" });

  function publish(status) {
    const track = active.track;
    if (
      state.enabled === enabled &&
      state.inScene === inScene &&
      state.status === status &&
      state.track === track
    )
      return;
    state = Object.freeze({ enabled, inScene, status, track });
    for (const listener of listeners) listener(state);
  }

  function playingAllowed() {
    return enabled && inScene && !destroyed;
  }

  function setVolume(deck, level) {
    deck.level = level;
    if (deck.gain) deck.gain.value = level;
    else deck.audio.volume = level;
  }

  function currentVolume(deck) {
    if (!deck.ramp) return deck.level;
    const { start, end, began, duration } = deck.ramp;
    const progress = Math.min(1, Math.max(0, (now() - began) / duration));
    return start + (end - start) * progress;
  }

  function stopFade(deck) {
    const level = currentVolume(deck);
    if (deck.timer !== undefined) cancel(deck.timer);
    if (deck.gain) deck.gain.cancelScheduledValues(context.currentTime);
    deck.ramp = null;
    deck.timer = undefined;
    setVolume(deck, level);
  }

  function fade(deck, end, duration, done = () => {}) {
    stopFade(deck);
    if (!duration || deck.level === end) {
      setVolume(deck, end);
      done();
      return;
    }
    deck.ramp = { start: deck.level, end, duration, began: now() };
    const finish = () => {
      deck.ramp = null;
      deck.timer = undefined;
      setVolume(deck, end);
      done();
    };
    if (deck.gain) {
      deck.gain.setValueAtTime(deck.level, context.currentTime);
      deck.gain.linearRampToValueAtTime(end, context.currentTime + duration / 1000);
      deck.timer = schedule(finish, duration);
      return;
    }
    const tick = () => {
      const remaining = deck.ramp.duration - (now() - deck.ramp.began);
      if (remaining <= 0) return finish();
      setVolume(deck, currentVolume(deck));
      deck.timer = schedule(tick, Math.min(24, remaining));
    };
    deck.timer = schedule(tick, Math.min(24, duration));
  }

  function unlockAudio() {
    if (!contextAttempted) {
      contextAttempted = true;
      try {
        context = audioContextFactory();
      } catch (_) {
        return;
      }
      if (context)
        for (const deck of decks) {
          const level = currentVolume(deck);
          try {
            const gain = context.createGain();
            gain.gain.value = level;
            gain.connect(context.destination);
            const source = context.createMediaElementSource(deck.audio);
            source.connect(gain);
            stopFade(deck);
            deck.gain = gain.gain;
            deck.audio.volume = 1;
          } catch (_) {
            // Some engines allow playback while limiting media node creation.
          }
        }
    }
    if (context?.state === "suspended" || context?.state === "interrupted") {
      try {
        Promise.resolve(context.resume()).catch(() => {});
      } catch (_) {}
    }
  }

  function source(deck, track) {
    stopFade(deck);
    deck.audio.pause();
    setVolume(deck, 0);
    deck.playRequest = null;
    deck.track = track;
    deck.audio.src = track;
  }

  function prepareNext() {
    queued ||= nextTrack() || "";
    const standby = decks.find((deck) => deck !== active);
    if (queued && standby.track !== queued) source(standby, queued);
    return standby;
  }

  function pause() {
    generation++;
    transition = null;
    for (const deck of decks) {
      if (deck.audio.paused || !currentVolume(deck)) {
        stopFade(deck);
        setVolume(deck, 0);
        deck.audio.pause();
      } else fade(deck, 0, fadeMs, () => deck.audio.pause());
    }
    publish(enabled ? "idle" : "off");
  }

  async function start(gesture = false) {
    if (!playingAllowed()) return;
    if (!active.track || active.audio.ended) {
      const track = queued || nextTrack();
      queued = "";
      if (!track) return publish("error");
      source(active, track);
    }
    if (gesture) {
      crossfadeUnavailable = false;
      unlockAudio();
    }
    const deck = active;
    const attempt = ++generation;
    deck.playRequest = attempt;
    stopFade(deck);
    publish("starting");
    try {
      await deck.audio.play();
      if (attempt !== generation || !playingAllowed()) {
        if (!playingAllowed()) deck.audio.pause();
        return;
      }
      fade(deck, volume, fadeMs);
      publish("playing");
      if (multipleTracks) prepareNext();
    } catch (error) {
      if (attempt !== generation || !playingAllowed()) return;
      setVolume(deck, 0);
      deck.audio.pause();
      publish(error?.name === "NotAllowedError" ? "blocked" : "error");
    }
  }

  async function advance(deck, overlap) {
    if (deck !== active || !playingAllowed() || transition) return;
    if (!overlap) {
      const track = queued || nextTrack();
      queued = "";
      if (!track) return publish("error");
      source(deck, track);
      void start();
      return;
    }
    const standby = prepareNext();
    const marker = {};
    standby.playRequest = marker;
    transition = marker;
    try {
      await standby.audio.play();
      if (transition !== marker || !playingAllowed()) {
        if (standby !== active && standby.playRequest === marker) {
          standby.audio.pause();
          standby.audio.currentTime = 0;
        }
        return;
      }
      active = standby;
      queued = "";
      const remaining = (deck.audio.duration - deck.audio.currentTime) * 1000;
      const duration = Math.max(0, Math.min(crossfadeMs, remaining));
      fade(standby, volume, duration || fadeMs);
      fade(deck, 0, duration, () => {
        deck.audio.pause();
        if (transition !== marker) return;
        transition = null;
        if (playingAllowed()) prepareNext();
      });
      publish("playing");
    } catch (_) {
      if (transition !== marker || !playingAllowed()) return;
      transition = null;
      crossfadeUnavailable = true;
      standby.audio.pause();
      // Safari can require the original user-activated element for the next track.
      if (deck.audio.ended) void advance(deck, false);
    }
  }

  for (const deck of decks) {
    deck.audio.preload = "auto";
    deck.audio.loop = tracks.length > 0 && !multipleTracks;
    setVolume(deck, 0);
    deck.onTime = () => {
      const remaining = deck.audio.duration - deck.audio.currentTime;
      if (
        state.status === "playing" &&
        !crossfadeUnavailable &&
        multipleTracks &&
        Number.isFinite(remaining) &&
        remaining > 0 &&
        remaining * 1000 <= crossfadeMs
      ) {
        void advance(deck, true);
      }
    };
    deck.onEnd = () => {
      void advance(deck, false);
    };
    deck.onError = () => {
      if (deck !== active || !playingAllowed() || state.status !== "playing") return;
      pause();
      publish("error");
    };
    deck.audio.addEventListener("timeupdate", deck.onTime);
    deck.audio.addEventListener("ended", deck.onEnd);
    deck.audio.addEventListener("error", deck.onError);
  }

  function setEnabled(next) {
    if (destroyed || enabled === Boolean(next)) return;
    enabled = Boolean(next);
    try {
      storage?.setItem(PREFERENCE_KEY, enabled ? "on" : "off");
    } catch (_) {}
    if (playingAllowed()) return start(true);
    pause();
  }

  function resumeAfterGesture() {
    if (!playingAllowed() || !["blocked", "error"].includes(state.status)) return;
    if (state.status === "error" && active.track) source(active, active.track);
    return start(true);
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    setInScene(value) {
      const next = Boolean(value);
      if (destroyed || next === inScene) return;
      inScene = next;
      if (playingAllowed()) return start(globalThis.navigator?.userActivation?.isActive === true);
      pause();
    },
    toggle() {
      if (destroyed) return;
      if (enabled && inScene && ["blocked", "error"].includes(state.status)) {
        return resumeAfterGesture();
      }
      return setEnabled(!enabled);
    },
    setEnabled,
    resumeAfterGesture,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      transition = null;
      listeners.clear();
      for (const deck of decks) {
        stopFade(deck);
        setVolume(deck, 0);
        deck.audio.pause();
        deck.audio.removeEventListener("timeupdate", deck.onTime);
        deck.audio.removeEventListener("ended", deck.onEnd);
        deck.audio.removeEventListener("error", deck.onError);
        deck.audio.removeAttribute("src");
        deck.audio.load();
      }
      if (context) Promise.resolve(context.close()).catch(() => {});
    },
  };
}
