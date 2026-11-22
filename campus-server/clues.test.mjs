import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createCampusServer } from './server.mjs';

const origin = 'https://campus.example.invalid';
const base = '/api/campus/clues';
const cases = [
  { id: 'q-7f2a9c4d', answer: 'b', place: { id: 'southwest-gate', label: '西南门', light: 'day', zoom: 1.82, facing: 'up' } },
  { id: 'q-a1e6038b', answer: 'c', place: { id: 'field', label: '操场', light: 'day', zoom: 1.42, facing: 'up' } },
  { id: 'q-c5927d4e', answer: 'a', place: { id: 'main-teaching', label: '主教学楼', light: 'day', zoom: 1.66, facing: 'up' } },
];

test('authored clues serve private answers only after a valid same-origin selection without account storage', async (context) => {
  const store = new Proxy({}, { get() { throw new Error('clues cannot read or write player state'); } });
  const errors = [];
  const server = createCampusServer({ store, onError: (error) => errors.push(error) }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  async function get(path, expected, headers = {}) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + path, { headers });
    assert.equal(response.status, expected);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    return response.json();
  }

  async function post(path, body, expected, headers = {}) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + path, {
      method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    assert.equal(response.status, expected);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    return response.json();
  }

  const { clues } = await get(base, 200);
  assert.deepEqual(clues.map(({ id }) => id), cases.map(({ id }) => id));
  for (const [index, clue] of clues.entries()) {
    assert.deepEqual(Object.keys(clue).sort(), ['choices', 'id', 'image', 'title']);
    assert.match(clue.id, /^[a-z0-9-]{1,40}$/);
    assert.equal(clue.image, '/images/clues/' + clue.id + '.webp');
    assert.ok(clue.title);
    assert.deepEqual(clue.choices.map(({ id }) => id), ['a', 'b', 'c']);
    for (const choice of clue.choices) assert.deepEqual(Object.keys(choice).sort(), ['id', 'label']);
    assert.deepEqual(await get(base + '/' + clue.id, 200), { clue });

    const { answer, place } = cases[index];
    for (const { id } of clue.choices) {
      assert.deepEqual(await post(base + '/' + clue.id + '/answer', { choice: id }, 200), { correct: id === answer, place });
    }
  }
  const endpoint = base + '/' + cases[0].id + '/answer';
  await get(base, 403, { origin: 'https://another.example' });
  await get(base, 403, { 'sec-fetch-site': 'cross-site' });
  await get(base + '/q-not-there', 404);
  await get(base + '/q-7F2A9C4D', 404);
  await get(base + '/q%2F7f2a9c4d', 404);
  await get(base + '/' + cases[0].id + '?choice=b', 404);
  await get(endpoint, 404);
  await post(endpoint, { choice: 'b' }, 403, { origin: 'https://another.example' });
  await post(endpoint, { choice: 'b' }, 403, { 'sec-fetch-site': 'same-site' });
  await post(endpoint, { choice: 'b' }, 415, { 'content-type': 'text/plain' });
  await post(endpoint, { choice: ':'.repeat(300) }, 413);
  await post(endpoint, { choice: 'b', place: 'send-data' }, 400);
  await post(endpoint, { choice: ['b'] }, 400);
  await post(endpoint, { choice: 'd' }, 400);
  await post(base + '/q-not-there/answer', { choice: 'b' }, 404);
  assert.deepEqual(errors, []);
});
