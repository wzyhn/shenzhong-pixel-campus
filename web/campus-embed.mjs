import { connectCampusAlbum } from "./campus-album.mjs";
import { connectCampusDressPreview } from "./campus-appearance.mjs";
import { installCampusCamera } from "./campus-camera-install.mjs";
import { connectCampusChat } from "./campus-chat.mjs";
import { connectCampusAuthor } from "./campus-author.mjs";
import { connectCampusClues } from "./campus-clues.mjs";
import { connectCampusHud, connectCampusQuickControls, keepCampusResizeWarningsInConsole } from "./campus-hud.mjs";
import { connectCampusOverview } from "./campus-overview.mjs";
import { installCampusRoom } from "./campus-room.mjs";

const CAMPUS_PATH = "/手机校园/深中随身校园.html";
// Verified ppAnchors from the authorized packaged release.
const places = new Set([
  "north-gate", "southwest-gate", "southeast-gate", "field", "stands", "basketball", "badminton",
  "table-tennis", "red-century-square", "zhigu-garden", "wenrui-garden", "boling-garden",
  "dorm-6", "dorm-3", "dorm-5", "dorm-2", "canteen", "dorm-1", "shop", "gym", "teacher-residence",
  "restroom", "west-teaching", "faculty-building", "east-teaching", "dorm-4", "main-teaching",
  "wenrui-hall", "comprehensive", "library", "lab",
]);
const aliases = new Map([
  ["gate", "southwest-gate"], ["wenrui", "wenrui-garden"], ["gym", "field"], ["building", "main-teaching"],
  ["track", "field"], ["classroom", "main-teaching"], ["grove", "wenrui-garden"],
]);

const clueId = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function campusClueIntent(url) {
  const ids = url.searchParams.getAll("clue");
  return ids.length === 1 && clueId.test(ids[0]) ? ids[0] : null;
}

export function campusDocument(url) {
  const query = new URLSearchParams();
  const room = url.searchParams.get("room");
  if (url.searchParams.getAll("room").length === 1 && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(room || "")) {
    query.set("room", room);
  }
  if (campusClueIntent(url)) return CAMPUS_PATH + (query.size ? `?${query}` : "");
  const hash = url.hash.slice(1);
  const fragment = new URLSearchParams(hash.length <= 180 ? hash : "");
  const intent = new URLSearchParams();
  const targets = [...fragment.getAll("target"), ...url.searchParams.getAll("target")];
  const legacy = hash.startsWith("campus/") ? aliases.get(hash.slice(7))
    : targets.length === 1 ? aliases.get(targets[0]) : undefined;
  const place = fragment.get("place") || url.searchParams.get("place") || legacy;
  if (places.has(place) && fragment.getAll("place").length <= 1 && url.searchParams.getAll("place").length <= 1) {
    intent.set("place", place);
    const light = fragment.get("light");
    const zoom = fragment.get("zoom");
    const facing = fragment.get("facing");
    if (["day", "night", "rain", "snow"].includes(light)) intent.set("light", light);
    if (/^\d(?:\.\d{1,2})?$/.test(zoom || "") && Number(zoom) >= 1 && Number(zoom) <= 2.6) intent.set("zoom", zoom);
    if (["up", "down", "left", "right"].includes(facing)) intent.set("facing", facing);
  } else if (fragment.get("v") === "1") {
    const guess = fragment.get("guess");
    const seed = fragment.get("s");
    if (/^(?:0|[1-9][0-9]?)$/.test(guess || "") && Number(guess) < places.size &&
        /^(?:0|[1-9][0-9]?)$/.test(seed || "") && Number(seed) < 32) {
      intent.set("guess", guess);
      intent.set("v", "1");
      intent.set("s", seed);
    }
  }
  return CAMPUS_PATH + (query.toString() ? `?${query}` : "") + (intent.toString() ? `#${intent}` : "");
}

function connectCampusClueMenu(child, open) {
  const doc = child.document;
  const menu = doc.getElementById("pp-menu");
  if (!menu) return () => {};
  function addClues() {
    const shortcuts = doc.querySelector("#pp-sheet:not([hidden]) .pp-menu-quick");
    const content = shortcuts?.parentElement;
    if (!content || content.querySelector("[data-campus-clues]")) return;
    const section = doc.createElement("div");
    section.className = "pp-rowset";
    section.dataset.campusClues = "";
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "pp-item";
    button.innerHTML = child.PPTD.icon("search");
    const label = doc.createElement("span");
    label.textContent = "校园线索";
    button.append(label);
    button.addEventListener("click", () => {
      doc.getElementById("pp-close")?.click();
      void open();
    });
    section.append(button);
    shortcuts.after(section);
  }
  menu.addEventListener("click", addClues);
  return () => {
    menu.removeEventListener("click", addClues);
    doc.querySelector("[data-campus-clues]")?.remove();
  };
}

