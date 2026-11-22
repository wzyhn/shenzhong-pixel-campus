import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { connectCampusDressPreview, defaultCampusOutfit, mountCampusAppearance, setupCampusOutfit } from "./campus-appearance.mjs";

test("setup accepts only B401 choices and excludes unrelated fields", () => {
  assert.deepEqual(setupCampusOutfit({ ...defaultCampusOutfit, email: "not-in-outfit" }), defaultCampusOutfit);
  assert.equal(setupCampusOutfit({ ...defaultCampusOutfit, grade: "2099 级" }), null);
  assert.equal(setupCampusOutfit({ ...defaultCampusOutfit, hairC: "#000000" }), null);
});

test("each official appearance control redraws the preview using its selected value", async () => {
  const portraits = [];
  const controls = new Map();
  const motions = [];
  const children = [];
  const context = {};
  const doc = {
    createElement(tag) {
      const node = { tag, children: [], append(...items) { this.children.push(...items); },
        setAttribute() {}, getContext: () => context };
      children.push(node);
      return node;
    },
    defaultView: {
      performance: { now: () => 42 },
      matchMedia: () => ({ matches: true }),
      requestAnimationFrame: fn => motions.push(fn),
    },
  };
  const design = {
    select(options) {
      const control = {
        element: {}, enabled: true, stopped: false, update: options.onChange, label: options.label,
        setValue() {},
        setDisabled(disabled) { this.enabled = !disabled; },
        destroy() { this.stopped = true; },
      };
      controls.set(options.id, control);
      return control;
    },
  };
  const appearance = mountCampusAppearance({
    doc, design,
    loadPainter: async () => ({ drawCampusAvatar(ctx, canvas, time, outfit) {
      assert.equal(ctx, context);
      assert.equal(canvas.width, 150);
      assert.equal(canvas.height, 190);
      assert.equal(time, 0);
      portraits.push({ ...outfit });
    } }),
  });
  await appearance.ready;
  assert.deepEqual(portraits.at(-1), defaultCampusOutfit);
  assert.equal(controls.get("campus-outfit-grade").label, "毕业年级");
  assert(children.some(node => node.tag === "label" && node.htmlFor === "campus-outfit-grade" && node.textContent === "毕业年级"));
  for (const [key, value] of [["grade", "2021 级"], ["hair", "pony"], ["hairC", "#8d6a45"], ["skin", "#c49a74"]]) {
    const before = portraits.length;
    controls.get("campus-outfit-" + key).update(value);
    assert.equal(portraits.length, before + 1);
    assert.equal(portraits.at(-1)[key], value);
  }
  const before = portraits.length;
  controls.get("campus-outfit-skin").update("invalid");
  assert.equal(portraits.length, before);
  assert.deepEqual(appearance.value(), { grade: "2021 级", hair: "pony", hairC: "#8d6a45", skin: "#c49a74" });
  appearance.describe(" 合成玩家 ");
  assert(children.some(node => node.textContent === "合成玩家"));
  assert(children.some(node => node.textContent === "2021 级 · 深中校服"));
  assert.equal(motions.length, 0);
  appearance.setDisabled(true);
  assert([...controls.values()].every(control => !control.enabled));
  appearance.destroy();
  assert([...controls.values()].every(control => control.stopped));
});

test("original wardrobe preview draws each active selection and stops outside the wardrobe", async () => {
  const portraits = [];
  const animations = new Map();
  let watching = false;
  let open = false;
  let changed;
  let counter = 0;
  let loads = 0;
  let selection = { ...defaultCampusOutfit };
  const wardrobe = new EventTarget();
  const context = {};
  const canvas = { getContext: () => context };
  const child = {
    document: {
      getElementById: id => id === "start" ? wardrobe : canvas,
      body: { classList: { contains: name => name === "pp-dress" && open } },
    },
    __ppEngine: { appearance: () => selection },
    performance: { now: () => 42 },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame(callback) {
      animations.set(++counter, callback);
      return counter;
    },
    cancelAnimationFrame(id) { animations.delete(id); },
    MutationObserver: class {
      constructor(callback) { changed = callback; }
      observe() { watching = true; }
      disconnect() { watching = false; }
    },
  };
  const stop = connectCampusDressPreview(child, async () => {
    loads++;
    return { drawCampusAvatar(ctx, node, time, outfit) {
      assert.equal(ctx, context);
      assert.equal(node, canvas);
      portraits.push({ time, ...outfit });
    } };
  });

  assert(watching);
  assert.equal(loads, 0);
  open = true;
  changed();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads, 1);
  assert.equal(portraits.length, 1);
  assert.equal(animations.size, 1);
  selection = { ...selection, grade: "2020 级", hair: "pony", hairC: "#8d6a45", skin: "#c49a74" };
  wardrobe.dispatchEvent(new Event("change"));
  assert.deepEqual(portraits.at(-1), { time: 42, ...selection });
  open = false;
  changed();
  assert.equal(animations.size, 0);
  const before = portraits.length;
  wardrobe.dispatchEvent(new Event("click"));
  assert.equal(portraits.length, before);
  stop();
  assert.equal(watching, false);
  open = true;
  wardrobe.dispatchEvent(new Event("click"));
  assert.equal(portraits.length, before);
});
