const grades = Array.from({ length: 11 }, (_, index) => (2026 - index) + " 级");
const hairstyles = [
  { value: "short", label: "短发" }, { value: "buzz", label: "寸头" }, { value: "pony", label: "马尾" },
];
const hairColors = [
  { value: "#2b2b2a", label: "自然黑" }, { value: "#4a3427", label: "深棕" },
  { value: "#6b4a2f", label: "棕色" }, { value: "#8d6a45", label: "浅棕" }, { value: "#3a2b26", label: "暖黑" },
];
const skinColors = [
  { value: "#f2d3b3", label: "亮色" }, { value: "#e8c9a6", label: "自然" },
  { value: "#d9b48c", label: "暖色" }, { value: "#c49a74", label: "深色" },
];
const fields = [
  { key: "grade", label: "毕业年级", options: grades.map(grade => ({ value: grade, label: grade })) },
  { key: "hair", label: "发型", options: hairstyles },
  { key: "hairC", label: "发色", options: hairColors },
  { key: "skin", label: "肤色", options: skinColors },
];
export const defaultCampusOutfit = Object.freeze({
  grade: grades[0], hair: hairstyles[0].value, hairC: hairColors[0].value, skin: skinColors[1].value,
});

export function setupCampusOutfit(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const accepted = Object.fromEntries(fields.map(({ key, options }) =>
    [key, options.find(option => option.value === value[key])?.value]));
  return Object.values(accepted).every(Boolean) ? accepted : null;
}

export function mountCampusAppearance({ doc, design, loadPainter = () => import("./campus-avatar-original.mjs") }) {
  const window = doc.defaultView;
  const selected = { ...defaultCampusOutfit };
  const preview = doc.createElement("figure");
  preview.className = "campus-avatar-preview";
  const canvas = doc.createElement("canvas");
  canvas.width = 150;
  canvas.height = 190;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "深中校服人物预览");
  const caption = doc.createElement("figcaption");
  const displayName = doc.createElement("strong");
  const description = doc.createElement("span");
  caption.append(displayName, description);
  preview.append(canvas, caption);
  const context = canvas.getContext("2d");
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const controls = [];
  let painter;
  let timer;
  let stopped = false;

  function describe(nickname) {
    displayName.textContent = nickname.trim() || "新同学";
    description.textContent = selected.grade + " · 深中校服";
  }

  function redraw(time) {
    if (painter) painter(context, canvas, reduced?.matches ? 0 : time, selected);
  }

  function animate(time) {
    if (stopped) return;
    redraw(time);
    timer = window.requestAnimationFrame(animate);
  }

  const inputs = fields.map(({ key, label, options }) => {
    const row = doc.createElement("div");
    row.className = "campus-setup-field";
    const text = doc.createElement("label");
    text.htmlFor = "campus-outfit-" + key;
    text.textContent = label;
    const control = design.select({
      id: text.htmlFor, label, options, value: selected[key],
      onChange(value) {
        if (stopped || !options.some(option => option.value === value)) return;
        selected[key] = value;
        control.setValue(value);
        description.textContent = selected.grade + " · 深中校服";
        redraw(window.performance.now());
      },
    });
    controls.push(control);
    row.append(text, control.element);
    return row;
  });

  describe("");
  const ready = loadPainter().then(({ drawCampusAvatar }) => {
    if (stopped) return;
    if (!context || typeof drawCampusAvatar !== "function") throw new Error("Original avatar preview unavailable");
    painter = drawCampusAvatar;
    redraw(window.performance.now());
    if (!reduced?.matches) timer = window.requestAnimationFrame(animate);
  });
  return {
    ready, preview, inputs, describe,
    value: () => ({ ...selected }),
    setDisabled(disabled) { for (const control of controls) control.setDisabled(disabled); },
    destroy() {
      stopped = true;
      if (timer !== undefined) window.cancelAnimationFrame(timer);
      for (const control of controls) control.destroy();
    },
  };
}



export function connectCampusDressPreview(child, loadPainter = () => import("./campus-avatar-original.mjs")) {
  const doc = child.document;
  const wardrobe = doc.getElementById("start");
  const canvas = doc.getElementById("pvc");
  const context = canvas?.getContext("2d");
  if (!wardrobe || !context) return () => {};
  const reduced = child.matchMedia?.("(prefers-reduced-motion: reduce)");
  let disposed = false;
  let loading;
  let painter;
  let frame;
  const showing = () => !disposed && doc.body.classList.contains("pp-dress");

  function repaint(time = child.performance.now()) {
    if (!showing() || !painter) return;
    const outfit = child.__ppEngine?.appearance();
    if (outfit) painter(context, canvas, reduced?.matches ? 0 : time, outfit);
  }

  function animate(time) {
    frame = undefined;
    repaint(time);
    schedule();
  }

  function schedule() {
    if (showing() && painter && !reduced?.matches && frame === undefined) {
      frame = child.requestAnimationFrame(animate);
    }
  }

  function cancelFrame() {
    if (frame === undefined) return;
    child.cancelAnimationFrame(frame);
    frame = undefined;
  }

  function refresh() {
    if (!showing()) {
      cancelFrame();
      return;
    }
    if (!painter) {
      loading ??= loadPainter().then(({ drawCampusAvatar }) => {
        if (disposed || typeof drawCampusAvatar !== "function") return;
        painter = drawCampusAvatar;
        refresh();
      }).catch(() => { loading = undefined; });
      return;
    }
    repaint();
    schedule();
  }

  function onSelection() {
    repaint();
  }

  const observer = new child.MutationObserver(refresh);
  observer.observe(doc.body, { attributes: true, attributeFilter: ["class"] });
  // Run after the packaged select/click handlers update their original model.
  for (const event of ["change", "click"]) wardrobe.addEventListener(event, onSelection);
  refresh();

  return () => {
    disposed = true;
    cancelFrame();
    observer.disconnect();
    for (const event of ["change", "click"]) wardrobe.removeEventListener(event, onSelection);
  };
}
