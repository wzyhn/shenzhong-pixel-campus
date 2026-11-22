import { connectCampusFloatingStick } from "./campus-floating-stick.mjs";

const movement = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ShiftLeft",
  "ShiftRight",
]);

const weather = [
  ["day", "晴天", "sun"],
  ["night", "夜晚", "moon"],
  ["rain", "下雨", "rain"],
  ["snow", "下雪", "weather"],
];

export function isCampusResizeDeliveryError(message) {
  return (
    message === "ResizeObserver loop completed with undelivered notifications." ||
    message === "ResizeObserver loop limit exceeded"
  );
}

export function keepCampusResizeWarningsInConsole(child) {
  const panel = child.document.getElementById("err");
  let refresh = null;
  function clearWarning() {
    refresh = null;
    const displayed = panel?.textContent.split("\n", 1)[0].replace(/^页面出错了：/, "");
    if (isCampusResizeDeliveryError(displayed)) {
      panel.textContent = "";
      panel.style.display = "none";
    }
  }
  function warning(event) {
    if (!isCampusResizeDeliveryError(event.message)) return;
    event.stopImmediatePropagation();
    if (refresh === null) refresh = child.requestAnimationFrame(clearWarning);
  }
  child.addEventListener("error", warning, true);
  clearWarning();
  return () => {
    child.removeEventListener("error", warning, true);
    if (refresh !== null) child.cancelAnimationFrame(refresh);
  };
}

function connectBlankMapTap(child, blocked, toggle) {
  const canvas = child.document.getElementById("game");
  const presence = child.PPPresence;
  const drawWorld = presence?.drawWorld;
  const actors = [];
  let view, press;
  function recordActors(ctx, drawActor, drawSelf, selfY, x, y, width, height) {
    view = { x, y, width, height };
    actors.length = 0;
    const self = child.__ppEngine.state();
    actors.push(self.x * 32, self.y * 32);
    return drawWorld.call(
      this,
      ctx,
      (px, py, ...args) => {
        actors.push(px, py);
        return drawActor(px, py, ...args);
      },
      drawSelf,
      selfY,
      x,
      y,
      width,
      height,
    );
  }
  if (typeof drawWorld === "function") presence.drawWorld = recordActors;

  function empty(event) {
    if (!canvas || event.target !== canvas) return false;
    const box = canvas.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    if (x < 0.18 || x > 0.82 || y < 0.22 || y > 0.78) return false;
    if (!view?.width || !view.height) return true;
    for (let i = 0; i < actors.length; i += 2) {
      const dx = (x - (actors[i] - view.x) / view.width) * box.width;
      const dy = (y - (actors[i + 1] - view.y) / view.height) * box.height;
      if (Math.abs(dx) < 23 && dy > -43 && dy < 16) return false;
    }
    return true;
  }

  function begin(event) {
    if (!event.isTrusted) return;
    if (!event.isPrimary || event.button !== 0 || blocked() || !empty(event)) {
      press = undefined;
      return;
    }
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp };
  }

  function move(event) {
    if (
      press?.id === event.pointerId &&
      Math.hypot(press.x - event.clientX, press.y - event.clientY) > 9
    )
      press = undefined;
  }

  function end(event) {
    if (!event.isTrusted) return;
    const began = press;
    press = undefined;
    if (
      began?.id !== event.pointerId ||
      event.timeStamp - began.time > 420 ||
      Math.hypot(began.x - event.clientX, began.y - event.clientY) > 9 ||
      blocked() ||
      !empty(event)
    )
      return;
    toggle();
  }

  function cancel() {
    press = undefined;
  }
  const events = {
    pointerdown: begin,
    pointermove: move,
    pointerup: end,
    pointercancel: cancel,
    blur: cancel,
  };
  for (const [name, listener] of Object.entries(events))
    child.addEventListener(name, listener, true);
  return () => {
    for (const [name, listener] of Object.entries(events))
      child.removeEventListener(name, listener, true);
    if (presence?.drawWorld === recordActors) presence.drawWorld = drawWorld;
  };
}

