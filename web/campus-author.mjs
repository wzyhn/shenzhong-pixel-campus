import { wechatID } from "./campus-contact.mjs";

export function connectCampusAuthor(child) {
  const doc = child.document;
  const stage = doc.getElementById("ppStage");
  if (!wechatID || !stage || doc.getElementById("campus-author")) return () => {};

  const root = doc.createElement("div");
  root.id = "campus-author";
  const badge = doc.createElement("button");
  badge.type = "button";
  badge.textContent = "Re";
  badge.setAttribute("aria-label", "原校园作者 Re");
  badge.setAttribute("aria-controls", "campus-author-contact");
  badge.setAttribute("aria-expanded", "false");

  const contact = doc.createElement("section");
  contact.id = "campus-author-contact";
  contact.setAttribute("aria-labelledby", "campus-author-title");
  contact.setAttribute("aria-describedby", "campus-author-note");
  contact.tabIndex = -1;
  contact.hidden = true;
  const title = doc.createElement("strong");
  title.id = "campus-author-title";
  title.textContent = "原校园作者 Re";
  const description = doc.createElement("p");
  description.id = "campus-author-note";
  description.textContent = "如遇到 Bug，或想交流学习，请加微信。";
  const row = doc.createElement("div");
  const label = doc.createElement("label");
  label.htmlFor = "campus-author-wechat";
  label.textContent = "微信";
  const value = doc.createElement("input");
  value.id = label.htmlFor;
  value.type = "text";
  value.readOnly = true;
  value.value = wechatID;
  const copy = doc.createElement("button");
  copy.type = "button";
  copy.textContent = "复制";
  copy.setAttribute("aria-label", "复制微信号");
  const status = doc.createElement("p");
  status.setAttribute("role", "status");
  row.append(label, value, copy);
  contact.append(title, description, row, status);
  root.append(badge, contact);
  stage.append(root);
  let epoch = 0;

  function setOpen(open, restoreFocus = false) {
    if (contact.hidden === !open) return;
    epoch++;
    contact.hidden = !open;
    badge.setAttribute("aria-expanded", String(open));
    copy.textContent = "复制";
    delete status.dataset.copied;
    status.textContent = "";
    if (open) contact.focus({ preventScroll: true });
    else if (restoreFocus) badge.focus({ preventScroll: true });
  }

  function close() { setOpen(false); }
  function outside(event) {
    if (!root.contains(event.target)) close();
  }
  function focusOutside(event) {
    if (event.relatedTarget && !root.contains(event.relatedTarget)) close();
  }
  function escape(event) {
    if (event.key !== "Escape" || contact.hidden || event.isComposing) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setOpen(false, true);
  }

  function legacyCopy() {
    value.focus({ preventScroll: true });
    value.select();
    value.setSelectionRange(0, wechatID.length);
    if (typeof doc.execCommand !== "function" || !doc.execCommand("copy")) return false;
    copy.focus({ preventScroll: true });
    return true;
  }

  badge.addEventListener("click", () => setOpen(contact.hidden, true));
  copy.addEventListener("click", async () => {
    const attempt = ++epoch;
    let copied = false;
    try {
      if (child.navigator.clipboard?.writeText) {
        await child.navigator.clipboard.writeText(wechatID);
        copied = true;
      } else copied = legacyCopy();
    } catch {
      if (attempt !== epoch) return;
      try { copied = legacyCopy(); } catch { /* The text remains selectable. */ }
    }
    if (attempt !== epoch) return;
    copy.textContent = copied ? "已复制" : "复制";
    status.toggleAttribute("data-copied", copied);
    status.textContent = copied ? "已复制微信号" : "可长按或选中文字复制";
  });
  root.addEventListener("focusout", focusOutside);
  doc.addEventListener("pointerdown", outside, true);
  doc.addEventListener("keydown", escape, true);
  child.addEventListener("campus:hide-hud", close);
  child.addEventListener("pp:scene-change", close);

  return () => {
    epoch++;
    root.removeEventListener("focusout", focusOutside);
    doc.removeEventListener("pointerdown", outside, true);
    doc.removeEventListener("keydown", escape, true);
    child.removeEventListener("campus:hide-hud", close);
    child.removeEventListener("pp:scene-change", close);
    root.remove();
  };
}
