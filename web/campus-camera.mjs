const activeInstallations = new WeakMap();
const pendingFrames = new WeakMap();
const capturedLabels = new WeakMap();
const sans = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif';

export function installCameraOnce(child, install) {
  if (!child?.PPGame || !child.document) throw new TypeError("Campus camera requires the original campus");
  if (activeInstallations.has(child)) throw new Error("Campus camera is already installed");
  const cleanup = install();
  const destroy = () => {
    if (activeInstallations.get(child) !== destroy) return;
    activeInstallations.delete(child);
    cleanup();
  };
  activeInstallations.set(child, destroy);
  return destroy;
}

function intersection(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return left < right && top < bottom
    ? { left, top, right, bottom, width: right - left, height: bottom - top }
    : null;
}

function visible(win, element) {
  if (!element?.isConnected || !element.getClientRects().length) return false;
  for (let node = element; node; node = node.parentElement) {
    if (node.hidden || node.getAttribute("aria-hidden") === "true") return false;
    const style = win.getComputedStyle(node);
    if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return false;
  }
  return true;
}

function textRuns(win, element, limit) {
  if (!visible(win, element)) return [];
  const elementRect = element.getBoundingClientRect();
  const clip = intersection(elementRect, limit);
  if (!clip) return [];
  const doc = win.document;
  const walk = doc.createTreeWalker(element, win.NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  const runs = [];
  let node;
  while ((node = walk.nextNode())) {
    if (!visible(win, node.parentElement)) continue;
    const style = win.getComputedStyle(node.parentElement);
    const font = style.fontWeight + " " + style.fontSize + " " + style.fontFamily;
    let index = 0;
    let run;
    for (const glyph of [...node.data].slice(0, 120)) {
      range.setStart(node, index);
      index += glyph.length;
      range.setEnd(node, index);
      const r = range.getBoundingClientRect();
      const middle = (r.top + r.bottom) / 2;
      if (!r.width || !r.height || r.left + 0.75 < clip.left || r.right - 0.75 > clip.right ||
          middle < clip.top || middle > clip.bottom) {
        run = undefined;
        continue;
      }
      if (run && Math.abs(run.right - r.left) < 1.2 && Math.abs(run.top - r.top) < 1) {
        run.text += glyph;
        run.right = r.right;
      } else {
        run = { text: glyph, left: r.left, right: r.right, top: r.top,
          middle, font, color: style.color };
        runs.push(run);
      }
    }
  }
  return runs;
}

function overlayBox(win, element, bounds, labels, textBounds = bounds) {
  if (!visible(win, element)) return null;
  const rect = element.getBoundingClientRect();
  const clip = intersection(bounds, rect);
  if (!clip) return null;
  const labelClip = intersection(clip, textBounds);
  if (!labelClip) return null;
  const runs = labels.flatMap(label => textRuns(win, label, labelClip));
  if (!runs.some(run => run.text.trim())) return null;
  const style = win.getComputedStyle(element);
  return { rect, clip, runs, bg: style.backgroundColor, border: style.borderTopColor,
    radius: Number.parseFloat(style.borderTopLeftRadius) || 0,
    borderWidth: Number.parseFloat(style.borderTopWidth) || 0 };
}

function captureOverlays(win, bounds) {
  const doc = win.document;
  const boxes = [];
  if (doc.body.matches(".clean, .campus-hud-hidden")) return boxes;
  const add = (element, labels, textBounds) => {
    const box = overlayBox(win, element, bounds, labels.filter(Boolean), textBounds);
    if (box) boxes.push(box);
  };
  const place = doc.getElementById("pp-location");
  const top = place?.closest(".pp-top") || place;
  const online = doc.querySelector("#pp-roster > span:last-child");
  const roster = doc.getElementById("ppPeople");
  const rosterRows = roster?.querySelector(".prs-rows");
  const walk = doc.getElementById("ppWalkNav");
  add(top, [place?.querySelector("#pp-place"), online]);
  if (visible(win, rosterRows)) {
    const rowBounds = intersection(bounds, rosterRows.getBoundingClientRect());
    if (rowBounds) add(roster,
      [...rosterRows.querySelectorAll(".prs-avatar, .prs-person-label > b, .prs-person-label > small")], rowBounds);
  }
  add(walk, [walk?.querySelector(".prs-distance")]);
  for (const arrival of doc.querySelectorAll(".campus-clue-arrival")) {
    add(arrival, [...arrival.querySelectorAll(":scope > .campus-clue-destination, :scope > button")]);
  }
  for (const element of doc.querySelectorAll("[data-campus-capture='public-task'],[data-campus-capture='public-location']")) {
    if (!top?.contains(element) && !roster?.contains(element) && !walk?.contains(element)) add(element, [element]);
  }
  for (const feed of doc.querySelectorAll("[data-campus-capture='public-chat']")) {
    if (!visible(win, feed)) continue;
    const feedBounds = intersection(bounds, feed.getBoundingClientRect());
    if (!feedBounds) continue;
    const rows = [...feed.querySelectorAll(":scope > .campus-chat-row")];
    const labels = (row) => [...row.querySelectorAll(":scope > .campus-chat-author, :scope > .campus-chat-message")];
    const background = feed.closest(".campus-chat-feed-surface");
    if (background) add(background, rows.flatMap(labels), feedBounds);
    else for (const row of rows) add(row, labels(row), feedBounds);
  }
  return boxes;
}

function roundedPath(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, width, height, Math.min(radius, width / 2, height / 2));
  else ctx.rect(x, y, width, height);
}

