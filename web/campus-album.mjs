const ALBUM = "/api/campus/album";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_PNG = 2 * 1024 * 1024;
const METADATA = ["taken", "caption", "placeId", "placeName", "nearby", "schoolName", "shotPreset"];
const PRESET_KEYS = ["light", "zoom", "facing"];

function metadata(photo) {
  return Object.fromEntries(METADATA.map((key) => [key, photo[key]]));
}

function sameMetadata(remote, local) {
  return METADATA.every((key) => key === "shotPreset"
    ? PRESET_KEYS.every((part) => remote.shotPreset?.[part] === local.shotPreset?.[part])
    : remote[key] === local[key]);
}

function readManifest(value) {
  if (!Number.isSafeInteger(value?.revision) || value.revision < 0 || !Array.isArray(value.photos) || value.photos.length > 12) {
    throw Error("Invalid album response");
  }
  const rows = new Map();
  for (const photo of value.photos) {
    if (!UUID.test(photo?.id) || rows.has(photo.id) || !Number.isSafeInteger(photo.version) || photo.version < 1 ||
        photo.version > value.revision || !Number.isSafeInteger(photo.metadata?.taken) ||
        !METADATA.every((key) => Object.hasOwn(photo.metadata, key))) throw Error("Invalid album photo");
    rows.set(photo.id, { id: photo.id, version: photo.version, metadata: metadata(photo.metadata) });
  }
  return { revision: value.revision, rows };
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(Error("Could not read private album")), { once: true });
  });
}

function openAlbum(child, name) {
  const request = child.indexedDB.open(name, 1);
  request.addEventListener("upgradeneeded", () => {
    if (!request.result.objectStoreNames.contains("photo")) request.result.createObjectStore("photo", { keyPath: "id" });
  });
  return requestValue(request);
}

