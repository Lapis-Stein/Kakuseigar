import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuestionPortraits } from '../src/portraits.js';

const pool = ['idle', 'amused', 'listening', 'adjusting-glasses', 'thinking', 'sleeve-smile'];

test('redraws and returning from history keep the current portrait without another draw', () => {
  let calls = 0;
  const portraits = new QuestionPortraits(pool, { random: () => { calls++; return 0.5; } });
  const first = portraits.forQuestion('question:1:T01');
  for (let i = 0; i < 10; i++) assert.equal(portraits.forQuestion('question:1:T01'), first);
  assert.equal(calls, 1);
});

test('ordinary and character questions never repeat adjacent portraits', () => {
  const portraits = new QuestionPortraits(pool, { random: () => 0 });
  const screens = ['question:1:T01', 'question:1:T02', 'favorite:1:seiga', 'question:1:T03', 'question:2:T04'];
  const shown = screens.map(key => portraits.forQuestion(key));
  shown.forEach((portrait, i) => {
    assert.ok(pool.includes(portrait));
    if (i) assert.notEqual(portrait, shown[i - 1]);
  });
});

test('each portrait can be selected initially and each other portrait after it', () => {
  for (let first = 0; first < pool.length; first++) {
    const expected = pool.filter(id => id !== pool[first]);
    for (let next = 0; next < expected.length; next++) {
      const draws = [(first + 0.5) / pool.length, (next + 0.5) / expected.length];
      const portraits = new QuestionPortraits(pool, { random: () => draws.shift() });
      assert.equal(portraits.forQuestion('question:1:T01'), pool[first]);
      assert.equal(portraits.forQuestion('question:1:T02'), expected[next]);
    }
  }
});

test('undo preserves an earlier assignment when it does not repeat the current portrait', () => {
  let calls = 0;
  const portraits = new QuestionPortraits(pool, { random: () => { calls++; return 0; } });
  const first = portraits.forQuestion('question:1:T01');
  portraits.forQuestion('question:1:T02');
  assert.equal(portraits.forQuestion('question:1:T01'), first);
  assert.equal(calls, 2);
});

test('revisiting an earlier question rerolls only if its cached image would repeat', () => {
  const portraits = new QuestionPortraits(pool, { random: () => 0 });
  const first = portraits.forQuestion('question:1:T01');
  portraits.forQuestion('question:1:T02');
  assert.equal(portraits.forQuestion('question:1:T03'), first);
  const revisited = portraits.forQuestion('question:1:T01');
  assert.notEqual(revisited, first);
  assert.equal(portraits.forQuestion('question:1:T01'), revisited);
});

test('reset starts a fresh play without retaining prior image assignments', () => {
  const draws = [0, 0.99];
  const portraits = new QuestionPortraits(pool, { random: () => draws.shift() });
  assert.equal(portraits.forQuestion('question:1:T01'), 'idle');
  portraits.reset();
  assert.equal(portraits.forQuestion('question:1:T01'), 'sleeve-smile');
});

test('the configured image pool is copied and must allow nonrepeating choices', () => {
  const configured = [...pool];
  const portraits = new QuestionPortraits(configured, { random: () => 0.99 });
  configured.splice(0);
  assert.equal(portraits.forQuestion('question:1:T01'), 'sleeve-smile');
  for (const invalid of [[], ['idle'], ['idle', 'idle'], ['idle', '']]) {
    assert.throws(() => new QuestionPortraits(invalid), TypeError);
  }
});
