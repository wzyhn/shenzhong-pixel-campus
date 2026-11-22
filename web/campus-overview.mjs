// B401's atlas projects the full 62 × 68 tile world, including its perimeter.
const world = { width: 62, height: 68 };
const featured = new Set([
  "north-gate", "field", "red-century-square", "main-teaching",
  "wenrui-garden", "library", "southwest-gate", "southeast-gate",
]);

function placeCategory(id) {
  if (id.endsWith("-gate")) return "校门";
  if (["field", "stands", "basketball", "badminton", "table-tennis", "gym"].includes(id)) return "运动场地";
  if (id.endsWith("-garden") || id.endsWith("-square")) return "广场与园景";
  if (id.startsWith("dorm-") || ["canteen", "shop", "teacher-residence", "restroom"].includes(id)) return "校园生活";
  return "教学与场馆";
}

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  if (tag === "button") node.type = "button";
  return node;
}

function getPlaces(child) {
  const anchors = new Map((child.ppAnchors ?? []).map((anchor) => [anchor.id, anchor]));
  return (child.PPGame.getPlaces?.() ?? []).map((place) => {
    const anchor = anchors.get(place.id);
    return { ...place, x: anchor?.x, y: anchor?.y, category: placeCategory(place.id) };
  });
}

function isolateDialog(dialog) {
  const inert = [];
  for (let node = dialog; node.parentElement; node = node.parentElement) {
    for (const sibling of node.parentElement.children) {
      if (sibling === node || sibling.inert || !sibling.getClientRects().length) continue;
      sibling.inert = true;
      inert.push(sibling);
    }
    if (node.parentElement === dialog.ownerDocument.body) break;
  }
  return () => {
    for (const element of inert) element.inert = false;
  };
}