function addOverlays(output, bounds, overlays) {
  if (!bounds?.width || !bounds.height || !overlays.length) return output;
  capturedLabels.set(output, overlays.map(({ clip }) => ({
    left: (clip.left - bounds.left) / bounds.width,
    top: (clip.top - bounds.top) / bounds.height,
    right: (clip.right - bounds.left) / bounds.width,
    bottom: (clip.bottom - bounds.top) / bounds.height,
  })));
  const ctx = output.getContext("2d");
  const sx = output.width / bounds.width;
  const sy = output.height / bounds.height;
  ctx.save();
  ctx.setTransform(sx, 0, 0, sy, -bounds.left * sx, -bounds.top * sy);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const { rect, clip, bg, border, borderWidth, radius, runs } of overlays) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.left, clip.top, clip.width, clip.height);
    ctx.clip();
    roundedPath(ctx, rect.left, rect.top, rect.width, rect.height, radius);
    ctx.fillStyle = bg;
    ctx.fill();
    if (borderWidth > 0) {
      ctx.lineWidth = borderWidth;
      ctx.strokeStyle = border;
      ctx.stroke();
    }
    for (const run of runs) {
      ctx.font = run.font;
      ctx.fillStyle = run.color;
      ctx.fillText(run.text, run.left, run.middle);
    }
    ctx.restore();
  }
  ctx.restore();
  return output;
}

function freeze(doc, frame) {
  if (!frame?.width || !frame.height) throw new Error("Campus frame is blank");
  const copy = doc.createElement("canvas");
  copy.width = frame.width;
  copy.height = frame.height;
  const ctx = copy.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(frame, 0, 0);
  return copy;
}

function renderedScene(doc, canvas) {
  const sample = doc.createElement("canvas");
  sample.width = sample.height = 12;
  const ctx = sample.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, 12, 12);
  const { data } = ctx.getImageData(0, 0, 12, 12);
  const palette = new Set();
  let colored = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, alpha] = data.subarray(i, i + 4);
    if (alpha < 128) continue;
    palette.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
    if (Math.max(r, g, b) >= 18) colored += 1;
  }
  // B401's default WebGL buffer may read as opaque black after presentation.
  // Check scene pixels before the overlays add otherwise misleading contrast.
  return colored >= 24 && palette.size >= 4;
}

function readableFrame(doc, canvas) {
  try {
    const snapshot = freeze(doc, canvas);
    if (renderedScene(doc, snapshot)) return snapshot;
  } catch {}
  return null;
}

