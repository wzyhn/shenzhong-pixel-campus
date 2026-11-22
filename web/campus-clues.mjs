const endpoint = "/api/campus/clues";
const stableID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const choiceID = /^[abc]$/;
const lights = new Set(["day", "night", "rain", "snow"]);
const directions = new Set(["up", "down", "left", "right"]);

function shortText(value, limit) {
  return typeof value === "string" && value === value.trim() && value.length > 0 &&
    Array.from(value).length <= limit && !/[\p{Cc}\p{Cs}\u2028-\u202e\u2066-\u2069]/u.test(value);
}

export function readCampusClue(value, origin) {
  if (typeof value?.id !== "string" || !stableID.test(value.id) || !shortText(value.title, 100) ||
      typeof value.image !== "string" || !Array.isArray(value.choices) || !value.choices.length || value.choices.length > 3) return null;
  let image;
  try { image = new URL(value.image, origin); } catch { return null; }
  if (image.origin !== origin || image.username || image.password || image.hash || !/^https?:$/.test(image.protocol)) return null;
  const choices = [];
  for (const answer of value.choices) {
    if (typeof answer?.id !== "string" || !choiceID.test(answer.id) || !shortText(answer.label, 60) ||
        choices.some(({ id }) => id === answer.id)) return null;
    choices.push({ id: answer.id, label: answer.label });
  }
  return { id: value.id, title: value.title, image: image.href, choices };
}

export function readCampusClueAnswer(value) {
  const place = value?.place;
  if (typeof value?.correct !== "boolean" || typeof place?.id !== "string" || !stableID.test(place.id) ||
      !shortText(place.label, 60) || !lights.has(place.light) || !directions.has(place.facing) ||
      !Number.isFinite(place.zoom) || place.zoom < 1 || place.zoom > 2.6) return null;
  const { id, label, light, zoom, facing } = place;
  return { correct: value.correct, place: { id, label, light, zoom, facing } };
}

export function campusClueShareURL(value, id, origin) {
  if (typeof value !== "string" || typeof id !== "string" || !stableID.test(id)) return null;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.pathname !== "/" || url.hash || url.username || url.password ||
        url.search !== `?clue=${id}`) return null;
    return url.href;
  } catch { return null; }
}

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(doc, text, onClick, kind = "") {
  const control = element(doc, "button", `campus-clue-button${kind ? ` ${kind}` : ""}`, text);
  control.type = "button";
  control.addEventListener("click", onClick);
  return control;
}

