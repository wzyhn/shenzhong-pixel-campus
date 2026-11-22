import assert from "node:assert/strict";
import test from "node:test";
import {
  campusChatKeyboardOffset,
  campusEmojiTrayPosition,
  createCampusChatViewportScheduler,
  normalizeCampusChatText,
  readCampusChatHistory,
  readCampusChatPublish,
} from "./campus-chat.mjs";

const publicMessage = {
  id: "9b314e9c-3ccc-4e7f-af5d-e24916f85c37",
  nickname: "同学",
  text: "操场见👋",
  created_at: "2026-11-21T11:00:00.000Z",
  own: false,
};

test("composer accepts 40 Unicode code points and a single line of well-formed text", () => {
  assert.equal(normalizeCampusChatText(`  ${"🦊".repeat(40)}  `), "🦊".repeat(40));
  for (const value of ["  ", "🦊".repeat(41), "a\nb", "a\u2028b", "x\ud800", "x\u008a", "x\u202e", "\u0301\u200d", null]) {
    assert.equal(normalizeCampusChatText(value), "");
  }
});

test("viewport events share a cancellable animation frame", () => {
  const frames = new Map();
  let next = 0;
  let measurements = 0;
  const viewport = createCampusChatViewportScheduler({
    requestAnimationFrame(callback) { frames.set(++next, callback); return next; },
    cancelAnimationFrame(frame) { frames.delete(frame); },
  }, () => { measurements++; });
  viewport.request();
  viewport.request();
  assert.equal(frames.size, 1);
  assert.equal(measurements, 0);
  const [first, measure] = [...frames][0];
  frames.delete(first);
  measure();
  assert.equal(measurements, 1);
  viewport.request();
  viewport.cancel();
  assert.equal(frames.size, 0);
  assert.equal(measurements, 1);
});

test("emoji tray uses the original view transform and stays inside the stage near all edges", () => {
  const stage = { left: 50, top: 20, width: 400, height: 600 };
  const view = { x: 200, y: 500, w: 400, h: 600, zoom: 2 };
  const tray = { width: 200, height: 130 };
  assert.deepEqual(campusEmojiTrayPosition(view, { x: 10, y: 22 }, stage, stage, tray), { x: 140, y: 220 });
  assert.deepEqual(campusEmojiTrayPosition({ ...view, x: 216 }, { x: 10, y: 22 }, stage, stage, tray), { x: 108, y: 220 });
  assert.deepEqual(campusEmojiTrayPosition(view, { x: 6, y: 16 }, stage, stage, tray), { x: 8, y: 36 });
  assert.deepEqual(campusEmojiTrayPosition(view, { x: 20, y: 30 }, stage, stage, tray), { x: 192, y: 462 });
  assert.equal(campusEmojiTrayPosition(null, { x: 20, y: 30 }, stage, stage, tray), null);
});

test("history accepts only the bounded public-row contract and keeps server order", () => {
  const own = { ...publicMessage, id: "0b22844e-a9a3-4fb8-b7fe-c95e10f070a4", own: true };
  assert.deepEqual(readCampusChatHistory({ messages: [{ ...publicMessage, player_id: "discarded" }, own] }), [publicMessage, own]);
  assert.deepEqual(readCampusChatHistory({ messages: [] }), []);
  for (const value of [
    { status: "pending" },
    { messages: [{ ...publicMessage, id: "another" }] },
    { messages: [{ ...publicMessage, own: "yes" }] },
    { messages: [{ ...publicMessage, text: "draft\n" }] },
    { messages: [{ ...publicMessage, created_at: "invalid" }] },
    { messages: [publicMessage, publicMessage] },
    { messages: Array(31).fill(publicMessage) },
  ]) assert.equal(readCampusChatHistory(value), null);
});

test("only a published receipt with the sender's exact text can update their public feed", () => {
  const message = { ...publicMessage, own: true };
  const text = message.text;
  assert.deepEqual(readCampusChatPublish({ status: "published", message }, text), message);
  assert.deepEqual(readCampusChatPublish({ status: "approved", message }, text), message);
  assert.equal(readCampusChatPublish({ status: "pending", message }, text), null);
  assert.equal(readCampusChatPublish({ status: "revoked", message }, text), null);
  assert.equal(readCampusChatPublish({ status: "published", message }, "另一个草稿"), null);
  assert.equal(readCampusChatPublish({ status: "published", message: publicMessage }, text), null);
});

test("keyboard offset uses the clipped child or parent viewport and handles an iframe offset", () => {
  const viewport = (height, offsetTop = 0) => ({ height, offsetTop });
  assert.equal(campusChatKeyboardOffset(800, viewport(800), 800, viewport(800)), 0);
  assert.equal(campusChatKeyboardOffset(800, viewport(475, 25), 800, viewport(800)), 300);
  assert.equal(campusChatKeyboardOffset(740, viewport(740), 800, viewport(470, 45)), 285);
  assert.equal(campusChatKeyboardOffset(740, viewport(600), 800, viewport(470, 45)), 285);
  assert.equal(campusChatKeyboardOffset(300, viewport(1), 310, viewport(1)), 224);
  assert.equal(campusChatKeyboardOffset(740, null, undefined, undefined), 0);
});
