import { mountCampusAppearance, setupCampusOutfit } from "./campus-appearance.mjs";

const ownerPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const authEventKey = "paperplane-web-session-changed-v1";
const sessionLockName = "paperplane-campus-session";
const directions = new Set(["up", "down", "left", "right"]);
const groupNames = ["journey", "outfit", "toy", "presence", "profile"];
const keys = {
  journey: "paperplane_sz_mobile_save_v1",
  outfit: "paperplane_sz_mobile_look_v1",
  toy: "paperplane-toy-v1",
  presence: "pp-room-share",
  profile: "paperplane-demo-profile-v1",
};

class NicknameTaken extends Error {
  constructor() { super("这个昵称已被使用，请换一个。"); }
}

class NicknameRateLimited extends Error {
  constructor() { super("昵称操作太频繁，请稍后再试。"); }
}

function validNickname(value) {
  return typeof value === "string" && value === value.trim() && value.length > 0 &&
    Array.from(value).length <= 24 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bit(value) {
  return value === 0 || value === 1;
}

function cleanString(value, limit) {
  return typeof value === "string" && Array.from(value).length <= limit && !/[\x00-\x1f\x7f]/u.test(value);
}

function readGroup(name, data) {
  if (!object(data)) return undefined;
  if (name === "journey") {
    const { v, x, y, d, n, r, s, mu, sf, z, run, t } = data;
    if (v !== 1 || !Number.isFinite(x) || x < 0 || x > 62 ||
        !Number.isFinite(y) || y < 0 || y > 68 || !directions.has(d) ||
        ![n, r, s, mu, sf, run].every(bit) || !Number.isFinite(z) || z < 1 || z > 2.6 ||
        !Number.isSafeInteger(t) || t < 0) return undefined;
    return { v, x, y, d, n, r, s, mu, sf, z, run, t };
  }
  if (name === "outfit") {
    const { name: displayName, grade, hair, hairC, skin, glass } = data;
    if (![grade, hair, hairC, skin].every(value => cleanString(value, 40)) ||
        (displayName !== undefined && !cleanString(displayName, 40)) ||
        (glass !== undefined && typeof glass !== "boolean")) return undefined;
    return { grade, hair, hairC, skin, ...(displayName === undefined ? {} : { name: displayName }),
      ...(glass === undefined ? {} : { glass }) };
  }
  if (name === "toy") {
    const { plane, badge, worn, hints } = data;
    if (![plane, badge, worn, hints].every(value => typeof value === "boolean") ||
        (badge && !plane) || (worn && !badge)) return undefined;
    return { plane, badge, worn, hints };
  }
  if (name === "profile") {
    const bounds = { stage: 12, school: 56, schoolId: 65, year: 4, grade: 18, group: 24 };
    const { age = "", education = [] } = data;
    if (typeof age !== "string" || !/^(?:[1-9]|[1-9][0-9]|1[01][0-9]|120)?$/.test(age) ||
        !Array.isArray(education) || education.length > 64) return undefined;
    const fields = Object.entries(bounds);
    if (!education.every(row => object(row) && fields.every(([key, limit]) => cleanString(row[key], limit)))) return undefined;
    return { age, education: education.map(row => Object.fromEntries(fields.map(([key]) => [key, row[key]]))) };
  }
  if (typeof data.findable === "boolean") return { findable: data.findable };
  return undefined;
}

function readState(data) {
  if (data === null) return { revision: 0, progress: {} };
  if (!object(data) || !Number.isSafeInteger(data.revision) || data.revision < 0 || !object(data.progress)) {
    throw new Error("Invalid campus state");
  }
  const progress = {};
  for (const name of groupNames) {
    if (data.progress[name] === undefined) continue;
    const value = readGroup(name, data.progress[name]);
    if (!value) throw new Error("Invalid campus " + name);
    progress[name] = value;
  }
  return { revision: data.revision, progress };
}

function readSession(data) {
  if (!object(data)) throw new Error("Invalid campus session");
  if (data.user === null && data.state === null) return null;
  const { user } = data;
  if (!object(user) || typeof user.id !== "string" || !ownerPattern.test(user.id) || !validNickname(user.nickname)) {
    throw new Error("Invalid campus identity");
  }
  if (user.nicknameConflict !== undefined && typeof user.nicknameConflict !== "boolean") throw new Error("Invalid campus identity");
  const nameEgg = user.nicknameConflict ? undefined : readNameEgg(data.nameEgg);
  return { user: { id: user.id, nickname: user.nickname, ...(user.nicknameConflict ? { nicknameConflict: true } : {}) },
    state: readState(data.state), ...(nameEgg ? { nameEgg } : {}) };
}

function readNameEgg(data) {
  if (!object(data) || typeof data.txt !== "string" || !object(data.fx)) return undefined;
  const { star, wx, toast } = data.fx;
  return { txt: data.txt, fx: {
    ...(star === true ? { star } : {}),
    ...(["day", "night", "rain", "snow"].includes(wx) ? { wx } : {}),
    ...(typeof toast === "string" ? { toast } : {}),
  } };
}

function readStorage(storage, key) {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}

function writeStorage(storage, key, value) {
  try {
    if (value === undefined) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch { /* The server remains the source for later visits. */ }
}

function parseJSON(value) {
  try { return JSON.parse(value); } catch { return null; }
}

const scopeKey = (name, id) => keys[name] + ":trial:" + encodeURIComponent(id);
const baseKey = id => "paperplane.campus.confirmed.v1:" + id;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function equalGroup(name, a, b) {
  if (name !== "journey" || !a || !b) return same(a, b);
  const { t: _a, ...left } = a;
  const { t: _b, ...right } = b;
  return same(left, right);
}

function storedProgress(storage, id) {
  const progress = {};
  for (const name of groupNames) {
    const raw = readStorage(storage, scopeKey(name, id));
    if (raw === null) continue;
    const rawValue = name === "presence" ? { findable: raw !== "off" } : parseJSON(raw);
    const group = readGroup(name, rawValue);
    if (group) progress[name] = group;
  }
  return progress;
}

function writeGroup(storage, id, name, value) {
  const key = scopeKey(name, id);
  if (name === "profile") {
    const old = parseJSON(readStorage(storage, key));
    if (!old && value === undefined) return;
    writeStorage(storage, key, JSON.stringify({ ...old, ...(value || { age: "", education: [] }) }));
    return;
  }
  writeStorage(storage, key, value === undefined ? undefined :
    name === "presence" ? (value.findable ? "on" : "off") : JSON.stringify(value));
}

function restoreScope(storage, { user, state }) {
  const local = storedProgress(storage, user.id);
  let previous;
  try {
    const raw = parseJSON(readStorage(storage, baseKey(user.id)));
    if (raw) previous = readState(raw);
  } catch { /* Ignore corrupt local data. */ }
  for (const name of groupNames) {
    const next = state.progress[name];
    // Preserve pending local edits to a group if its confirmed cloud version
    // has held steady. Only a verified durable user can reach these keys.
    if (local[name] && previous && equalGroup(name, previous.progress[name], next)) continue;
    writeGroup(storage, user.id, name, next);
  }
  writeStorage(storage, baseKey(user.id), JSON.stringify(state));
}

export function createCampusIdentity({
  fetcher = globalThis.fetch?.bind(globalThis),
  storage,
  sessionLocks = globalThis.window?.navigator?.locks,
  interval = 1800,
} = {}) {
  try { storage ??= globalThis.localStorage; } catch { /* Denied local storage is supported. */ }
  let session = null;
  let reading;
  let saving;
  let renaming;
  let disposed = false;
  let generation = 0;
  let activeBridge;
  let desiredNickname;
  let admittedOutfit;
  const declinedChanges = new Map();
  const listeners = new Set();

  function coordinateSession(operation) {
    if (typeof sessionLocks?.request !== "function") return operation(false);
    return sessionLocks.request(sessionLockName, () => operation(true));
  }

  async function request(path, options = {}) {
    const response = await fetcher(path, {
      credentials: "same-origin", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(6500), ...options,
    });
    if (response.status === 401 || response.status === 403) return { status: response.status, data: null };
    if (response.status === 429 && (await response.json().catch(() => null))?.error === "nickname_rate_limited") {
      return { status: 429, error: "nickname_rate_limited" };
    }
    if (!response.ok && response.status !== 409) throw new Error("Campus request failed");
    const payload = await response.json();
    if (response.status === 409 && ["nickname_taken", "nickname_required"].includes(payload?.error)) {
      return { status: response.status, error: payload.error };
    }
    return { status: response.status, data: readSession(payload) };
  }

  function replace(next, restore) {
    const changed = session?.user.id !== next?.user.id || Boolean(session?.user.nicknameConflict) !== Boolean(next?.user.nicknameConflict);
    if (changed || restore) {
      if (next) {
        restoreScope(storage, next);
        admittedOutfit = storedProgress(storage, next.user.id).outfit ?? next.state.progress.outfit;
      } else admittedOutfit = undefined;
      if (changed) {
        generation++;
        desiredNickname = undefined;
        declinedChanges.clear();
        activeBridge?.destroy();
      }
    }
    session = next;
    if (changed) for (const listener of listeners) listener(session);
    return session;
  }

  function load() {
    if (disposed) return Promise.reject(new Error("Campus identity is closed"));
    if (!reading) {
      const epoch = generation;
      reading = request("/api/campus/session").then(({ data }) => {
        if (!disposed && generation === epoch) replace(data, !session);
        return session;
      }).finally(() => { reading = undefined; });
    }
    return reading;
  }

  async function login(rawName, appearance) {
    const nickname = rawName.trim();
    if (!validNickname(nickname)) throw new Error("请填写 1–24 个字的昵称。");
    const outfit = appearance === undefined ? undefined : setupCampusOutfit(appearance);
    if (outfit === null) throw new Error("请选择校园原有的校服造型。");
    const epoch = ++generation;
    const current = () => !disposed && generation === epoch;
    const { data, error } = await coordinateSession(async (coordinated) => {
      if (!current()) throw new Error("未能确认昵称登录");
      if (coordinated) {
        const existing = await request("/api/campus/session");
        if (!current() || existing.status !== 200) throw new Error("未能确认昵称登录");
        if (existing.data) return existing;
      }
      return request("/api/campus/session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname, ...(outfit ? { outfit } : {}) }),
      });
    });
    if (!current()) throw new Error("未能确认昵称登录");
    if (error === "nickname_taken") throw new NicknameTaken();
    if (error === "nickname_rate_limited") throw new NicknameRateLimited();
    if (!data) throw new Error("未能确认昵称登录");
    return replace(data, true);
  }

  function rename(rawName) {
    const nickname = rawName.trim();
    if (!validNickname(nickname)) return Promise.reject(new Error("请填写 1–24 个字的昵称。"));
    if (disposed || !session || renaming) return Promise.reject(new Error("暂时无法更改昵称"));
    const epoch = generation;
    const owner = session.user.id;
    const current = () => !disposed && generation === epoch && session?.user.id === owner;
    renaming = (async () => {
      await saving?.catch(() => {});
      if (!current()) throw new Error("校园账号已变更");
      let base = session;
      const repair = Boolean(base.user.nicknameConflict);
      if (!repair && nickname === base.user.nickname) return base;
      for (let attempt = 0; attempt < 2; attempt++) {
        const { status, data, error } = await request("/api/campus/state", {
          method: "PUT", headers: { "Content-Type": "application/json", "X-Campus-User-ID": owner },
          body: JSON.stringify({ revision: base.state.revision, progress: base.state.progress, nickname }),
        });
        if (!current()) throw new Error("校园账号已变更");
        if (error === "nickname_taken") throw new NicknameTaken();
        if (error === "nickname_rate_limited") throw new NicknameRateLimited();
        if (status === 401 || status === 403 || error === "nickname_required") {
          await load();
          break;
        }
        if (data?.user.id !== owner) throw new Error("校园账号已变更");
        if (!data.user.nicknameConflict && (status === 200 || repair)) {
          generation++;
          const saved = replace(data, repair);
          if (!repair) writeStorage(storage, baseKey(owner), JSON.stringify(saved.state));
          return saved;
        }
        base = data;
      }
      throw new Error("暂时无法更改昵称");
    })().finally(() => { renaming = undefined; });
    return renaming;
  }

  function save() {
    if (disposed || !session || session.user.nicknameConflict || renaming || saving) return saving;
    const base = session;
    const epoch = generation;
    const local = storedProgress(storage, base.user.id);
    const edits = groupNames.filter(name => local[name] &&
      !equalGroup(name, base.state.progress[name], local[name]) &&
      !equalGroup(name, declinedChanges.get(name), local[name]));
    const nickname = desiredNickname;
    const renamed = nickname && nickname !== base.user.nickname;
    if (!edits.length && !renamed) return;
    const current = () => !disposed && generation === epoch && session?.user.id === base.user.id;
    async function persist(start, changes, name) {
      const progress = { ...start.state.progress };
      for (const key of changes) progress[key] = local[key];
      const response = await request("/api/campus/state", {
        method: "PUT", keepalive: true,
        headers: { "Content-Type": "application/json", "X-Campus-User-ID": start.user.id },
        body: JSON.stringify({ revision: start.state.revision, progress, ...(name ? { nickname: name } : {}) }),
      });
      if (!current()) return;
      if (response.status === 401 || response.status === 403 || response.error === "nickname_required") {
        await load();
        return;
      }
      if (["nickname_taken", "nickname_rate_limited"].includes(response.error)) {
        if (name && desiredNickname === name) {
          desiredNickname = undefined;
          activeBridge?.rejectNickname(name, session.user.nickname, response.error);
        }
        return;
      }
      if (response.data?.user.id !== start.user.id) throw new Error("Campus owner changed");
      if ((!name || response.status === 409) && response.data.user.nickname === session.user.nickname && session.nameEgg) {
        response.data.nameEgg = session.nameEgg;
      }
      replace(response.data, false);
      if (response.status === 409) return response.data;
      if (desiredNickname === name) desiredNickname = undefined;
      for (const key of changes) declinedChanges.delete(key);
      writeStorage(storage, baseKey(start.user.id), JSON.stringify(session.state));
    }
    saving = (async () => {
      const canonical = await persist(base, edits, renamed ? nickname : undefined);
      if (!canonical || !current()) return;
      const latest = storedProgress(storage, base.user.id);
      const unaffected = [];
      for (const name of edits) {
        if (equalGroup(name, base.state.progress[name], canonical.state.progress[name])) {
          unaffected.push(name);
        } else if (equalGroup(name, local[name], latest[name])) {
          declinedChanges.set(name, local[name]);
          writeGroup(storage, base.user.id, name, canonical.state.progress[name]);
        }
      }
      writeStorage(storage, baseKey(base.user.id), JSON.stringify(canonical.state));
      const safeRename = renamed && base.user.nickname === canonical.user.nickname ? nickname : undefined;
      if (!safeRename && desiredNickname === nickname) desiredNickname = undefined;
      if (unaffected.length || safeRename) await persist(canonical, unaffected, safeRename);
    })().finally(() => { saving = undefined; });
    return saving;
  }

  function connect(child) {
    activeBridge?.destroy();
    if (!session || session.user.nicknameConflict || disposed) throw new Error("Campus bridge requires a durable session");
    const owner = session.user.id;
    const outfit = admittedOutfit;
    admittedOutfit = undefined;
    const principal = "trial:" + encodeURIComponent(owner);
    let checkTimer, saveTimer, startupTimer;
    let noticeTimer;
    let forwardingRename;
    let finished = false;
    let destroyed = false;
    let settle, reject;
    const ready = new Promise((resolve, failure) => { settle = resolve; reject = failure; });
    const childDocument = child.document;
    const originalFetch = child.fetch;
    // Preserve the B401 logout UX, while making the request conditional on
    // this iframe's verified account if another tab has replaced the cookie.
    function scopedFetch(resource, options) {
      if (resource !== "/api/auth/logout" || options?.method !== "POST") {
        return Reflect.apply(originalFetch, child, [resource, options]);
      }
      const headers = new Headers(options.headers);
      headers.set("X-Campus-User-ID", owner);
      return coordinateSession(async () => {
        if (destroyed || session?.user.id !== owner) throw new Error("校园账号已变更");
        const response = await Reflect.apply(originalFetch, child, [resource, { ...options, headers }]);
        if (response.ok) {
          // The original handler announces logout and may detach the iframe
          // before it can write its own cross-tab storage notification.
          writeStorage(storage, authEventKey, Date.now().toString(36) + Math.random().toString(36).slice(2));
        }
        return response;
      });
    }
    if (typeof originalFetch === "function") child.fetch = scopedFetch;
    const identity = () => child.PPIdentity?.current();
    const authorized = () => identity()?.principal === principal && child.PPIdentity.authentication().verifiedSession;
    function resolveNameEgg(actor, nickname) {
      if (destroyed || actor !== principal || !authorized() || session?.user.id !== owner ||
          session.user.nickname !== nickname) return null;
      return session.nameEgg ?? null;
    }
    child.__ppCampusNameEgg = resolveNameEgg;
    function snapshot() {
      if (destroyed || !finished || !authorized() || session?.user.id !== owner) return;
      child.__ppEngine?.save();
      // If native storage is unavailable, there is no local snapshot to send.
      void save()?.catch(() => {});
    }
    function checkReady() {
      if (destroyed || finished || !authorized() || !child.PPGame?.isEntered()) return;
      finished = true;
      clearTimeout(startupTimer);
      clearInterval(checkTimer);
      if (outfit) {
        child.__ppEngine?.restoreAppearance?.({ ...outfit, name: identity().displayName });
        writeGroup(storage, owner, "outfit", outfit);
      }
      if (!child.location.hash && session.state.progress.journey) {
        child.__ppEngine?.goHome();
        const returnButton = child.document.getElementById("pp-back-home");
        if (returnButton) returnButton.hidden = true;
      }
      if (typeof child.Event === "function") child.dispatchEvent(new child.Event("campus:refresh-name-egg"));
      saveTimer = setInterval(snapshot, interval);
      settle();
    }

    function scheduleStartupDeadline() {
      if (finished || destroyed) return;
      if (childDocument.hidden) {
        clearTimeout(startupTimer);
        startupTimer = undefined;
      } else if (startupTimer === undefined) {
        startupTimer = setTimeout(() => {
          startupTimer = undefined;
          if (!childDocument.hidden) bridge.destroy();
        }, 6000);
      }
    }

    function visibilityChange() {
      if (finished) snapshot();
      else {
        checkReady();
        scheduleStartupDeadline();
      }
    }
    function identityChange() {
      if (!finished) return checkReady();
      if (!authorized() && session?.user.id === owner) {
        replace(null, false);
        return;
      }
      const nickname = identity()?.displayName;
      if (validNickname(nickname) && nickname !== session?.user.nickname) desiredNickname = nickname;
      snapshot();
    }

    function writeCanonicalName(nickname) {
      const key = scopeKey("profile", owner);
      const existing = parseJSON(readStorage(storage, key));
      writeStorage(storage, key, JSON.stringify({ ...existing, nickname, accountName: nickname }));
    }

    function rejectNickname(candidate, canonical, code) {
      if (destroyed || !authorized() || identity()?.displayName !== candidate) return;
      writeCanonicalName(canonical);
      const notice = childDocument.getElementById("pp-notice");
      if (!notice) return;
      const text = code === "nickname_rate_limited" ? "昵称操作太频繁，称呼未更改。" : "这个昵称已被使用，称呼未更改。";
      notice.textContent = text;
      notice.classList.add("on");
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => {
        if (notice.textContent === text) notice.classList.remove("on");
      }, 2600);
    }

    async function confirmNickname(event) {
      const button = event.target?.closest?.("button.pid-primary");
      const panel = button?.closest("#pp-identity:not([hidden])");
      if (!finished || !authorized() || !panel || button === forwardingRename ||
          panel.querySelector("#pid-title")?.textContent !== "我的称呼") return;
      const field = panel.querySelector('input[aria-label="称呼"]');
      const warning = panel.querySelector(".pid-error");
      if (!field || !warning) return;
      // B401's original save mutates the in-memory alias before announcing it.
      // Await the authoritative rename so no rejected alias reaches the room.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (button.disabled) return;
      if (!validNickname(field.value.trim())) {
        warning.textContent = "请填写 1–24 个字的昵称。";
        field.focus({ preventScroll: true });
        return;
      }
      button.disabled = true;
      field.readOnly = true;
      warning.textContent = "正在保存昵称…";
      try {
        const confirmed = await rename(field.value);
        if (destroyed || !authorized() || session?.user.id !== owner) return;
        if (!button.isConnected) {
          writeCanonicalName(confirmed.user.nickname);
          return;
        }
        field.value = confirmed.user.nickname;
        button.disabled = false;
        forwardingRename = button;
        try { button.click(); } finally { forwardingRename = undefined; }
      } catch (error) {
        if (!destroyed && authorized() && button.isConnected) {
          warning.textContent = error instanceof NicknameTaken || error instanceof NicknameRateLimited
            ? error.message : "暂时无法保存昵称，请重试。";
          field.readOnly = false;
          field.focus({ preventScroll: true });
        }
      } finally {
        button.disabled = false;
        field.readOnly = false;
      }
    }
    const bridge = { ready, rejectNickname, destroy() {
      if (destroyed) return;
      destroyed = true;
      if (activeBridge === bridge) activeBridge = undefined;
      clearTimeout(startupTimer);
      clearTimeout(noticeTimer);
      clearInterval(checkTimer);
      clearInterval(saveTimer);
      child.removeEventListener("pp:entered", checkReady);
      child.removeEventListener("pp:principal-change", identityChange);
      child.removeEventListener("click", confirmNickname, true);
      child.removeEventListener("pagehide", snapshot);
      childDocument.removeEventListener("visibilitychange", visibilityChange);
      try { if (child.fetch === scopedFetch) child.fetch = originalFetch; } catch { /* Detached frame. */ }
      try { if (child.__ppCampusNameEgg === resolveNameEgg) delete child.__ppCampusNameEgg; } catch { /* Detached frame. */ }
      if (!finished) reject(new Error("Packaged campus did not verify the durable nickname session"));
    } };
    activeBridge = bridge;
    child.addEventListener("pp:entered", checkReady);
    child.addEventListener("pp:principal-change", identityChange);
    child.addEventListener("click", confirmNickname, true);
    child.addEventListener("pagehide", snapshot);
    childDocument.addEventListener("visibilitychange", visibilityChange);
    checkTimer = setInterval(checkReady, 50);
    checkReady();
    scheduleStartupDeadline();
    void ready.catch(() => {});
    return bridge;
  }

  return {
    load, login, rename, connect, current: () => session,
    subscribe(listener) {
      listeners.add(listener);
      listener(session);
      return () => listeners.delete(listener);
    },
    destroy() {
      disposed = true;
      generation++;
      activeBridge?.destroy();
      listeners.clear();
    },
  };
}

