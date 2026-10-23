import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage, STORAGE_KEY, fingerprint } from '../src/storage.js';

test('storage failures do not stop in-memory play', () => {
  const store = createStorage(() => { throw new Error('blocked'); });
  assert.equal(store.read(), null);
  assert.equal(store.write({ answers: [] }), false);
  assert.equal(store.available, false);
  assert.equal(store.clear(), false);
});

test('reset only removes this app key', () => {
  const map = new Map([['other-app', 'keep']]);
  const store = createStorage(() => ({ getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) }));
  store.write({ answers: [['T01', 'a']] });
  assert.deepEqual(store.read(), { answers: [['T01', 'a']] });
  store.clear();
  assert.equal(map.has(STORAGE_KEY), false);
  assert.equal(map.get('other-app'), 'keep');
});

test('content changes invalidate the fingerprint', () => {
  assert.equal(fingerprint('same'), fingerprint('same'));
  assert.notEqual(fingerprint('{"score":1}'), fingerprint('{"score":2}'));
});

test('narrator storage and its reset cannot erase the recommendation record', () => {
  const map = new Map();
  const provider = () => ({ getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) });
  const quiz = createStorage(provider);
  const narrator = createStorage(provider, 'kakuseigar:narrator:v1');
  const answers = { answers: [['T01', 'a']], resultHistory: [{ resultId: 'result-1' }] };
  quiz.write(answers);
  narrator.write({ count: 100 });
  assert.deepEqual(quiz.read(), answers);
  narrator.clear();
  assert.deepEqual(quiz.read(), answers);
  assert.equal(narrator.read(), null);
  map.set('kakuseigar:narrator:v1', 'invalid json');
  assert.equal(narrator.read(), null);
  assert.deepEqual(quiz.read(), answers);
});
