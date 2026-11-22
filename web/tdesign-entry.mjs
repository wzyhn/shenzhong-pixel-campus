import { h, nextTick, ref, render, shallowReactive } from "vue";
import Alert from "tdesign-vue-next/es/alert/alert.mjs";
import Avatar from "tdesign-vue-next/es/avatar/avatar.mjs";
import Button from "tdesign-vue-next/es/button/button.mjs";
import Card from "tdesign-vue-next/es/card/card.mjs";
import Dialog from "tdesign-vue-next/es/dialog/dialog.mjs";
import Input from "tdesign-vue-next/es/input/input.mjs";
import Progress from "tdesign-vue-next/es/progress/progress.mjs";
import Select from "tdesign-vue-next/es/select/select.mjs";
import Tag from "tdesign-vue-next/es/tag/tag.mjs";
import Textarea from "tdesign-vue-next/es/textarea/textarea.mjs";
import Book from "tdesign-icons-vue-next/esm/components/book-open.js";
import Back from "tdesign-icons-vue-next/esm/components/chevron-left.js";
import Camera from "tdesign-icons-vue-next/esm/components/camera.js";
import Catalog from "tdesign-icons-vue-next/esm/components/catalog.js";
import Home from "tdesign-icons-vue-next/esm/components/home.js";
import Location from "tdesign-icons-vue-next/esm/components/location.js";
import Play from "tdesign-icons-vue-next/esm/components/play-circle.js";
import Setting from "tdesign-icons-vue-next/esm/components/setting.js";
import Share from "tdesign-icons-vue-next/esm/components/share.js";
import Sound from "tdesign-icons-vue-next/esm/components/sound.js";
import Mute from "tdesign-icons-vue-next/esm/components/sound-mute.js";
import User from "tdesign-icons-vue-next/esm/components/user.js";
import "tdesign-vue-next/es/style/index.css";

function mount(component, props, slots) {
  const element = document.createElement("div");
  render(h(component, props, slots), element);
  return element;
}

const icons = { book: Book, back: Back, camera: Camera, catalog: Catalog, home: Home, location: Location,
  play: Play, setting: Setting, share: Share, sound: Sound, mute: Mute, user: User };

export function icon(name, size = "20px") {
  return mount(icons[name], { size, "aria-hidden": "true", focusable: "false" }).firstElementChild;
}

export function avatar(text) {
  return mount(Avatar, { size: "large", alt: text }, { default: () => text }).firstElementChild;
}

export function button(text, onClick, className = "") {
  const primary = className.split(/\s+/).includes("primary");
  return mount(Button, {
    type: "button",
    class: className,
    variant: primary ? "base" : "outline",
    theme: primary ? "primary" : "default",
    content: text,
    onClick,
  }).firstElementChild;
}

export function actionLink(text, href, className = "") {
  const anchor = mount(Button, {
    tag: "a",
    href,
    class: className,
    variant: "outline",
    theme: "default",
    content: text,
  }).firstElementChild;
  anchor.removeAttribute("type");
  return anchor;
}

function adopt(content) {
  return h("div", {
    ref(element) {
      if (element && content.parentNode !== element) element.append(content);
    },
  });
}

export function card(content, className) {
  return mount(
    Card,
    { bordered: true, hoverShadow: true, class: className },
    {
      default: () => adopt(content),
    },
  ).firstElementChild;
}

export function field(kind, attributes = {}) {
  const { value, placeholder, maxlength, type, ...native } = attributes;
  const element = mount(kind === "textarea" ? Textarea : Input, {
    defaultValue: value,
    placeholder,
    maxlength,
    ...(kind === "input" && type ? { type } : {}),
  });
  const control = element.querySelector(kind);
  if (maxlength !== undefined) control.maxLength = Number(maxlength);
  for (const [name, attribute] of Object.entries(native)) control.setAttribute(name, attribute);
  return { element, control };
}

let selectCount = 0;