// B401's stock getFrame requests a separate clean render that skips peers,
// names, speech and route drawing. Listen to one normally composed frame.
export function beginCampusCapture(win, signal) {
  const pending = pendingFrames.get(win);
  if (pending) return pending;
  const doc = win.document;
  const world = doc.getElementById("game");
  const presence = win.PPPresence;
  const drawLabels = presence?.drawLabels;
  if (signal?.aborted || doc.hidden || !visible(win, world) || typeof drawLabels !== "function") {
    return Promise.reject(new Error("Campus scene is not ready"));
  }
  const frame = new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    function restore() {
      if (presence.drawLabels === observe) presence.drawLabels = drawLabels;
    }
    function finish() {
      settled = true;
      restore();
      win.clearTimeout(timer);
      signal?.removeEventListener("abort", unavailable);
    }
    function unavailable() {
      finish();
      reject(new Error("Campus scene is not ready"));
    }
    function observe(ctx, ...args) {
      const result = Reflect.apply(drawLabels, this, [ctx, ...args]);
      restore();
      // Resume after B401 presents this same frame. Both sources contain the
      // same actors and tags even if WebGL has already discarded its buffer.
      win.queueMicrotask(() => {
        if (settled) return;
        finish();
        try {
          const bounds = world.getBoundingClientRect();
          const viewport = { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight };
          const surface = intersection(bounds, viewport);
          const snapshot = surface && visible(win, world) &&
            (readableFrame(doc, world) || readableFrame(doc, ctx.canvas));
          if (!snapshot) throw new Error("Campus scene is not readable");
          resolve({ frame: addOverlays(snapshot, bounds, captureOverlays(win, surface)),
            context: win.PPGame.getContext?.() });
        } catch (error) { reject(error); }
      });
      return result;
    }
    presence.drawLabels = observe;
    timer = win.setTimeout(unavailable, 2500);
    signal?.addEventListener("abort", unavailable, { once: true });
  }).finally(() => pendingFrames.delete(win));
  pendingFrames.set(win, frame);
  return frame;
}

function campusDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai",
  }).format(date).replaceAll("/", ".") : "";
}

function wrapCaption(ctx, text, width) {
  const lines = [];
  let current = "";
  for (const glyph of text) {
    if (current && ctx.measureText(current + glyph).width > width) {
      lines.push(current);
      current = "";
    }
    current += glyph;
  }
  if (current) lines.push(current);
  return lines;
}

function drawPosterLabel(ctx, lines, right, width, height, obstacles, unit) {
  const edge = Math.round(24 * unit);
  const padding = Math.round(13 * unit);
  const lineHeight = Math.round(32 * unit);
  const limit = Math.round(width * (right ? 0.24 : 0.36));
  let widest = 0;
  for (const line of lines) {
    ctx.font = line.font;
    widest = Math.max(widest, ctx.measureText(line.text).width);
  }
  const boxWidth = Math.min(limit, Math.ceil(widest) + padding * 2);
  const boxHeight = lines.length * lineHeight + padding * 2;
  const left = right ? width - edge - boxWidth : edge;
  let top = height - edge - boxHeight;
  for (const obstacle of obstacles) {
    if (obstacle.left * width < left + boxWidth && obstacle.right * width > left &&
        obstacle.top * height < top + boxHeight && obstacle.bottom * height > top) {
      top = Math.floor(obstacle.top * height) - padding - boxHeight;
    }
  }
  top = Math.max(edge, top);
  roundedPath(ctx, left, top, boxWidth, boxHeight, 12 * unit);
  ctx.fillStyle = "rgba(14, 32, 27, .84)";
  ctx.fill();
  ctx.fillStyle = "#fff9e9";
  for (const [index, line] of lines.entries()) {
    ctx.font = line.font;
    ctx.fillText(line.text, left + padding, top + padding + (index + 0.5) * lineHeight, boxWidth - padding * 2);
  }
  return { left, top, right: left + boxWidth, bottom: top + boxHeight };
}

export function renderCampusPoster(canvas, frame, shot) {
  const width = 1080;
  const height = Math.max(1, Math.round(width * frame.height / frame.width));
  const unit = Math.max(0.4, Math.min(1, height / 420));
  const school = String(shot.schoolName || "河北深州市中学");
  const place = String(shot.placeName || "校园里");
  const caption = [...String(shot.caption ?? "").trim()].slice(0, 40).join("");
  const date = campusDate(shot.taken);

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(frame, 0, 0, width, height);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  const font = (weight, size) => weight + " " + Math.round(size * unit) + "px " + sans;
  const obstacles = [...(capturedLabels.get(frame) || [])].sort((a, b) => b.top - a.top);
  const lines = [{ text: school, font: font(600, 23) }, { text: place, font: font(750, 31) }];
  const captionFont = font(500, 22);
  ctx.font = captionFont;
  for (const text of wrapCaption(ctx, caption, Math.floor(width * 0.36) - 30)) lines.push({ text, font: captionFont });
  const labels = [drawPosterLabel(ctx, lines, false, width, height, obstacles, unit)];
  if (date) labels.push(drawPosterLabel(ctx, [{ text: date, font: font(550, 23) }], true, width, height, obstacles, unit));
  return { width, height, photo: { x: 0, y: 0, width, height }, labels };
}
