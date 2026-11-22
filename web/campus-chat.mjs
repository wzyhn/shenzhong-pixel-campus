const endpoint = "/api/campus/chat";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const accountID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const interval = 4_000;
const maxText = 40;
const maxHistory = 30;
const glyphNames = ["挥手", "开心", "笑哭", "喜欢", "大哭", "点赞", "鼓掌", "爱心", "火热", "庆祝", "困了", "思考", "谢谢", "吃面", "晚安", "晴天", "踢球"];

export function normalizeCampusChatText(value) {
  if (typeof value !== "string" || /[\p{Cc}\p{Cs}\u2028-\u202e\u2066-\u2069]/u.test(value)) return "";
  const text = value.trim();
  return /[^\p{Cf}\p{Z}\p{M}]/u.test(text) && Array.from(text).length <= maxText ? text : "";
}

function publicMessage(value) {
  const normalized = normalizeCampusChatText(value?.text);
  if (!uuid.test(value?.id) || typeof value.nickname !== "string" || !value.nickname.trim() ||
      Array.from(value.nickname).length > 24 || !normalized || value.text !== normalized || typeof value.own !== "boolean" ||
      typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))) return null;
  const { id, nickname, text, created_at, own } = value;
  return { id, nickname, text, created_at, own };
}

export function readCampusChatHistory(value) {
  if (!Array.isArray(value?.messages) || value.messages.length > maxHistory) return null;
  const messages = value.messages.map(publicMessage);
  if (messages.includes(null) || new Set(messages.map(row => row.id)).size !== messages.length) return null;
  return messages;
}

export function readCampusChatPublish(value, text) {
  if (value?.status !== "published" && value?.status !== "approved") return null;
  const message = publicMessage(value.message);
  return message?.own && message.text === text ? message : null;
}

export function campusChatKeyboardOffset(innerHeight, innerViewport, frameBottom, outerViewport) {
  const overlap = (bottom, viewport) => Number.isFinite(bottom) && Number.isFinite(viewport?.height) &&
    Number.isFinite(viewport.offsetTop) && viewport.height > 0
    ? bottom - viewport.height - viewport.offsetTop : 0;
  return Math.round(Math.min(Math.max(innerHeight - 76, 0), Math.max(0,
    overlap(innerHeight, innerViewport), overlap(frameBottom, outerViewport))));
}

export function campusEmojiTrayPosition(view, player, frame, stage, tray) {
  if (!view || !player || !(view.w > 0 && view.h > 0 && view.zoom > 0) || !(tray.width > 0 && tray.height > 0)) return null;
  const scaleX = frame.width / view.w;
  const scaleY = frame.height / view.h;
  const center = frame.left - stage.left + (player.x * 32 - view.x) * view.zoom * scaleX;
  const foot = frame.top - stage.top + (player.y * 32 - view.y) * view.zoom * scaleY;
  const above = foot - 24 * view.zoom * scaleY - tray.height - 10;
  const left = center - tray.width / 2;
  const clamp = (value, end) => Math.round(Math.max(8, Math.min(value, end - 8)));
  return { x: clamp(left, stage.width - tray.width), y: clamp(above >= 8 ? above : foot + 12, stage.height - tray.height) };
}

export function createCampusChatViewportScheduler(window, measure) {
  let frame = null;
  return {
    request() {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    },
    cancel() {
      if (frame === null) return;
      window.cancelAnimationFrame(frame);
      frame = null;
    },
  };
}

