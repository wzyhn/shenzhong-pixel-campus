const choices = (a, b, c) => Object.freeze([a, b, c].map((label, index) =>
  Object.freeze({ id: String.fromCharCode(97 + index), label })));

const entries = [
  {
    id: 'q-7f2a9c4d',
    title: '认一认马路边的这一角',
    choices: choices('北门', '西南门', '东南门'),
    answer: 'b',
    place: { id: 'southwest-gate', label: '西南门', light: 'day', zoom: 1.82, facing: 'up' },
    atlasIndex: 1,
  },
  {
    id: 'q-a1e6038b',
    title: '这条弯道围着哪里？',
    choices: choices('篮球场', '风雨操场', '操场'),
    answer: 'c',
    place: { id: 'field', label: '操场', light: 'day', zoom: 1.42, facing: 'up' },
    atlasIndex: 3,
  },
  {
    id: 'q-c5927d4e',
    title: '找一找这面红砖外墙',
    choices: choices('主教学楼', '西教学楼', '教研楼'),
    answer: 'a',
    place: { id: 'main-teaching', label: '主教学楼', light: 'day', zoom: 1.66, facing: 'up' },
    atlasIndex: 26,
  },
].map(({ id, title, choices, answer, place, atlasIndex }) => Object.freeze({
  clue: Object.freeze({ id, title, image: `/images/clues/${id}.webp`, choices }),
  answer,
  place: Object.freeze(place),
  atlasIndex,
}));

const byID = new Map(entries.map((entry) => [entry.clue.id, entry]));

export const campusClues = Object.freeze(entries.map((entry) => entry.clue));

// Used only by the build, never in the catalog HTTP projection.
export const campusClueArtSources = Object.freeze(entries.map(({ clue, place, atlasIndex }) =>
  Object.freeze({ id: clue.id, placeID: place.id, label: place.label, atlasIndex })));

export function findCampusClue(id) {
  return byID.get(id)?.clue;
}

export function answerCampusClue(id, choice) {
  const entry = byID.get(id);
  if (!entry || !entry.clue.choices.some((offered) => offered.id === choice)) return null;
  return { correct: choice === entry.answer, place: entry.place };
}