export function mountCampusNickname(host, { identity, onSession }) {
  const doc = host.ownerDocument;
  const loading = doc.createElement("p");
  loading.setAttribute("role", "status");
  loading.textContent = "正在打开校园…";
  host.replaceChildren(loading);
  let destroyed = false;
  let busy = false;
  let admitted = false;
  let appearance;
  function enter(session) {
    if (destroyed || admitted) return;
    admitted = true;
    onSession(session);
  }
  async function form(repairSession = null) {
    try {
      const design = await import("./tdesign.mjs");
      if (destroyed || admitted) return;
      const repair = Boolean(repairSession?.user.nicknameConflict);
      appearance?.destroy();
      const label = doc.createElement("label");
      label.htmlFor = "campus-nickname";
      label.textContent = "昵称";
      const { element, control } = design.field("input", {
        id: label.htmlFor, name: "nickname", maxlength: 48, placeholder: "输入昵称", autocomplete: "nickname",
        "aria-describedby": "campus-nickname-status", enterkeyhint: "go",
      });
      const status = doc.createElement("p");
      status.id = "campus-nickname-status";
      status.setAttribute("role", "status");
      const heading = doc.createElement("h1");
      heading.textContent = repair ? "更换校园昵称" : "深中随身校园";
      const fields = doc.createElement("form");
      fields.className = "campus-nickname-form campus-setup";
      const button = design.button(repair ? "保存并进入校园" : "进入校园", undefined, "primary");
      button.type = "submit";
      button.disabled = true;
      const setup = repair ? null : mountCampusAppearance({ doc, design });
      appearance = setup;
      const inputs = doc.createElement("div");
      inputs.className = "campus-setup-fields";
      const nickname = doc.createElement("div");
      nickname.className = "campus-setup-field campus-setup-name";
      nickname.append(label, element);
      inputs.append(nickname, ...(setup?.inputs || []));
      let body = inputs;
      if (setup) {
        body = doc.createElement("div");
        body.className = "campus-setup-body";
        body.append(setup.preview, inputs);
      }
      const actions = doc.createElement("footer");
      actions.append(status, button);
      fields.append(heading, body, actions);
      host.replaceChildren(fields);
      control.addEventListener("input", () => setup?.describe(control.value));
      let previewReady = repair;
      if (repair) {
        control.value = repairSession.user.nickname;
        button.disabled = false;
        status.textContent = "这个昵称已有人使用，请换一个昵称后继续。";
      }
      void setup?.ready.then(() => {
        if (destroyed) return;
        previewReady = true;
        button.disabled = false;
      }, () => {
        if (!destroyed) status.textContent = "校园预览未能加载，请刷新后重试。";
      });
      fields.addEventListener("submit", async event => {
        event.preventDefault();
        if (busy || destroyed || !previewReady) return;
        if (!validNickname(control.value.trim())) {
          status.textContent = "请填写 1–24 个字的昵称。";
          control.focus();
          return;
        }
        busy = true;
        button.disabled = true;
        setup?.setDisabled(true);
        status.textContent = repair ? "正在保存昵称…" : "正在登录…";
        try {
          const result = repair ? await identity.rename(control.value) : await identity.login(control.value, setup.value());
          if (result.user.nicknameConflict) void form(result);
          else enter(result);
        } catch (error) {
          if (!destroyed) {
            status.textContent = error instanceof NicknameTaken || error instanceof NicknameRateLimited ? error.message :
              repair ? "暂时无法保存昵称，请重试。" : "暂时无法登录，请重试。";
            if (error instanceof NicknameTaken) control.focus({ preventScroll: true });
          }
        }
        finally {
          busy = false;
          if (!destroyed) {
            button.disabled = false;
            setup?.setDisabled(false);
          }
        }
      });
    } catch {
      if (!destroyed) loading.textContent = "校园入口暂时无法打开，请刷新重试。";
    }
  }
  function load() {
    host.replaceChildren(loading);
    loading.textContent = "正在打开校园…";
    void identity.load().then(session => {
      if (destroyed) return;
      if (!session || session.user.nicknameConflict) return form(session);
      enter(session);
    }, async () => {
      if (destroyed) return;
      loading.textContent = "暂时无法确认校园登录。";
      try {
        const design = await import("./tdesign.mjs");
        if (!destroyed) host.append(design.button("重试", load, "primary"));
      } catch {
        if (!destroyed) loading.textContent = "校园入口暂时无法打开，请刷新重试。";
      }
    });
  }
  load();
  return () => {
    destroyed = true;
    appearance?.destroy();
  };
}