export function connectCampusQuickControls(child, bgm, toggleEffects) {
  const doc = child.document;
  const chrome = doc.getElementById("ppChrome");
  const stage = doc.getElementById("ppStage");
  const activities = chrome?.querySelector(".pp-activities");
  const run = doc.getElementById("pp-run");
  const camera = doc.getElementById("pp-camera");
  const menu = doc.getElementById("pp-menu");
  if (!stage || !activities || !run || !camera || !menu) return () => {};
  const originalRunSlot = doc.createComment("campus run position");
  const originalMenuSlot = doc.createComment("campus-menu-position");
  run.before(originalRunSlot);
  menu.before(originalMenuSlot);
  const actions = doc.createElement("div");
  actions.className = "campus-activity-strip";
  actions.setAttribute("role", "group");
  actions.setAttribute("aria-label", "漫游工具");
  const panel = doc.createElement("div");
  panel.className = "campus-quick-panel";
  panel.id = "campus-quick-options";
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "天气和声音");
  panel.hidden = true;
  const sound = doc.createElement("div");
  sound.className = "campus-sound-options";
  const climates = doc.createElement("div");
  climates.id = "campus-weather-options";
  climates.className = "campus-weather-options";
  panel.append(sound, climates);

  function button(label, icon, run, showLabel = false) {
    const control = doc.createElement("button");
    control.type = "button";
    control.setAttribute("aria-label", label);
    control.title = label;
    control.innerHTML = child.PPTD.icon(icon);
    if (showLabel) {
      const name = doc.createElement("span");
      name.textContent = label;
      control.append(name);
    }
    control.addEventListener("click", run);
    return control;
  }

  const music = button(
    "校园音乐",
    "music",
    () => void bgm.setEnabled(!bgm.getState().enabled),
    true,
  );
  const effects = button(
    "动作音效",
    "sound",
    () => {
      toggleEffects?.();
      syncEffects();
    },
    true,
  );
  const settings = button("天气和声音", "weather", () => setOpen(panel.hidden));
  settings.id = "campus-audio-weather";
  settings.setAttribute("aria-controls", panel.id);
  settings.setAttribute("aria-expanded", "false");
  sound.append(music, effects);
  const choices = weather.map(([value, label, icon]) => {
    const option = button(
      label,
      icon,
      () => {
        child.__ppEngine.setNameEggWeather(value);
        child.PPAudio?.weather(value === "rain");
        child.__ppEngine.save?.();
        syncWeather();
        setOpen(false);
        settings.focus({ preventScroll: true });
      },
      true,
    );
    climates.append(option);
    return [value, option];
  });
  actions.append(run, settings, menu);
  activities.append(actions, camera, panel);
  function toggleHud() {
    if (doc.body.classList.contains("campus-hud-hidden")) {
      doc.body.classList.remove("campus-hud-hidden");
    } else {
      setOpen(false);
      child.dispatchEvent(new child.CustomEvent("campus:hide-hud"));
      doc.body.classList.add("campus-hud-hidden");
    }
  }

  const closeTap = connectBlankMapTap(
    child,
    () =>
      !child.PPGame?.isEntered() ||
      child.ppBlocksMove ||
      !panel.hidden ||
      Boolean(
        doc.querySelector(
          "#campus-author-contact:not([hidden]), #campus-chat-emoji:not([hidden]), .campus-position-settings",
        ),
      ),
    toggleHud,
  );
  const closeStick = connectCampusFloatingStick(child);

  const stockHide = new child.MutationObserver(() => {
    if (!doc.body.classList.contains("clean")) return;
    doc.body.classList.remove("clean");
    toggleHud();
  });
  stockHide.observe(doc.body, { attributes: true, attributeFilter: ["class"] });

  function syncEffects() {
    const state = child.PPAudio?.state?.();
    effects.setAttribute("aria-pressed", String(Boolean(state?.effects && !state.muted)));
  }

  let displayedWeather;
  function syncWeather() {
    const selected = child.__ppEngine.state().light;
    const current = weather.find(([value]) => value === selected);
    if (!current || selected === displayedWeather) return;
    displayedWeather = selected;
    const [, label] = current;
    settings.setAttribute("aria-label", `天气和声音，${label}`);
    settings.title = `天气和声音 · ${label}`;
  }

  function setOpen(open) {
    panel.hidden = !open;
    settings.setAttribute("aria-expanded", String(open));
    if (open) {
      syncWeather();
      const selected = child.__ppEngine.state().light;
      for (const [value, option] of choices)
        option.setAttribute("aria-pressed", String(value === selected));
      music.focus({ preventScroll: true });
    }
  }

  function outside(event) {
    if (!panel.hidden && event.target !== settings && !settings.contains(event.target) && !panel.contains(event.target))
      setOpen(false);
  }

  function onKey(event) {
    if (event.key === "Tab" && event.shiftKey && !panel.hidden && doc.activeElement === music) {
      event.preventDefault();
      setOpen(false);
      settings.focus({ preventScroll: true });
      return;
    }
    if (event.key !== "Escape") return;
    if (doc.body.classList.contains("campus-hud-hidden") && !child.ppBlocksMove) toggleHud();
    else if (!panel.hidden) {
      setOpen(false);
      settings.focus({ preventScroll: true });
    } else return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function watchProfileClose() {
    // The native menu removes the profile item before opening the profile.
    const profile = doc.getElementById("pp-identity");
    if (profile && !profile.hidden)
      profileFocus.observe(profile, { attributes: true, attributeFilter: ["hidden"] });
  }
  const profileFocus = new child.MutationObserver(([change]) => {
    const profile = change.target;
    if (!profile.hidden) return;
    profileFocus.disconnect();
    const active = doc.activeElement;
    const lostFocus = active === doc.body || !active?.getClientRects().length || profile.contains(active);
    if (!child.ppBlocksMove && lostFocus && menu.getClientRects().length)
      menu.focus({ preventScroll: true });
  });

  function resume(event) {
    if (!event.isTrusted || event.altKey || event.ctrlKey || event.metaKey) return;
    // Touch and pen activate media playback on release, while mice activate on press.
    if (event.type === "pointerdown" && event.pointerType !== "mouse") return;
    if (event.type === "pointerup" && event.pointerType === "mouse") return;
    void bgm.resumeAfterGesture();
  }

  const unsubscribe = bgm.subscribe(({ enabled, status }) => {
    music.setAttribute("aria-pressed", String(enabled));
    music.title =
      status === "blocked"
        ? "校园音乐已开启，点击画面播放"
        : enabled
          ? "关闭校园音乐"
          : "开启校园音乐";
  });
  syncEffects();
  syncWeather();
  doc.addEventListener("pointerdown", outside, true);
  doc.addEventListener("focusin", outside, true);
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("click", syncEffects);
  child.addEventListener("pointerdown", resume, true);
  child.addEventListener("pointerup", resume, true);
  child.addEventListener("keydown", resume, true);
  child.addEventListener("pp:entered", syncWeather);
  child.addEventListener("pp:principal-change", syncWeather);
  child.addEventListener("pp:profile", watchProfileClose);
  return () => {
    unsubscribe();
    closeStick();
    closeTap();
    stockHide.disconnect();
    profileFocus.disconnect();
    doc.removeEventListener("pointerdown", outside, true);
    doc.removeEventListener("focusin", outside, true);
    doc.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("click", syncEffects);
    child.removeEventListener("pointerdown", resume, true);
    child.removeEventListener("pointerup", resume, true);
    child.removeEventListener("keydown", resume, true);
    child.removeEventListener("pp:entered", syncWeather);
    child.removeEventListener("pp:principal-change", syncWeather);
    child.removeEventListener("pp:profile", watchProfileClose);
    originalRunSlot.replaceWith(run);
    originalMenuSlot.replaceWith(menu);
    actions.remove();
    panel.remove();
    doc.body.classList.remove("campus-hud-hidden");
  };
}