export function connectCampusClues(child, { incoming, visit, href, fetcher = globalThis.fetch.bind(globalThis) } = {}) {
  const doc = child.document;
  const stage = doc.getElementById("ppStage");
  const game = child.PPGame;
  const origin = child.location.origin;
  const principal = child.PPIdentity?.current?.()?.principal;
  const authorized = () => !disposed && game?.isEntered?.() && child.PPIdentity?.current?.()?.principal === principal &&
    child.PPIdentity?.authentication?.()?.verifiedSession === true;
  let disposed = false;
  let pending;
  let styled = false;
  let modal = false;
  let question;
  let focusBefore;
  let noticeTimer;
  const stylesheet = new AbortController();
  if (!stage || !principal || !authorized() || typeof visit !== "function" || typeof href !== "function") {
    return { open: async () => false, destroy() {}, ready: Promise.resolve(false) };
  }

  const style = element(doc, "style");
  const overlay = element(doc, "div", "campus-clue-overlay");
  overlay.hidden = true;
  const panel = element(doc, "section", "campus-clue-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "campus-clue-heading");
  const head = element(doc, "header", "campus-clue-head");
  const heading = element(doc, "h2", "", "校园线索");
  heading.id = "campus-clue-heading";
  heading.tabIndex = -1;
  const back = button(doc, "返回线索", () => { void showList(); });
  back.dataset.clueAction = "list";
  back.hidden = true;
  const close = button(doc, "关闭", () => closeDialog(true));
  close.dataset.clueAction = "close";
  close.setAttribute("aria-label", "关闭校园线索");
  head.append(heading, back, close);
  const body = element(doc, "div", "campus-clue-body");
  const status = element(doc, "p", "campus-clue-status");
  status.setAttribute("role", "status");
  status.hidden = true;
  panel.append(head, body, status);
  overlay.append(panel);

  const arrival = element(doc, "section", "campus-clue-arrival");
  arrival.hidden = true;
  arrival.setAttribute("aria-label", "线索到访");
  const arrivalLabel = element(doc, "span", "campus-clue-destination");
  const photo = button(doc, "拍同款", () => {
    const camera = doc.getElementById("pp-camera");
    if (authorized() && !arrival.hidden && camera && !camera.disabled) camera.click();
  }, "campus-clue-primary");
  photo.dataset.clueAction = "photo";
  const continueRoam = button(doc, "继续漫游", () => { arrival.hidden = true; });
  continueRoam.dataset.clueAction = "roam";
  arrival.append(arrivalLabel, photo, continueRoam);

  function say(text = "") {
    status.textContent = text;
    status.hidden = !text;
  }

  function hiddenHud() {
    return doc.body.classList.contains("campus-hud-hidden") || doc.body.classList.contains("clean");
  }

  function showDialog() {
    if (!authorized() || !styled || hiddenHud()) return false;
    if (!modal) {
      focusBefore = doc.activeElement;
      modal = true;
      game.setModal?.(true);
      overlay.hidden = false;
    }
    return true;
  }

  function closeDialog(restoreFocus = false) {
    pending?.abort();
    pending = null;
    if (!modal) return;
    modal = false;
    question = undefined;
    body.replaceChildren();
    overlay.hidden = true;
    game.setModal?.(false);
    if (restoreFocus) {
      const source = focusBefore?.isConnected && focusBefore !== doc.body && focusBefore.getClientRects().length
        ? focusBefore : doc.getElementById("pp-menu");
      source?.focus({ preventScroll: true });
    }
    focusBefore = undefined;
  }

  function setView(title, showBack) {
    heading.textContent = title;
    back.hidden = !showBack;
    body.replaceChildren();
    body.scrollTop = 0;
    say();
    heading.focus({ preventScroll: true });
  }

  async function request(path, data) {
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    const deadline = globalThis.setTimeout(() => controller.abort(), 8_000);
    try {
      const result = await fetcher(path, {
        credentials: "omit", cache: "no-store", signal: controller.signal,
        ...(data ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) } : {}),
      });
      const value = result.ok ? await result.json() : null;
      return pending === controller && modal && authorized() ? { value, status: result.status } : null;
    } catch {
      return pending === controller && modal && authorized() ? { value: null, status: 0 } : null;
    } finally {
      globalThis.clearTimeout(deadline);
      if (pending === controller) pending = null;
    }
  }

  function retry(text, load) {
    say(text);
    body.append(button(doc, "重试", load, "campus-clue-primary"));
  }

  async function showList() {
    if (!showDialog()) return false;
    question = undefined;
    setView("校园线索", false);
    say("正在读取线索…");
    const result = await request(endpoint);
    if (!result) return false;
    const raw = result.value?.clues;
    const rows = Array.isArray(raw) ? raw.map(item => readCampusClue(item, origin)) : null;
    if (!rows || rows.includes(null) || new Set(rows.map(item => item.id)).size !== rows.length) {
      retry("暂时无法读取校园线索。", () => { void showList(); });
      return false;
    }
    if (!rows.length) {
      say("暂时没有校园线索。");
      return true;
    }
    say();
    const list = element(doc, "ul", "campus-clue-list");
    for (const item of rows) {
      const entry = element(doc, "li");
      const link = button(doc, item.title, () => { void showQuestion(item.id); }, "campus-clue-list-button");
      link.dataset.clueId = item.id;
      entry.append(link);
      list.append(entry);
    }
    body.append(list);
    return true;
  }

  async function showQuestion(id) {
    if (typeof id !== "string" || !stableID.test(id) || !showDialog()) return false;
    question = undefined;
    setView("校园线索", true);
    say("正在打开题目…");
    const result = await request(`${endpoint}/${id}`);
    if (!result) return false;
    const item = readCampusClue(result.value?.clue, origin);
    if (!item || item.id !== id) {
      if (result.status === 404) say("这条线索已无法打开。可以返回线索列表。");
      else retry("暂时无法打开这条线索。", () => { void showQuestion(id); });
      return false;
    }
    question = item;
    renderQuestion(item);
    return true;
  }

  function share(item) {
    const url = campusClueShareURL(href(item.id), item.id, origin);
    if (!url || child.PPShare?.sendLink?.(url, item.title) !== true) say("暂时无法分享这条线索。");
  }

  function renderQuestion(item) {
    setView(item.title, true);
    const image = element(doc, "img", "campus-clue-image");
    image.alt = "校园线索图";
    image.decoding = "async";
    const form = element(doc, "form", "campus-clue-form");
    const group = element(doc, "fieldset", "campus-clue-choices");
    group.append(element(doc, "legend", "", "选择一个答案"));
    let selected;
    let pictureReady = false;
    let sending = false;
    for (const choice of item.choices) {
      const label = element(doc, "label", "campus-clue-choice");
      const control = element(doc, "input");
      control.type = "radio";
      control.name = "campus-clue-choice";
      control.value = choice.id;
      const text = element(doc, "span", "", choice.label);
      control.addEventListener("change", () => { selected = choice.id; enabled(); });
      label.append(control, text);
      group.append(label);
    }
    const actions = element(doc, "div", "campus-clue-actions");
    const submit = element(doc, "button", "campus-clue-button campus-clue-primary", "提交答案");
    submit.type = "submit";
    const shareLink = button(doc, "分享题目", () => share(item));
    shareLink.dataset.clueAction = "share";
    actions.append(shareLink, submit);
    form.append(group, actions);
    body.append(image, form);

    function enabled() { submit.disabled = !pictureReady || !selected || sending; }
    image.addEventListener("load", () => {
      if (question !== item || !image.isConnected) return;
      pictureReady = true;
      enabled();
    });
    image.addEventListener("error", () => {
      if (question !== item || !image.isConnected) return;
      image.hidden = true;
      retry("线索图暂时无法加载。", () => { void showQuestion(item.id); });
    });
    image.src = item.image;
    pictureReady = image.complete && image.naturalWidth > 0;
    enabled();
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (sending || !pictureReady || !selected || question !== item || !authorized()) return;
      sending = true;
      group.disabled = true;
      enabled();
      say("正在提交答案…");
      const result = await request(`${endpoint}/${item.id}/answer`, { choice: selected });
      if (!result || question !== item) return;
      sending = false;
      group.disabled = false;
      const answer = readCampusClueAnswer(result.value);
      if (!answer) {
        enabled();
        say("暂时无法提交，保留了你的选择。");
        return;
      }
      renderOutcome(item, answer);
    });
  }

  function renderOutcome(item, answer, showFailure = false) {
    setView(answer.correct ? "答对了" : "这次没猜中", true);
    const description = element(doc, "p", "campus-clue-outcome", `线索地点 · ${answer.place.label}`);
    const actions = element(doc, "div", "campus-clue-actions");
    const go = button(doc, "去现场", () => {
      if (!authorized()) return;
      closeDialog();
      let reached = false;
      try { reached = visit(answer.place) === true; } catch { /* Keep the outcome available for retry. */ }
      if (reached) {
        arrivalLabel.textContent = answer.place.label;
        arrival.hidden = false;
        photo.focus({ preventScroll: true });
      } else if (showDialog()) {
        question = item;
        renderOutcome(item, answer, true);
      }
    }, "campus-clue-primary");
    go.dataset.clueAction = "visit";
    const shareLink = button(doc, "分享题目", () => share(item));
    shareLink.dataset.clueAction = "share";
    actions.append(shareLink, go);
    body.append(description, actions);
    if (showFailure) say("暂时无法到这里，请重试。");
  }

  function keydown(event) {
    if (!modal || event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeDialog(true);
    } else if (event.key === "Tab") {
      const focusable = [...panel.querySelectorAll("button,input")].filter(node => !node.matches(":disabled") && node.getClientRects().length);
      if (!focusable.length) return;
      if (event.shiftKey && (doc.activeElement === focusable[0] || doc.activeElement === heading)) {
        event.preventDefault();
        focusable.at(-1).focus();
      } else if (!event.shiftKey && doc.activeElement === focusable.at(-1)) {
        event.preventDefault();
        focusable[0].focus();
      }
    }
  }

  function clearScene() {
    closeDialog();
    arrival.hidden = true;
  }

  function outside(event) {
    if (event.target === overlay) closeDialog(true);
  }

  function notifyUnavailable() {
    const notice = doc.getElementById("pp-notice");
    if (!notice || !authorized()) return;
    const error = "校园线索暂时无法打开。";
    notice.textContent = error;
    notice.classList.add("on");
    globalThis.clearTimeout(noticeTimer);
    noticeTimer = globalThis.setTimeout(() => {
      if (notice.textContent === error) notice.classList.remove("on");
    }, 2500);
  }

  overlay.addEventListener("click", outside);
  child.addEventListener("keydown", keydown, true);
  child.addEventListener("pp:scene-change", clearScene);
  child.addEventListener("campus:hide-hud", clearScene);
  child.addEventListener("pp:principal-change", clearScene);

  const ready = (async () => {
    try {
      const response = await fetcher(new URL("./campus-clues.css", import.meta.url), {
        credentials: "same-origin", signal: stylesheet.signal,
      });
      if (!response.ok) return false;
      const css = await response.text();
      if (!authorized()) return false;
      style.textContent = css;
      doc.head.append(style);
      stage.append(overlay, arrival);
      styled = true;
      if (typeof incoming === "string" && stableID.test(incoming)) void showQuestion(incoming);
      return true;
    } catch { return false; }
  })();

  async function open() {
    if (await ready) return showList();
    notifyUnavailable();
    return false;
  }

  function destroy() {
    if (disposed) return;
    disposed = true;
    stylesheet.abort();
    globalThis.clearTimeout(noticeTimer);
    clearScene();
    child.removeEventListener("keydown", keydown, true);
    child.removeEventListener("pp:scene-change", clearScene);
    child.removeEventListener("campus:hide-hud", clearScene);
    child.removeEventListener("pp:principal-change", clearScene);
    overlay.remove();
    arrival.remove();
    style.remove();
  }

  return { open, destroy, ready };
}