export function connectCampusAlbum(child, { principalID, current, fetcher = globalThis.fetch.bind(globalThis) }) {
  const scope = `trial:${encodeURIComponent(principalID)}`;
  const name = `paperplane-campus-photos-v1:${scope}`;
  const queue = `paperplane-campus-album-pending-v1:${scope}:`;
  const tracked = `paperplane-campus-album-versions-v1:${scope}`;
  const prototype = child.IDBObjectStore.prototype;
  const { put, delete: remove } = prototype;
  const pending = new Map();
  const committing = new Set();
  const inFlight = new AbortController();
  let storage, closed = false, database, syncing, interval, notice = "";
  let versions = {};
  try { storage = child.localStorage; } catch { /* Keep the current tab functional. */ }
  const authorized = () => !closed && current()?.user.id === principalID && child.PPPrivate?.owner() === scope;

  function requireOwner() {
    if (!authorized()) throw Error("Campus album session changed");
  }

  function stash(key, value) {
    try {
      if (!storage) return false;
      if (value === undefined) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(value));
      return true;
    } catch { return false; }
  }

  function restore(key) {
    try { return JSON.parse(storage?.getItem(key) || "null"); }
    catch { return null; }
  }

  function queued(id) {
    return pending.get(id) || restore(queue + id);
  }

  function queuedIDs() {
    const ids = new Set(pending.keys());
    try {
      for (let index = 0; index < (storage?.length || 0); index++) {
        const key = storage.key(index);
        if (key?.startsWith(queue) && UUID.test(key.slice(queue.length))) ids.add(key.slice(queue.length));
      }
    } catch { /* Use the in-memory queue when browser storage is denied. */ }
    return ids;
  }

  function record(id, kind) {
    const version = queued(id)?.base ?? (restore(tracked) || versions)[id] ?? 0;
    const operation = { kind, base: version, token: child.crypto.randomUUID() };
    if (stash(queue + id, operation)) pending.delete(id);
    else pending.set(id, operation);
    void sync();
  }

  function acknowledge(id, sent, version) {
    const latest = queued(id);
    if (latest?.token === sent.token) {
      pending.delete(id);
      stash(queue + id);
    } else if (latest?.base === sent.base) {
      latest.base = version;
      if (stash(queue + id, latest)) pending.delete(id);
      else pending.set(id, latest);
    }
  }

  function observe(store, id, kind) {
    if (!authorized() || store.name !== "photo" || store.transaction.db.name !== name || !UUID.test(id)) return;
    committing.add(id);
    store.transaction.addEventListener("complete", () => {
      committing.delete(id);
      if (authorized()) record(id, kind);
    }, { once: true });
    store.transaction.addEventListener("abort", () => committing.delete(id), { once: true });
  }

  function observedPut(...args) {
    const result = Reflect.apply(put, this, args);
    observe(this, args[0]?.id, "put");
    return result;
  }

  function observedDelete(...args) {
    const result = Reflect.apply(remove, this, args);
    observe(this, args[0], "delete");
    return result;
  }

  async function request(path, options = {}) {
    requireOwner();
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, 6000);
    inFlight.signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetcher(path, {
        credentials: "same-origin", redirect: "error", cache: "no-store", ...options,
        signal: controller.signal,
        headers: { "X-Campus-User-ID": principalID, ...options.headers },
      });
      requireOwner();
      if (!response.ok && ![409, 413, 422].includes(response.status)) throw Error("Album request failed");
      return response;
    } finally {
      clearTimeout(timeout);
      inFlight.signal.removeEventListener("abort", abort);
    }
  }

  async function manifest() {
    return readManifest(await (await request(ALBUM)).json());
  }

  async function matchesUploaded(id, row, local) {
    if (!row || !local?.png || !sameMetadata(row.metadata, local)) return false;
    const response = await request(`${ALBUM}/${id}`);
    if (!response.ok) return false;
    const download = await response.blob();
    if (download.size !== local.png.size || download.type !== "image/png") return false;
    const buffers = await Promise.all([download.arrayBuffer(), local.png.arrayBuffer()]);
    const actual = new Uint8Array(buffers[0]);
    return new Uint8Array(buffers[1]).every((byte, index) => actual[index] === byte);
  }

  async function putRemote(id, operation, remote, local) {
    let current = remote;
    for (let attempt = 0; attempt < 3; attempt++) {
      const version = current.rows.get(id)?.version || 0;
      if (operation.kind === "delete" && !version) return { current, accepted: true };
      if (version !== operation.base) {
        if (operation.kind === "put" && await matchesUploaded(id, current.rows.get(id), local)) return { current, accepted: true };
        return { current, issue: "照片在另一台设备上已更新。本机改动已保留。" };
      }
      const headers = { "If-Match": `"${current.revision}"` };
      const options = { method: "DELETE", headers };
      if (operation.kind === "put") {
        if (local?.png?.type !== "image/png" || !local.png.size || local.png.size > MAX_PNG) {
          return { current, issue: "这张照片已保存在设备上，超过云相册的单张容量。" };
        }
        headers["Content-Type"] = "image/png";
        headers["X-Campus-Photo-Metadata"] = encodeURIComponent(JSON.stringify(metadata(local)));
        options.method = "PUT";
        options.body = local.png;
      }
      const reply = await request(`${ALBUM}/${id}`, options);
      if (reply.status === 413 || reply.status === 422) return { current, issue: "云相册容量不足，本机改动已保留。" };
      current = readManifest(await reply.json());
      if (reply.ok) return { current, accepted: true };
    }
    return { current, issue: "相册有其他更新，稍后继续同步。" };
  }

  function setNotice(text) {
    notice = text;
    const foot = child.document.querySelector("#ppCam .ppc-foot");
    if (!foot) return;
    let note = foot.querySelector("[data-campus-album-status]");
    if (!text) { note?.remove(); return; }
    if (!note) {
      note = child.document.createElement("p");
      note.className = "ppc-note";
      note.dataset.campusAlbumStatus = "";
      note.setAttribute("role", "status");
      foot.append(note);
    }
    if (note.textContent !== notice) note.textContent = notice;
  }

  async function synchronize() {
    requireOwner();
    if (!database) {
      const opened = await openAlbum(child, name);
      if (!authorized()) opened.close();
      else database = opened;
    }
    requireOwner();
    let remote = await manifest();
    const local = new Map((await requestValue(database.transaction("photo").objectStore("photo").getAll())).map((photo) => [photo.id, photo]));
    const known = restore(tracked) || versions;
    for (const [id] of local) {
      if (UUID.test(id) && !queued(id) && !known[id] && !remote.rows.has(id) && !committing.has(id)) record(id, "put");
    }

    let issue = "";
    for (const id of queuedIDs()) {
      const operation = queued(id);
      if (!operation || !["put", "delete"].includes(operation.kind)) continue;
      const result = await putRemote(id, operation, remote, local.get(id));
      remote = result.current;
      if (result.accepted) acknowledge(id, operation, remote.rows.get(id)?.version || 0);
      if (result.issue) issue = result.issue;
    }

    const incoming = await Promise.all([...remote.rows.values()].filter(({ id, version }) =>
      !queued(id) && !committing.has(id) && (!local.has(id) || known[id] !== version),
    ).map(async (row) => {
      const response = await request(`${ALBUM}/${row.id}`);
      if (!response.ok) throw Error("Cloud photo changed");
      const png = await response.blob();
      if (png.type !== "image/png" || !png.size || png.size > MAX_PNG) throw Error("Invalid cloud photo");
      return { id: row.id, ...row.metadata, png, saved: true };
    }));
    if (incoming.length && (await manifest()).revision !== remote.revision) throw Error("Cloud album changed while loading");
    requireOwner();
    const transaction = database.transaction("photo", "readwrite");
    const store = transaction.objectStore("photo");
    let cacheChanged = false;
    for (const photo of incoming) {
      if (!queued(photo.id) && !committing.has(photo.id)) {
        Reflect.apply(put, store, [photo]);
        cacheChanged = true;
      }
    }
    for (const id of local.keys()) {
      if (known[id] && !remote.rows.has(id) && !queued(id) && !committing.has(id)) {
        Reflect.apply(remove, store, [id]);
        cacheChanged = true;
      }
    }
    await new Promise((resolve, reject) => {
      transaction.addEventListener("complete", resolve, { once: true });
      transaction.addEventListener("abort", () => reject(Error("Album cache write did not complete")), { once: true });
    });
    requireOwner();
    versions = Object.fromEntries([...remote.rows.values()].map(({ id, version }) => [id, version]));
    stash(tracked, versions);
    if (cacheChanged) child.dispatchEvent(new child.Event("campus:album-updated"));
    setNotice(issue);
  }

  function sync() {
    if (!authorized()) return Promise.resolve();
    syncing ||= Promise.resolve().then(synchronize).catch(() => {
      if (authorized()) setNotice("云相册暂未同步，本机照片仍可查看。");
    }).finally(() => { syncing = undefined; });
    return syncing;
  }

  function albumOpening() {
    if (notice) child.queueMicrotask(() => { if (authorized()) setNotice(notice); });
    void sync();
  }

  prototype.put = observedPut;
  prototype.delete = observedDelete;
  child.addEventListener("online", albumOpening);
  child.addEventListener("campus:album-open", albumOpening);
  function storageChanged(event) {
    if (event.key?.startsWith(queue)) void sync();
  }
  child.addEventListener("storage", storageChanged);
  interval = child.setInterval(sync, 12000);
  const ready = sync();
  return { ready, destroy() {
    closed = true;
    inFlight.abort();
    child.clearInterval(interval);
    child.removeEventListener("online", albumOpening);
    child.removeEventListener("campus:album-open", albumOpening);
    child.removeEventListener("storage", storageChanged);
    if (prototype.put === observedPut) prototype.put = put;
    if (prototype.delete === observedDelete) prototype.delete = remove;
    database?.close();
  } };
}