export function connectCampusHud(child, frame) {
  const doc = child.document;
  const parent = frame.ownerDocument.defaultView;
  const card = doc.getElementById("ppPeople");
  const settings = card?.querySelector(".prs-aux");
  const desktop = parent.matchMedia("(hover: hover) and (pointer: fine)");
  const rosterButton = doc.getElementById("pp-roster");
  const place = doc.getElementById("pp-location");
  const top = place?.closest(".pp-top");
  const returnHome = doc.getElementById("pp-back-home");
  const moved = [];
  let restoreMiniMap;
  if (place && doc.getElementById("pp-place")) {
    place.setAttribute("aria-labelledby", "pp-place");
    place.setAttribute("aria-description", "打开校园全图");
  }
  if (
    top &&
    card &&
    returnHome &&
    card.parentElement === top.parentElement &&
    returnHome.parentElement === top.parentElement
  ) {
    for (const element of [card, returnHome]) {
      const slot = doc.createComment("campus status order");
      element.before(slot);
      moved.push([element, slot]);
    }
    top.after(card, returnHome);
  }
  let deadline;
  const stylesheet = new AbortController();
  const inserted = [];
  const loadStyles = Promise.allSettled(
    ["/campus-hud.css", "/campus-mobile.css"].map(async (url) => {
      // Keep cascade order even when the two requests finish out of order.
      const style = doc.createElement("style");
      doc.head.append(style);
      inserted.push(style);
      const response = await fetch(url, { credentials: "same-origin", signal: stylesheet.signal });
      if (!response.ok) throw new Error("Campus settings stylesheet unavailable");
      const contents = await response.text();
      if (!stylesheet.signal.aborted) style.textContent = contents;
    }),
  );
  const css = Promise.race([
    loadStyles,
    new Promise((resolve) => { deadline = setTimeout(resolve, 2500); }),
  ]).finally(() => clearTimeout(deadline));

  function positionAction() {
    return [...(settings?.querySelectorAll(".prs-miniact") || [])].find((button) =>
      /^位置(?:可见|隐藏)/.test(button.textContent),
    );
  }

  function closeSettings() {
    if (!positionAction()) return false;
    card.querySelector('[data-person="self"]')?.click();
    return true;
  }

  function decorateSettings() {
    const action = positionAction();
    if (!action || action.parentElement.classList.contains("campus-position-settings")) return;
    const row = doc.createElement("div");
    row.className = "campus-position-settings";
    const close = doc.createElement("button");
    close.type = "button";
    close.className = "campus-position-close";
    close.textContent = "关闭";
    close.setAttribute("aria-label", "关闭位置设置");
    close.addEventListener("click", () => {
      if (closeSettings())
        card.querySelector('[data-person="self"]')?.focus({ preventScroll: true });
    });
    action.replaceWith(row);
    row.append(action, close);
  }

  function outside(event) {
    if (!card?.contains(event.target) && !doc.getElementById("pp-roster")?.contains(event.target))
      closeSettings();
  }

  function escape(event) {
    if (event.key === "Escape" && !child.ppBlocksMove && closeSettings()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function sendMovement(event) {
    if (
      !desktop.matches ||
      !movement.has(event.code) ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.isComposing ||
      child.ppBlocksMove ||
      frame.hidden ||
      frame.hasAttribute("aria-busy") ||
      event.target?.closest?.("input,select,textarea,button,[contenteditable]")
    )
      return;
    event.preventDefault();
    child.dispatchEvent(
      new child.KeyboardEvent(event.type, {
        key: event.key,
        code: event.code,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        bubbles: true,
      }),
    );
  }

  const observer = new child.MutationObserver(decorateSettings);
  if (settings) observer.observe(settings, { childList: true });
  decorateSettings();
  doc.addEventListener("pointerdown", outside, true);
  doc.addEventListener("keydown", escape, true);
  parent.addEventListener("keydown", sendMovement);
  parent.addEventListener("keyup", sendMovement);
  return {
    css,
    compactRoster() {
      if (!desktop.matches && rosterButton?.getAttribute("aria-expanded") === "true") rosterButton.click();
    },
    attachQuickMap(open) {
      const canvas = doc.querySelector("#mini #minic");
      if (!canvas || !returnHome || !open || restoreMiniMap) return;
      const slot = doc.createComment("campus mini map position");
      canvas.before(slot);
      const hidden = canvas.getAttribute("aria-hidden");
      canvas.setAttribute("aria-hidden", "true");
      const button = doc.createElement("button");
      button.className = "campus-quick-map";
      button.type = "button";
      button.setAttribute("aria-label", "打开校园全图");
      button.setAttribute("aria-haspopup", "dialog");
      button.append(canvas, "全图");
      button.addEventListener("click", () => open(button));
      returnHome.after(button);
      restoreMiniMap = () => {
        slot.replaceWith(canvas);
        if (hidden == null) canvas.removeAttribute("aria-hidden");
        else canvas.setAttribute("aria-hidden", hidden);
        button.remove();
      };
    },
    focusGame() {
      const active = frame.ownerDocument.activeElement;
      if (desktop.matches && (active === frame.ownerDocument.body || active === frame)) {
        frame.focus({ preventScroll: true });
      }
    },
    destroy() {
      restoreMiniMap?.();
      stylesheet.abort();
      clearTimeout(deadline);
      place?.removeAttribute("aria-labelledby");
      place?.removeAttribute("aria-description");
      for (const [element, slot] of moved) slot.replaceWith(element);
      observer.disconnect();
      for (const style of inserted) style.remove();
      doc.removeEventListener("pointerdown", outside, true);
      doc.removeEventListener("keydown", escape, true);
      parent.removeEventListener("keydown", sendMovement);
      parent.removeEventListener("keyup", sendMovement);
    },
  };
}