function createElement(doc, name, className, content) {
  const element = doc.createElement(name);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function createButton(doc, text, className = "campus-chat-button") {
  const button = createElement(doc, "button", className, text);
  button.type = "button";
  return button;
}

export function connectCampusChat(child, { identity, fetcher = globalThis.fetch.bind(globalThis) }) {
  const doc = child.document;
  const stage = doc.getElementById("ppStage");
  const game = child.PPGame;
  const scope = identity.current()?.user?.id;
  if (!stage || !game || !accountID.test(scope)) throw new TypeError("Campus chat needs the verified current campus");

  const cleanup = [];
  const pendingRequests = new Set();
  let disposed = false;
  let ready = false;
  let modal = false;
  let active = "";
  let trigger;
  let messages = [];
  let busy = false;
  let composing = false;
  let mutationEpoch = 0;
  let readEpoch = 0;
  let timer;
  let confirmation;
  let attempt;
  let lastRead;
  let stylesheetRequest;
  let historyLoaded = false;
  let feedMessage;
  let backendState = "loading";
  let composerFeedback = "";
  let lastView;
  let emojiGeometry;
  let emojiTransform = "";
  let focusEmoji = false;
  const authorized = () => !disposed && identity.current()?.user?.id === scope;
  const hudHidden = () => doc.body.classList.contains("clean") || doc.body.classList.contains("campus-hud-hidden");

  const style = createElement(doc, "style");
  const viewportScheduler = createCampusChatViewportScheduler(child, measureViewport);
  const ui = createElement(doc, "div", "campus-chat-layer campus-chat-ui");
  ui.hidden = true;
  const top = createElement(doc, "section", "campus-chat-top");
  const surface = createElement(doc, "div", "campus-chat-feed-surface");
  const indicator = createElement(doc, "span", "campus-chat-indicator");
  indicator.setAttribute("aria-hidden", "true");
  indicator.innerHTML = child.PPTD?.icon("chat") || "";
  const open = createButton(doc, undefined, "campus-chat-feed-open");
  open.setAttribute("aria-label", "公屏聊天");
  open.setAttribute("aria-controls", "campus-chat-composer");
  open.setAttribute("aria-expanded", "false");
  const feed = createElement(doc, "ol", "campus-chat-feed");
  feed.id = "campus-chat-feed";
  feed.dataset.campusCapture = "public-chat";
  feed.setAttribute("aria-label", "公屏消息");
  feed.setAttribute("aria-live", "polite");
  feed.hidden = true;
  const empty = createElement(doc, "span", "campus-chat-feed-prompt", "说句话…");
  empty.setAttribute("aria-hidden", "true");
  surface.append(indicator, feed, empty, open);
  top.append(surface);

  const panel = createElement(doc, "div", "campus-chat-panel");
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "公屏聊天");
  const composer = createElement(doc, "section", "campus-chat-section");
  composer.id = "campus-chat-composer";
  const composerTools = createElement(doc, "div", "campus-chat-tools");
  const composerTitle = createElement(doc, "strong", "", "公屏聊天");
  const openHistory = createButton(doc, "聊天记录");
  const closeComposer = createButton(doc, "收起", "campus-chat-button campus-chat-close");
  composerTools.append(composerTitle, openHistory, closeComposer);
  const form = createElement(doc, "form", "campus-chat-form");
  const input = createElement(doc, "input", "campus-chat-input");
  input.type = "text";
  input.placeholder = "跟在场的同学说点什么";
  input.setAttribute("aria-label", "校园公屏消息");
  input.setAttribute("enterkeyhint", "send");
  input.setAttribute("autocomplete", "off");
  const submit = createButton(doc, "发送", "campus-chat-button campus-chat-send");
  submit.type = "submit";
  submit.disabled = true;
  form.append(input, submit);
  const feedback = createElement(doc, "p", "campus-chat-feedback");
  feedback.setAttribute("role", "status");
  feedback.hidden = true;
  composer.append(composerTools, form, feedback);

  const emoji = createElement(doc, "section", "campus-chat-section campus-chat-emoji-tray");
  emoji.id = "campus-chat-emoji";
  emoji.hidden = true;
  emoji.setAttribute("aria-label", "校园表情");
  const emojiTools = createElement(doc, "div", "campus-chat-tools");
  const closeEmoji = createButton(doc, "收起", "campus-chat-button campus-chat-close");
  emojiTools.append(createElement(doc, "strong", "", "校园表情"), closeEmoji);
  const emojiGrid = createElement(doc, "div", "campus-chat-emoji-grid");
  Array.from(game.emotes || []).forEach((glyph, index) => {
    const button = createButton(doc, glyph, "campus-chat-button campus-chat-emoji-button");
    button.setAttribute("aria-label", `发送${glyphNames[index] || glyph}`);
    button.addEventListener("click", () => {
      if (authorized() && game.react(glyph)) setPanel("", trigger);
    });
    emojiGrid.append(button);
  });
  emoji.append(emojiTools, emojiGrid);

  const history = createElement(doc, "section", "campus-chat-section");
  history.id = "campus-chat-history";
  const historyTools = createElement(doc, "div", "campus-chat-tools");
  const back = createButton(doc, "返回聊天", "campus-chat-button campus-chat-close");
  historyTools.append(createElement(doc, "strong", "", "聊天记录"), back);
  const historyState = createElement(doc, "p", "campus-chat-history-state", "正在读取聊天记录…");
  historyState.setAttribute("role", "status");
  const historyList = createElement(doc, "ol", "campus-chat-history");
  historyList.setAttribute("aria-label", "最近公开消息");
  history.append(historyTools, historyState, historyList);
  panel.append(composer, history);
  ui.append(top, panel, emoji);

  const stockChat = doc.getElementById("pp-chat");
  const stockEmoji = doc.getElementById("pp-emotes");
  const stick = doc.getElementById("stick");
  const mapCanvas = doc.getElementById("game");
  const clock = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const listen = (target, name, callback, options) => {
    if (!target) return;
    target.addEventListener(name, callback, options);
    cleanup.push(() => target.removeEventListener(name, callback, options));
  };

  function updateViewport() {
    if (!disposed && ready) viewportScheduler.request();
  }

  function measureViewport() {
    if (disposed || !ready) return;
    const offset = campusChatKeyboardOffset(child.innerHeight, child.visualViewport,
      child.frameElement?.getBoundingClientRect().bottom, child.parent?.visualViewport);
    const stageRect = stage.getBoundingClientRect();
    const joystick = stick?.getBoundingClientRect();
    const showStick = joystick?.width && joystick.height;
    if (active === "emoji") {
      emojiGeometry = { stage: stageRect, frame: mapCanvas?.getBoundingClientRect() || stageRect, tray: { width: emoji.offsetWidth, height: emoji.offsetHeight } };
    }
    setStyle("--campus-chat-keyboard", `${offset}px`);
    setStyle("--campus-emoji-left", showStick ? `${Math.round(joystick.right - stageRect.left + 10)}px` : "");
    setStyle("--campus-emoji-bottom", showStick ? `${Math.round(stageRect.bottom - joystick.bottom)}px` : "");
    placeEmoji();
  }

  function setStyle(name, value) {
    if (ui.style.getPropertyValue(name) === value) return;
    if (value) ui.style.setProperty(name, value);
    else ui.style.removeProperty(name);
  }

  function placeEmoji() {
    if (active !== "emoji" || !emojiGeometry || !lastView) return;
    const { frame, stage, tray } = emojiGeometry;
    const position = campusEmojiTrayPosition(lastView, child.__ppEngine?.state?.(), frame, stage, tray);
    if (!position) return;
    const transform = `translate(${position.x}px, ${position.y}px)`;
    if (transform !== emojiTransform) {
      emoji.style.transform = transform;
      emojiTransform = transform;
    }
    if (focusEmoji) {
      emoji.style.visibility = "visible";
      focusEmoji = false;
      (emojiGrid.querySelector("button") || closeEmoji).focus({ preventScroll: true });
    }
  }

  function syncComposer() {
    const length = Array.from(input.value.trim()).length;
    const closed = backendState === "closed";
    input.readOnly = closed;
    submit.disabled = busy || composing || closed || !normalizeCampusChatText(input.value) || !authorized();
    submit.textContent = busy ? "正在发送" : "发送";
    const availability = closed ? "公屏聊天暂不可用，草稿会保留。" :
      backendState === "offline" ? "暂时无法读取公屏，可以继续编辑。" : "";
    feedback.textContent = composerFeedback || (length > maxText ? `最多 ${maxText} 字` : availability);
    feedback.hidden = !feedback.textContent;
  }

  function announce(text = "") {
    composerFeedback = text;
    syncComposer();
  }

  function setBackendState(next) {
    if (backendState === next) return false;
    backendState = next;
    const unavailable = next === "closed" || next === "offline";
    surface.toggleAttribute("data-unavailable", unavailable);
    empty.textContent = unavailable ? "暂不可用" : "说句话…";
    syncComposer();
    return true;
  }

  function setPanel(next, source) {
    if (next && (!ready || !authorized() || hudHidden())) return;
    if (next && (!active || next === "emoji" || active === "emoji")) trigger = source;
    const needsModal = next === "compose" || next === "history";
    if (needsModal !== modal) {
      modal = needsModal;
      game.setModal?.(modal);
    }
    if (active === "compose" && next !== active) {
      input.blur();
      composing = false;
    }
    if (next === "emoji" && active !== "emoji") {
      focusEmoji = true;
      emoji.style.visibility = "hidden";
    }
    active = next;
    panel.hidden = !needsModal;
    composer.hidden = active !== "compose";
    emoji.hidden = active !== "emoji";
    history.hidden = active !== "history";
    ui.dataset.campusChatPanel = active;
    open.setAttribute("aria-expanded", String(active === "compose"));
    stockEmoji?.setAttribute("aria-expanded", String(active === "emoji"));
    if (active === "compose") input.focus({ preventScroll: true });
    if (active === "history") {
      confirmation = undefined;
      renderHistory();
      back.focus({ preventScroll: true });
      void refresh();
    }
    if (!active) source?.focus({ preventScroll: true });
    updateViewport();
  }

  function rowOf(message, privateControls = false) {
    const row = createElement(doc, "li", "campus-chat-row");
    row.dataset.messageId = message.id;
    const author = createElement(doc, "b", "campus-chat-author", message.nickname);
    const text = createElement(doc, "span", "campus-chat-message", message.text);
    if (!privateControls) {
      row.append(author, text);
      return row;
    }
    const header = createElement(doc, "div", "campus-chat-history-head");
    const time = createElement(doc, "time", "", clock.format(new Date(message.created_at)));
    time.dateTime = message.created_at;
    header.append(author, time);
    if (message.own) {
      const remove = createButton(doc, confirmation === message.id ? "确认撤回" : "撤回", "campus-chat-button campus-chat-revoke");
      remove.disabled = busy;
      remove.addEventListener("click", () => {
        if (confirmation === message.id) void revoke(message.id);
        else {
          confirmation = message.id;
          renderHistory();
          historyList.querySelector(`[data-message-id="${message.id}"] button`)?.focus({ preventScroll: true });
        }
      });
      header.append(remove);
    }
    row.append(header, text);
    return row;
  }

  function renderHistory() {
    if (active !== "history") return;
    const focused = doc.activeElement;
    const focusId = historyList.contains(focused) ? focused.closest("[data-message-id]")?.dataset.messageId : undefined;
    const scroll = historyList.scrollTop;
    historyList.replaceChildren(...messages.slice().reverse().map(message => rowOf(message, true)));
    historyList.scrollTop = scroll;
    if (focusId) {
      const replacement = historyList.querySelector(`[data-message-id="${focusId}"] button:not(:disabled)`);
      (replacement || back).focus({ preventScroll: true });
    }
    const label = backendState === "offline" ? "暂时无法读取聊天记录，请稍后重试。" :
      backendState === "closed" ? "公屏聊天暂未开放。" : messages.length ? "最近 30 条公开消息" :
      historyLoaded ? "暂无公开消息" : "正在读取聊天记录…";
    historyState.textContent = label;
  }

  function renderFeed() {
    feedMessage = messages.at(-1);
    feed.replaceChildren(...(feedMessage ? [rowOf(feedMessage)] : []));
    feed.hidden = !feedMessage;
    empty.hidden = Boolean(feedMessage);
  }

  function setMessages(rows) {
    if (JSON.stringify(rows) === JSON.stringify(messages)) return false;
    messages = rows;
    renderFeed();
    renderHistory();
    return true;
  }

  async function request(path = endpoint, method = "GET", body) {
    if (!authorized()) return null;
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 9_000);
    pendingRequests.add(controller);
    try {
      const response = await fetcher(path, {
        method, credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { "X-Campus-User-ID": scope, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json().catch(() => null);
      return authorized() ? { ok: response.ok, status: response.status, data } : null;
    } catch {
      return authorized() ? { ok: false, status: 0, data: null } : null;
    } finally {
      globalThis.clearTimeout(timeout);
      pendingRequests.delete(controller);
    }
  }

  async function refresh() {
    if (!authorized() || busy || lastRead === mutationEpoch || doc.hidden) return;
    const epoch = mutationEpoch;
    const read = ++readEpoch;
    lastRead = epoch;
    try {
      const response = await request();
      if (!response || read !== readEpoch || epoch !== mutationEpoch) return;
      const rows = response.ok && readCampusChatHistory(response.data);
      const changed = setBackendState(rows ? "open" : response.data?.error === "chat_unavailable" ? "closed" : "offline");
      if (rows) historyLoaded = true;
      if (rows && setMessages(rows)) return;
      if (response.status === 401 || response.status === 403 || backendState === "closed") setMessages([]);
      if (changed || !historyList.childElementCount) renderHistory();
    } finally {
      if (lastRead === epoch) lastRead = undefined;
    }
  }

  async function send() {
    if (busy || composing || backendState === "closed" || !authorized()) return;
    const text = normalizeCampusChatText(input.value);
    if (!text) return;
    if (!attempt || attempt.text !== text) attempt = { requestId: child.crypto.randomUUID(), text };
    const sent = attempt;
    busy = true;
    mutationEpoch++;
    announce("正在发送…");
    try {
      const response = await request(endpoint, "POST", { requestId: sent.requestId, text });
      if (!response) return;
      const message = response.status === 200 && readCampusChatPublish(response.data, text);
      if (message) {
        const rows = [...messages.filter(row => row.id !== message.id), message];
        rows.sort((first, last) => Date.parse(first.created_at) - Date.parse(last.created_at));
        setMessages(rows.slice(-maxHistory));
        if (normalizeCampusChatText(input.value) === text) input.value = "";
        attempt = undefined;
        announce("已发送至公屏");
      } else if (response.status === 200 && response.data?.status === "revoked") {
        attempt = undefined;
        if (normalizeCampusChatText(input.value) === text) input.value = "";
        announce("这条消息已经撤回。");
      } else {
        if (response.status === 409) attempt = undefined;
        if (response.data?.error === "chat_unavailable") {
          setBackendState("closed");
          setMessages([]);
        }
        announce(response.data?.error === "chat_unavailable" ? "公屏聊天暂未开放，内容已保留。" :
          response.status === 429 ? "发送过快，内容已保留。" :
          response.status === 401 || response.status === 403 ? "登录状态已变化，请重新进入校园。" : "暂时无法发送，内容已保留。");
      }
    } finally {
      if (authorized()) {
        busy = false;
        syncComposer();
        renderHistory();
        void refresh();
      }
    }
  }

  async function revoke(id) {
    if (busy || !authorized() || !messages.some(row => row.id === id && row.own)) return;
    busy = true;
    mutationEpoch++;
    confirmation = undefined;
    renderHistory();
    try {
      const response = await request(`${endpoint}/${id}`, "DELETE");
      if (!response) return;
      if (response.ok && response.data?.revoked === true) {
        setMessages(messages.filter(row => row.id !== id));
        historyState.textContent = "已撤回这条消息。";
      } else historyState.textContent = "暂时无法撤回，请稍后重试。";
    } finally {
      if (authorized()) {
        busy = false;
        for (const button of historyList.querySelectorAll("button")) button.disabled = false;
        void refresh();
      }
    }
  }

  function replaceAction(object, name, action) {
    if (!object) return;
    const original = object[name];
    object[name] = action;
    cleanup.push(() => { if (object[name] === action) object[name] = original; });
  }

  function openCompose(source = open) { setPanel("compose", source); }
  function openEmoji(source = stockEmoji) { setPanel(active === "emoji" ? "" : "emoji", source); }
  open.addEventListener("click", () => { if (modal) setPanel("", open); else openCompose(open); });
  openHistory.addEventListener("click", () => setPanel("history", openHistory));
  closeComposer.addEventListener("click", () => setPanel("", trigger));
  closeEmoji.addEventListener("click", () => setPanel("", trigger));
  back.addEventListener("click", () => openCompose());
  form.addEventListener("submit", event => { event.preventDefault(); void send(); });
  submit.addEventListener("pointerdown", event => event.preventDefault());
  input.addEventListener("compositionstart", () => { composing = true; syncComposer(); });
  input.addEventListener("compositionend", () => { composing = false; announce(); });
  input.addEventListener("input", () => {
    if (attempt && !busy && normalizeCampusChatText(input.value) !== attempt.text) attempt = undefined;
    if (!busy) announce();
    else syncComposer();
  });

  // Replace the exact child controls before revealing the stage. Its stock text path is local-only.
  replaceAction(stockChat, "onclick", () => openCompose(stockChat));
  replaceAction(stockEmoji, "onclick", () => openEmoji(stockEmoji));
  replaceAction(game, "openChat", () => openCompose());
  replaceAction(game, "openEmotes", () => openEmoji());
  replaceAction(game, "openHistory", () => setPanel("history", open));
  const presence = child.PPPresence;
  const drawLabels = presence?.drawLabels;
  if (typeof drawLabels === "function") {
    replaceAction(presence, "drawLabels", function (...args) {
      lastView = args[1];
      if (hudHidden()) return undefined;
      const result = Reflect.apply(drawLabels, this, args);
      placeEmoji();
      return result;
    });
  }
  listen(doc, "click", event => {
    if (modal && !panel.contains(event.target) && !open.contains(event.target)) setPanel("");
  }, true);
  listen(child, "keydown", event => {
    if (event.key === "Enter" && event.target === input && (composing || event.isComposing || event.keyCode === 229)) {
      event.stopImmediatePropagation();
      return;
    }
    if (event.key === "Escape" && active && !event.isComposing && !composing) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setPanel("", trigger);
      return;
    }
    if (event.key === "Tab" && modal && !event.isComposing && !composing) {
      const controls = [...panel.querySelectorAll("button,input")].filter(control =>
        !control.disabled && control.getClientRects().length);
      const first = controls[0];
      const last = controls.at(-1);
      const focused = doc.activeElement;
      if (!panel.contains(focused) || focused === (event.shiftKey ? first : last)) {
        const target = event.shiftKey ? last : first;
        if (target) {
          event.preventDefault();
          event.stopImmediatePropagation();
          target.focus({ preventScroll: true });
          return;
        }
      }
    }
    if (ready && !active && !child.ppBlocksMove && !hudHidden() && !event.altKey && !event.ctrlKey && !event.metaKey &&
        event.key.toLowerCase() === "t" && !event.target?.matches?.("input,textarea,[contenteditable]")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openCompose();
    }
  }, true);
  listen(child, "pp:scene-change", () => setPanel(""));
  listen(child, "campus:hide-hud", () => setPanel(""));
  listen(doc, "campus:hide-hud", () => setPanel(""));
  const cleanObserver = new child.MutationObserver(() => {
    if (active && hudHidden()) setPanel("");
  });
  cleanObserver.observe(doc.body, { attributes: true, attributeFilter: ["class"] });
  cleanup.push(() => cleanObserver.disconnect());
  listen(doc, "visibilitychange", () => { if (!doc.hidden) void refresh(); });
  const viewports = new Set([child, child.visualViewport, child.parent?.visualViewport]);
  for (const viewport of viewports) {
    listen(viewport, "resize", updateViewport);
    listen(viewport, "scroll", updateViewport);
  }
  const unsubscribe = identity.subscribe?.(() => { if (!authorized()) destroy(); });
  if (unsubscribe) cleanup.push(unsubscribe);

  const styled = (async () => {
    try {
      stylesheetRequest = new AbortController();
      const response = await fetcher(new URL("./campus-chat.css", import.meta.url), {
        credentials: "same-origin", signal: stylesheetRequest.signal,
      });
      if (!response.ok) throw new Error("Unable to load campus chat styles");
      const css = await response.text();
      if (!authorized()) return false;
      style.textContent = css;
      doc.head.append(style);
      stage.classList.add("campus-chat-active");
      if (stockEmoji) {
        const parent = stockEmoji.parentNode;
        const next = stockEmoji.nextSibling;
        const controls = stockEmoji.getAttribute("aria-controls");
        const expanded = stockEmoji.getAttribute("aria-expanded");
        stockEmoji.classList.add("campus-chat-button", "campus-chat-emoji-trigger");
        stockEmoji.setAttribute("aria-controls", emoji.id);
        stockEmoji.setAttribute("aria-expanded", "false");
        ui.append(stockEmoji);
        cleanup.push(() => {
          stockEmoji.classList.remove("campus-chat-button", "campus-chat-emoji-trigger");
          if (controls === null) stockEmoji.removeAttribute("aria-controls");
          else stockEmoji.setAttribute("aria-controls", controls);
          if (expanded === null) stockEmoji.removeAttribute("aria-expanded");
          else stockEmoji.setAttribute("aria-expanded", expanded);
          parent.insertBefore(stockEmoji, next);
        });
      }
      stage.append(ui);
      ready = true;
      ui.hidden = false;
      if (typeof child.ResizeObserver === "function") {
        const observer = new child.ResizeObserver(updateViewport);
        observer.observe(stage);
        if (stick) observer.observe(stick);
        cleanup.push(() => observer.disconnect());
      }
      updateViewport();
      timer = globalThis.setInterval(() => {
        if (authorized() && !doc.hidden) void refresh();
      }, interval);
      void refresh();
      return true;
    } catch {
      if (authorized() && stockChat) {
        stockChat.disabled = true;
        stockChat.title = "公屏聊天暂未载入";
      }
      return false;
    }
  })();

  function getVisibleOverlay() {
    if (!authorized() || !ready || hudHidden() || feed.hidden || !feedMessage) return null;
    const bounds = surface.getBoundingClientRect();
    if (!bounds.width || !bounds.height || child.getComputedStyle(feed).visibility !== "visible") return null;
    const rect = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    const { nickname, text } = feedMessage;
    return { rect, rows: [{ nickname, text }] };
  }

  function destroy() {
    if (disposed) return;
    disposed = true;
    ready = false;
    setPanel("");
    viewportScheduler.cancel();
    stylesheetRequest?.abort();
    globalThis.clearInterval(timer);
    for (const controller of pendingRequests) controller.abort();
    for (const remove of cleanup) remove();
    stage.classList.remove("campus-chat-active");
    style.remove();
    ui.remove();
  }

  return { ready: styled, destroy, getVisibleOverlay, updateViewport };
}