function connectShare(child) {
  const share = child.PPShare;
  if (!share) return;
  function siteLink(href) {
    if (!href) return null;
    const link = new URL(href);
    if (link.origin !== child.location.origin) return null;
    link.pathname = "/";
    return link.href;
  }
  child.PPShare = Object.freeze({
    ...share,
    placeURL: (...args) => siteLink(share.placeURL(...args)),
    guessURL: (...args) => siteLink(share.guessURL(...args)),
  });
}

function labelCampusSession(child) {
  const doc = child.document;
  const stage = doc.getElementById("ppStage");
  if (!stage) return;
  let panel;
  const observer = new child.MutationObserver(update);
  function update() {
    const identity = doc.getElementById("pp-identity");
    if (!identity) return;
    if (panel !== identity) {
      panel = identity;
      observer.disconnect();
      observer.observe(panel, { childList: true, subtree: true });
    }
    const label = panel.querySelector(".pid-summary + .pid-hint");
    if (label?.textContent === "本机演示账号 · 本设备资料") label.textContent = "昵称已登录";
    for (const hint of panel.querySelectorAll(".pid-hint")) {
      if (hint.textContent === "本次修改保存在此设备，同学会在小人头顶与名单里看到这个称呼。") {
        hint.textContent = "校园昵称必须唯一。同学会在小人头顶和在线名单里看到你的昵称。";
      }
    }
  }
  observer.observe(stage, { childList: true });
  update();
  return () => observer.disconnect();
}

function connectAudio(child, bgm) {
  const source = child.BGM_SRC;
  const Audio = child.Audio;
  const audioMenu = child.PPAudio;
  const mount = audioMenu?.mount;
  if (typeof source !== "string" || !source.startsWith("data:audio/") || typeof Audio !== "function" || !mount) return {};

  // The packaged sound settings have no host hook. Suppress only their bundled
  // backing track inside this frame and route its switch to the site player.
  const wrappedAudio = new Proxy(Audio, {
    construct(Target, args, newTarget) {
      if (args[0] !== source) return Reflect.construct(Target, args, newTarget);
      const silent = Reflect.construct(Target, [], newTarget);
      silent.play = () => Promise.resolve();
      return silent;
    },
  });
  child.Audio = wrappedAudio;
  let unsubscribe, effectsPanel;
  const bridgedMount = function (parent) {
    mount.call(this, parent);
    unsubscribe?.();
    const original = parent.querySelector('button[role="switch"][aria-label="校园原声"]');
    if (!original) return;
    const control = original.cloneNode();
    control.setAttribute("aria-label", "校园音乐");
    const label = original.parentElement.querySelector(".ppa-label");
    if (label) label.textContent = "校园音乐";
    original.replaceWith(control);
    control.addEventListener("click", () => void bgm.setEnabled(!bgm.getState().enabled));
    unsubscribe = bgm.subscribe(({ enabled }) =>
      control.setAttribute("aria-checked", String(enabled)),
    );
  };
  audioMenu.mount = bridgedMount;
  return {
    toggleEffects() {
      if (!effectsPanel) {
        effectsPanel = child.document.createElement("div");
        effectsPanel.hidden = true;
        child.document.body.append(effectsPanel);
      }
      effectsPanel.replaceChildren();
      mount.call(audioMenu, effectsPanel);
      effectsPanel.querySelector('button[role="switch"][aria-label="动作音效"]')?.click();
    },
    destroy() {
      unsubscribe?.();
      effectsPanel?.remove();
      if (audioMenu.mount === bridgedMount) audioMenu.mount = mount;
      if (child.Audio === wrappedAudio) child.Audio = Audio;
    },
  };
}

