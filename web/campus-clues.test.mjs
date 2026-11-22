import assert from "node:assert/strict";
import test from "node:test";
import { campusClueShareURL, readCampusClue, readCampusClueAnswer } from "./campus-clues.mjs";

const origin = "https://campus.example.invalid";
const clue = {
  id: "garden-01", title: "照片拍于哪里？", image: "/images/campus-clues/q1.webp",
  choices: [{ id: "a", label: "西南门" }, { id: "b", label: "文瑞苑" }, { id: "c", label: "北门" }],
};
const place = { id: "wenrui-garden", label: "文瑞苑", light: "day", zoom: 1.8, facing: "up" };

test("a clue card exposes only the question, local illustration and choices", () => {
  const result = readCampusClue({ ...clue, correct: "b", place, choices: clue.choices.map(item => ({ ...item, correct: item.id === "b" })) }, origin);
  assert.deepEqual(result, { ...clue, image: origin + clue.image });
  for (const item of [
    { ...clue, id: "../garden" }, { ...clue, id: "x".repeat(41) },
    { ...clue, image: "https://elsewhere.test/s.png" }, { ...clue, image: "javascript:alert(1)" },
    { ...clue, image: "/images/one.png#place=wenrui-garden" },
    { ...clue, choices: [{ id: "z", label: "湖边" }] }, { ...clue, choices: [clue.choices[0], clue.choices[0]] },
  ]) assert.equal(readCampusClue(item, origin), null);
});

test("either outcome preserves the server's valid original destination", () => {
  for (const correct of [true, false]) {
    assert.deepEqual(readCampusClueAnswer({ correct, place: { ...place, private: "ignored" } }), { correct, place });
  }
  for (const value of [
    { correct: "true", place }, { correct: true, place: { ...place, id: "/garden" } },
    { correct: true, place: { ...place, light: "sunny" } }, { correct: false, place: { ...place, facing: "north" } },
    { correct: false, place: { ...place, zoom: 3 } },
  ]) assert.equal(readCampusClueAnswer(value), null);
});

test("sharing uses only the canonical public question URL", () => {
  const target = "/?clue=garden-01";
  assert.equal(campusClueShareURL(target, clue.id, origin), origin + target);
  assert.equal(campusClueShareURL(origin + target, clue.id, origin), origin + target);
  for (const url of [target + "&choice=b", target + "&clue=garden-01", target + "#place=wenrui-garden", "/clues?clue=garden-01", "https://elsewhere.test" + target]) {
    assert.equal(campusClueShareURL(url, clue.id, origin), null);
  }
});