export function select({ id, label, options, value, onChange, disabled, placeholder }) {
  const state = shallowReactive({ options, value, disabled, open: false });
  const popupClass = "paperplane-select-popup-" + ++selectCount;
  const listId = popupClass + "-options";
  const element = mount(() =>
    h(Select, {
      options: state.options,
      value: state.value,
      disabled: state.disabled,
      placeholder,
      popupVisible: state.open,
      popupProps: { overlayClassName: popupClass },
      onPopupVisibleChange: setOpen,
      onChange(next) {
        state.value = next;
        onChange?.(next);
      },
    }),
  );
  const input = element.querySelector("input");
  if (id) input.id = id;
  if (label) input.setAttribute("aria-label", label);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");

  function getList() {
    return element.ownerDocument.getElementsByClassName(popupClass)[0]?.querySelector(".t-select__list");
  }
  function setOpen(open) {
    state.open = open;
    input.setAttribute("aria-expanded", String(open));
    if (open) void nextTick(syncOptions);
    else {
      input.removeAttribute("aria-controls");
      input.removeAttribute("aria-activedescendant");
    }
  }
  function syncOptions() {
    const list = state.open && getList();
    if (!list) return;
    list.id = listId;
    list.setAttribute("role", "listbox");
    if (label) list.setAttribute("aria-label", label);
    input.setAttribute("aria-controls", listId);
    const items = list.querySelectorAll(".t-select-option");
    for (const [index, item] of items.entries()) {
      item.id = listId + "-" + index;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(item.classList.contains("t-is-selected")));
      item.setAttribute("aria-disabled", String(item.classList.contains("t-is-disabled")));
    }
    const active = list.querySelector(".t-select-option__hover");
    if (active) input.setAttribute("aria-activedescendant", active.id);
    else input.removeAttribute("aria-activedescendant");
  }
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") void nextTick(syncOptions);
    if (event.key !== "Enter") return;
    // TDesign Input dispatches Enter separately from Select's arrow-key handler.
    event.preventDefault();
    if (state.disabled) return;
    if (!state.open) {
      setOpen(true);
      return;
    }
    const list = getList();
    const highlighted = list?.querySelector(".t-select-option__hover:not(.t-is-disabled)");
    const selected = list?.querySelector(".t-select-option.t-is-selected:not(.t-is-disabled)");
    (highlighted ?? selected)?.click();
  });
  return {
    element,
    setOptions(next) {
      state.options = next;
      if (state.open) void nextTick(syncOptions);
    },
    setValue(next) {
      state.value = next;
      if (state.open) void nextTick(syncOptions);
    },
    setDisabled(next) {
      state.disabled = next;
    },
    destroy() {
      render(null, element);
    },
  };
}

export function tag(text, theme = "primary") {
  return mount(Tag, { theme, variant: "light", content: text }).firstElementChild;
}

export function alert(text, theme = "info") {
  const message = ref(text);
  const element = mount(() => h(Alert, { theme, message: message.value }));
  element.setText = (next) => {
    message.value = next;
  };
  return element;
}

export function progress(percentage, attributes = {}) {
  return mount(Progress, {
    percentage,
    label: false,
    role: "progressbar",
    "aria-valuemin": 0,
    "aria-valuemax": 100,
    "aria-valuenow": percentage,
    ...attributes,
  }).firstElementChild;
}

export function dialog({
  title,
  content,
  onConfirm,
  onClosing,
  onClose,
  confirmLabel,
  cancelLabel,
}) {
  const visible = ref(true);
  const previousFocus = document.activeElement;
  const background = [...document.querySelectorAll("body > :is(header, main, footer, #app-shell)")].map(
    (element) => ({ element, inert: element.inert }),
  );
  let closed = false;
  function close() {
    if (!visible.value) return;
    visible.value = false;
    onClosing?.();
  }
  function destroy() {
    close();
    cleanup();
  }
  function cleanup() {
    if (closed) return;
    closed = true;
    render(null, element);
    element.remove();
    for (const { element: section, inert } of background) section.inert = inert;
    document.body.classList.remove("dialog-open");
    previousFocus?.focus();
    onClose?.();
  }
  const element = mount(() =>
    h(
      Dialog,
      {
        attach: "body",
        visible: visible.value,
        header: title,
        cancelBtn: cancelLabel || "取消",
        confirmBtn: onConfirm ? confirmLabel || "确定" : null,
        closeBtn: false,
        closeOnEscKeydown: true,
        closeOnOverlayClick: true,
        preventScrollThrough: false,
        width: "min(960px, calc(100vw - 32px))",
        class: "paperplane-dialog",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": title,
        onKeydown(event) {
          if (event.key !== "Tab") return;
          const controls = [
            ...event.currentTarget.querySelectorAll(
              "button, input, textarea, select, a[href], [tabindex]",
            ),
          ].filter(
            (control) => control.tabIndex >= 0 && !control.disabled && !control.closest("[hidden]"),
          );
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey ? event.target === first : event.target === last) {
            event.preventDefault();
            (event.shiftKey ? last : first)?.focus();
          }
        },
        onClose: close,
        onClosed: cleanup,
        onConfirm() {
          onConfirm?.();
          close();
        },
      },
      { default: () => adopt(content) },
    ),
  );
  for (const { element: section } of background) section.inert = true;
  document.body.classList.add("dialog-open");
  void nextTick(() => {
    if (visible.value) document.querySelector(".paperplane-dialog button")?.focus();
  });
  return { element, close, destroy };
}