export function mountCampusEmbed(host, { bgm, identity, principalID, onReady }) {
  const doc = host.ownerDocument;
  const parent = doc.defaultView;
  const frame = doc.createElement("iframe");
  frame.className = "campus-frame";
  frame.title = "深中随身校园";
  frame.tabIndex = 0;
  frame.setAttribute("aria-busy", "true");
  let target;
  function updateLocation() {
    const next = campusDocument(new URL(parent.location.href));
    if (next === target) return;
    target = next;
    frame.src = next;
  }
  updateLocation();
  parent.addEventListener("hashchange", updateLocation);

  const status = doc.createElement("div");
  status.className = "campus-frame-status";
  status.setAttribute("role", "status");
  const message = doc.createElement("span");
  message.textContent = "正在打开校园…";
  const retry = doc.createElement("button");
  retry.type = "button";
  retry.textContent = "重新载入";
  retry.hidden = true;
  retry.addEventListener("click", () => parent.location.reload());
  status.append(message, retry);

  let disconnect, deadline, generation = 0, disposed = false, opening = true;
  function showFallback() {
    opening = false;
    clearTimeout(deadline);
    onReady(false);
    frame.setAttribute("aria-busy", "true");
    message.textContent = "校园暂时未能载入。";
    retry.hidden = false;
    status.hidden = false;
  }
  function watchOpening() {
    clearTimeout(deadline);
    if (opening && !doc.hidden) deadline = setTimeout(showFallback, 12000);
  }
  doc.addEventListener("visibilitychange", watchOpening);
  watchOpening();

  async function onLoad() {
    const turn = ++generation;
    disconnect?.();
    disconnect = undefined;
    if (disposed) return;
    try {
      const child = frame.contentWindow;
      if (decodeURIComponent(child.location.pathname) !== CAMPUS_PATH || !child.PPGame?.isEntered || !child.PPIdentity) {
        showFallback();
        return;
      }
      const closeResizeWarnings = keepCampusResizeWarningsInConsole(child);
      const audio = connectAudio(child, bgm);
      const hud = connectCampusHud(child, frame);
      const closeDress = connectCampusDressPreview(child);
      const closeCamera = installCampusCamera(child);
      const closeControls = connectCampusQuickControls(child, bgm, audio.toggleEffects);
      const closeAuthor = connectCampusAuthor(child);
      const room = installCampusRoom(child, { principalID, current: identity.current });
      const session = identity.connect(child);
      const closeLabel = labelCampusSession(child);
      let album, chat, clues, closeClueMenu, overview;
      connectShare(child);
      disconnect = () => {
        overview?.destroy();
        closeClueMenu?.();
        clues?.destroy();
        album?.destroy();
        chat?.destroy();
        room.destroy();
        session.destroy();
        closeLabel?.();
        closeAuthor();
        closeControls();
        closeResizeWarnings();
        closeCamera();
        closeDress();
        hud.destroy();
        audio.destroy?.();
      };
      await session.ready;
      if (disposed || turn !== generation) return;
      hud.compactRoster();
      room.ensureJoined();
      try {
        overview = connectCampusOverview(child);
        hud.attachQuickMap(overview.open);
      } catch { /* The original map remains usable. */ }
      try {
        chat = connectCampusChat(child, { identity });
      } catch { /* Map navigation remains available when chat is unavailable. */ }
      try {
        clues = connectCampusClues(child, {
          incoming: campusClueIntent(new URL(parent.location.href)),
          visit: ({ id, light, zoom, facing }) => places.has(id) && child.PPGame.goToPlace(id, { light, zoom, facing }),
          href: (id) => typeof id === "string" && clueId.test(id) ? new URL(`/?clue=${id}`, parent.location.origin).href : null,
        });
        closeClueMenu = connectCampusClueMenu(child, clues.open);
      } catch { /* An unavailable clue does not stop roaming. */ }
      try {
        album = connectCampusAlbum(child, { principalID, current: identity.current });
        void album.ready.catch(() => {});
      } catch { /* Campus play remains available when album storage is denied. */ }
      await hud.css;
      if (disposed || turn !== generation) return;
      opening = false;
      clearTimeout(deadline);
      status.hidden = true;
      frame.removeAttribute("aria-busy");
      onReady(true);
      hud.focusGame();
    } catch {
      if (!disposed && turn === generation) showFallback();
    }
  }
  frame.addEventListener("load", onLoad);
  frame.addEventListener("error", showFallback);
  host.append(frame, status);
  return () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(deadline);
    doc.removeEventListener("visibilitychange", watchOpening);
    disconnect?.();
    parent.removeEventListener("hashchange", updateLocation);
    frame.removeEventListener("load", onLoad);
    frame.removeEventListener("error", showFallback);
    frame.remove();
    status.remove();
  };
}