function trackSearchViewport(child, map, search, directory) {
  const outer = child.parent?.visualViewport;
  const inner = child.visualViewport;
  const viewports = new Set([inner, outer].filter(Boolean));
  let compact = false;

  function insets(viewport, frameTop, frameBottom) {
    if (!viewport || viewport.scale !== 1 || !Number.isFinite(viewport.offsetTop) ||
        !Number.isFinite(viewport.height) || viewport.height <= 0) return [0, 0];
    return [
      Math.max(0, viewport.offsetTop - frameTop),
      Math.max(0, frameBottom - viewport.offsetTop - viewport.height),
    ];
  }

  function update() {
    const frame = child.frameElement?.getBoundingClientRect();
    const [innerTop, innerBottom] = insets(inner, 0, child.innerHeight);
    const [outerTop, outerBottom] = frame ? insets(outer, frame.top, frame.bottom) : [0, 0];
    const top = Math.max(innerTop, outerTop);
    const bottom = Math.max(innerBottom, outerBottom);
    const visibleHeight = child.innerHeight - top - bottom;
    const wasCompact = compact;
    const focused = map.ownerDocument.activeElement;
    compact = (compact || search === focused) && top + bottom >= 64 && visibleHeight >= 76;
    map.toggleAttribute("data-keyboard", compact);
    if (compact) {
      map.style.setProperty("--overview-keyboard-top", `${Math.round(top)}px`);
      map.style.setProperty("--overview-keyboard-bottom", `${Math.round(bottom)}px`);
    } else if (wasCompact && directory.contains(focused)) {
      directory.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  search.addEventListener("focus", update);
  child.addEventListener("resize", update);
  for (const viewport of viewports) {
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
  }
  return () => {
    child.removeEventListener("resize", update);
    search.removeEventListener("focus", update);
    for (const viewport of viewports) {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    }
  };
}

function decorateMap(child, map, opener) {
  const doc = child.document;
  const game = child.PPGame;
  const frame = map.querySelector(".pp-map-viewport");
  const image = frame?.querySelector("canvas");
  const footer = map.querySelector(".pp-map-footer");
  if (!image || !footer) return null;

  const places = getPlaces(child);
  const context = game.getContext();
  const currentId = context.nearby ? null : context.placeId;
  const location = context.nearby ? context.placeName + "附近" : context.currentLabel;
  const header = element(doc, "header", "campus-overview-header");
  const heading = element(doc, "h2", "", "校园全图");
  heading.id = "campus-overview-title";
  const here = element(doc, "p", "campus-overview-here", "当前位置 · " + location);
  const close = element(doc, "button", "campus-overview-close", "关闭全图");
  const title = element(doc, "div");
  title.append(heading, here);
  header.append(title, close);
  close.addEventListener("click", () => map.click());
  header.addEventListener("click", (event) => event.stopPropagation());

  const markerLayer = element(doc, "div", "campus-overview-pins");
  const zoom = element(doc, "span", "campus-overview-scale");
  const guidance = element(doc, "span", "campus-overview-gestures");
  guidance.append(
    element(doc, "span", "campus-overview-mouse", "滚轮缩放 · 拖动平移"),
    element(doc, "span", "campus-overview-touch", "双指缩放 · 拖动平移"),
  );
  frame.append(markerLayer);
  footer.append(zoom, guidance);
  footer.addEventListener("click", (event) => event.stopPropagation());
  function syncMapTransform() {
    const transform = image.style.transform;
    const scale = Number(/scale\(([^)]+)\)/.exec(transform)?.[1]) || 1;
    markerLayer.style.transform = transform;
    markerLayer.style.setProperty("--pin-inverse-scale", String(1 / scale));
    zoom.textContent = Math.round(100 * scale) + "%";
  }
  const transformObserver = new child.MutationObserver(syncMapTransform);
  transformObserver.observe(image, { attributes: true, attributeFilter: ["style"] });
  syncMapTransform();

  const directory = element(doc, "aside", "campus-overview-directory");
  const directoryTitle = element(doc, "h3", "", "校园地标");
  directoryTitle.id = "campus-overview-directory";
  directory.setAttribute("aria-labelledby", directoryTitle.id);
  const search = element(doc, "input", "campus-overview-search");
  search.type = "search";
  search.placeholder = "搜索地标";
  search.setAttribute("aria-label", "搜索校园地标");
  const selection = element(doc, "div", "campus-overview-selection");
  selection.hidden = true;
  const selectedName = element(doc, "strong");
  selectedName.tabIndex = -1;
  const visit = element(doc, "button", "campus-overview-visit", "前往");
  const outcome = element(doc, "p", "campus-overview-outcome");
  outcome.hidden = true;
  outcome.setAttribute("role", "status");
  selection.append(selectedName, visit, outcome);
  const list = element(doc, "div", "campus-overview-list");
  directory.append(directoryTitle, search, selection, list);
  directory.addEventListener("click", (event) => event.stopPropagation());

  let selected;
  const pins = new Map();
  const choices = new Map();
  function updateSelection() {
    for (const [id, pin] of pins) {
      pin.hidden = id === currentId || !(featured.has(id) || id === selected?.id);
      pin.setAttribute("aria-pressed", String(id === selected?.id));
    }
    for (const [id, button] of choices) {
      button.setAttribute("aria-pressed", String(id === selected?.id));
    }
  }

  function select(place) {
    selected = place;
    selection.hidden = false;
    outcome.hidden = true;
    selectedName.textContent = place.label;
    visit.hidden = place.id === currentId;
    visit.setAttribute("aria-label", "前往" + place.label);
    if (visit.hidden) {
      selectedName.textContent += " · 当前位置";
      selectedName.focus({ preventScroll: true });
    } else {
      visit.focus({ preventScroll: true });
    }
    updateSelection();
  }

  visit.addEventListener("click", () => {
    if (!selected) return;
    const { light, zoom } = game.getContext().shotPreset ?? {};
    const preset = { ...(light ? { light } : {}), ...(zoom ? { zoom } : {}) };
    if (game.goToPlace(selected.id, preset)) {
      map.click();
      return;
    }
    outcome.textContent = "暂时无法前往，请重新选择地标。";
    outcome.hidden = false;
  });

  for (const place of places) {
    if (!Number.isFinite(place.x) || !Number.isFinite(place.y)) continue;
    const pin = element(doc, "button", "campus-overview-pin", place.label);
    pin.tabIndex = -1;
    pin.style.left = 100 * place.x / world.width + "%";
    pin.style.top = 100 * place.y / world.height + "%";
    if (place.x > 54) pin.classList.add("campus-overview-pin-end");
    if (place.x < 8) pin.classList.add("campus-overview-pin-start");
    pin.addEventListener("pointerdown", (event) => event.stopPropagation());
    pin.addEventListener("click", () => select(place));
    pins.set(place.id, pin);
    markerLayer.append(pin);
  }

  function renderPlaces() {
    const query = search.value.trim().toLowerCase();
    const groups = new Map();
    choices.clear();
    list.replaceChildren();
    list.scrollTop = 0;
    for (const place of places) {
      if (query && !place.label.toLowerCase().includes(query) && !place.category.includes(query)) continue;
      if (!groups.has(place.category)) {
        const group = element(doc, "section", "campus-overview-group");
        group.append(element(doc, "h4", "", place.category));
        const items = element(doc, "ul");
        group.append(items);
        list.append(group);
        groups.set(place.category, items);
      }
      const item = element(doc, "li");
      const button = element(doc, "button", "campus-overview-place", place.label);
      button.addEventListener("click", () => select(place));
      if (place.id === currentId) {
        button.append(element(doc, "span", "campus-overview-current", "当前位置"));
      }
      choices.set(place.id, button);
      item.append(button);
      groups.get(place.category).append(item);
    }
    if (!choices.size) list.append(element(doc, "p", "campus-overview-empty", "没有找到匹配的地标。"));
    updateSelection();
  }
  search.addEventListener("input", renderPlaces);
  renderPlaces();

  map.classList.add("campus-overview");
  map.setAttribute("aria-modal", "true");
  map.setAttribute("aria-labelledby", heading.id);
  map.insertBefore(header, footer);
  map.insertBefore(directory, footer);
  const restoreBackground = isolateDialog(map);
  const stopTrackingViewport = trackSearchViewport(child, map, search, directory);
  close.focus({ preventScroll: true });
  return {
    map,
    opener,
    close,
    restore() {
      stopTrackingViewport();
      transformObserver.disconnect();
      restoreBackground();
      const trigger = opener?.isConnected && opener.getClientRects().length
        ? opener
        : doc.getElementById("pp-location");
      trigger?.focus({ preventScroll: true });
    },
  };
}

export function connectCampusOverview(child, { dismissEmoji } = {}) {
  const doc = child.document;
  const stage = doc.getElementById("ppStage");
  const trigger = doc.getElementById("pp-location");
  const previousPopup = trigger?.getAttribute("aria-haspopup");
  trigger?.setAttribute("aria-haspopup", "dialog");
  const controller = new AbortController();
  const sheet = element(doc, "style");
  doc.head.append(sheet);
  let current, pendingOpener, styled = false;

  function sync() {
    const map = doc.getElementById("mapBox");
    if (current && current.map !== map) {
      current.restore();
      current = null;
    }
    if (!map || current) return;
    const emojiOpener = dismissEmoji?.();
    if (!styled) {
      pendingOpener ??= emojiOpener;
      return;
    }
    const opener = pendingOpener ?? emojiOpener ?? doc.activeElement;
    pendingOpener = null;
    current = decorateMap(child, map, opener === doc.body ? trigger : opener);
  }

  const observer = new child.MutationObserver(sync);
  if (stage) observer.observe(stage, { childList: true });
  const css = fetch("/campus-overview.css", { credentials: "same-origin", signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) return;
      const contents = await response.text();
      if (controller.signal.aborted) return;
      sheet.textContent = contents;
      styled = true;
      sync();
    })
    .catch(() => { /* The campus still has its original map if the stylesheet cannot load. */ });

  function onKey(event) {
    if (!current || event.ctrlKey || event.metaKey || event.altKey) return;
    const { map, close } = current;
    const editing = event.target?.matches?.("input");
    if (event.isComposing) {
      if (editing) event.stopPropagation();
      return;
    }
    if (event.key === "Escape" || (!editing && event.key.toLowerCase() === "m")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      map.click();
      return;
    }
    if (event.key === "Tab") {
      const buttons = [...map.querySelectorAll("button:not([disabled]), input")].filter(
        (node) => node.tabIndex >= 0 && node.getClientRects().length,
      );
      const edge = event.shiftKey ? buttons.at(0) : buttons.at(-1);
      const next = event.shiftKey ? buttons.at(-1) : buttons.at(0);
      if (doc.activeElement === edge || !map.contains(doc.activeElement)) {
        event.preventDefault();
        (next ?? close).focus({ preventScroll: true });
      }
      return;
    }
    if (editing) event.stopPropagation();
  }
  child.addEventListener("keydown", onKey, true);

  return {
    css,
    open(opener = trigger) {
      if (current) {
        current.close.focus({ preventScroll: true });
        return true;
      }
      const nativeButton = doc.getElementById("hudMap");
      if (!nativeButton || child.ppBlocksMove || !child.PPGame.isEntered()) return false;
      pendingOpener = opener;
      nativeButton.click();
      if (doc.getElementById("mapBox")) return true;
      pendingOpener = null;
      return false;
    },
    destroy() {
      controller.abort();
      observer.disconnect();
      child.removeEventListener("keydown", onKey, true);
      if (current) {
        current.map.click();
        current.restore();
        current = null;
      }
      if (previousPopup == null) trigger?.removeAttribute("aria-haspopup");
      else trigger?.setAttribute("aria-haspopup", previousPopup);
      sheet.remove();
    },
  };
}
