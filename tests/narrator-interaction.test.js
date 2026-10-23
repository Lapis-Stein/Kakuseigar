import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NarratorInteraction,
  NARRATOR_DIALOGUE_POOLS,
  NARRATOR_HANDOFF_LINE,
  NARRATOR_BROKEN_LINE,
} from '../src/narrator-interaction.js';

const create = (options = {}) => new NarratorInteraction({
  datasetVersion: 'narrator-tests-v1', random: () => 0, ...options,
});
const reach = (interaction, count, route = '#/play') => {
  let line;
  while (interaction.count < count) line = interaction.tap(route);
  return line;
};

test('each boundary changes immediately and the next tap is accepted', () => {
  const interaction = create();
  assert.equal(interaction.actor, 'seiga');
  assert.equal(interaction.level, 0);
  for (const [count, level] of [[1, 1], [9, 1], [10, 2], [19, 2], [20, 3], [29, 3], [30, 4], [39, 4]]) {
    assert.ok(NARRATOR_DIALOGUE_POOLS[level].includes(reach(interaction, count)));
    assert.equal(interaction.count, count);
    assert.equal(interaction.level, level);
    assert.equal(interaction.actor, 'seiga');
  }
  assert.equal(interaction.tap('#/favorite'), NARRATOR_HANDOFF_LINE);
  assert.equal(interaction.count, 40);
  assert.equal(interaction.actor, 'robot');
  assert.equal(interaction.level, 0);
  assert.ok(NARRATOR_DIALOGUE_POOLS.robot.includes(interaction.tap('#/favorite')));
  assert.equal(interaction.count, 41);
});

test('the entire robot period uses one unchanged pool with no adjacent repeated lines', () => {
  const interaction = create();
  reach(interaction, 40);
  let previous;
  for (let count = 41; count <= 99; count += 1) {
    const line = interaction.tap('#/play');
    assert.ok(NARRATOR_DIALOGUE_POOLS.robot.includes(line), `robot line at ${count}`);
    assert.notEqual(line, previous, `repeat at ${count}`);
    assert.equal(interaction.actor, 'robot');
    assert.equal(interaction.level, 0);
    assert.equal(interaction.returnRoute, null);
    previous = line;
  }
});

test('human dialogue avoids consecutive repeats even with a constant random source', () => {
  const interaction = create();
  let previous;
  for (let count = 1; count <= 39; count += 1) {
    const line = interaction.tap('#/start');
    assert.notEqual(line, previous);
    previous = line;
  }
});

test('100 records the current route once and additional taps cannot change the achievement', () => {
  const interaction = create();
  reach(interaction, 99, '#/play');
  assert.equal(interaction.tap('#/review/result-2'), NARRATOR_BROKEN_LINE);
  assert.equal(interaction.count, 100);
  assert.equal(interaction.actor, 'broken');
  assert.equal(interaction.level, 0);
  assert.equal(interaction.returnRoute, '#/review/result-2');
  const state = interaction.exportState();
  for (let index = 0; index < 10; index += 1) assert.equal(interaction.tap('#/about'), NARRATOR_BROKEN_LINE);
  assert.deepEqual(interaction.exportState(), state);
});

test('resuming resets to zero and permits the same full cycle again', () => {
  const interaction = create();
  for (let cycle = 0; cycle < 3; cycle += 1) {
    assert.ok(NARRATOR_DIALOGUE_POOLS[1].includes(interaction.tap('#/play')));
    assert.equal(interaction.count, 1);
    reach(interaction, 40);
    assert.equal(interaction.actor, 'robot');
    reach(interaction, 100, '#/result/result-4');
    assert.equal(interaction.resume(), '#/result/result-4');
    assert.equal(interaction.count, 0);
    assert.equal(interaction.actor, 'seiga');
    assert.equal(interaction.returnRoute, null);
    assert.deepEqual(create({ saved: interaction.exportState() }).exportState(), interaction.exportState());
  }
});

test('reloading preserves stable state without consuming randomness or keeping dialogue memory', () => {
  for (const count of [0, 1, 39, 40, 41, 99, 100]) {
    const interaction = create();
    reach(interaction, count, '#/history');
    const restored = create({ saved: interaction.exportState(), random: () => { throw new Error('Unexpected random draw'); } });
    assert.deepEqual(restored.exportState(), interaction.exportState());
    assert.equal(restored.actor, interaction.actor);
    assert.equal(restored.level, interaction.level);
  }
});

test('all supported return routes survive restore and unsupported routes use a null fallback', () => {
  const valid = ['#/start', '#/play', '#/favorite', '#/history', '#/about', '#/ending', '#/result/result-1', '#/review/result-17'];
  const invalid = [undefined, null, '', '/', '#/achievement', '#/play?next=bad', '#/result/result-0', '#/result/result-01', '#/result/result--1', '#/result/result-1/extra', 'https://example.com', 'javascript:alert(1)', '#/play\n'];
  for (const route of [...valid, ...invalid]) {
    const interaction = create();
    reach(interaction, 99);
    interaction.tap(route);
    const expected = valid.includes(route) ? route : null;
    assert.equal(interaction.returnRoute, expected);
    assert.equal(create({ saved: interaction.exportState() }).returnRoute, expected);
  }
});

test('bad or obsolete narrator records reset independently without mutating supplied records', () => {
  const blank = create().exportState();
  const invalid = [null, [], 'bad', {},
    { ...blank, version: 0 }, { ...blank, datasetVersion: 'previous-data' },
    ...[-1, 101, 1.5, Infinity, NaN, '40'].map((count) => ({ ...blank, count })),
    { ...blank, count: 40, returnRoute: '#/play' },
    { ...blank, count: 100, returnRoute: 'https://example.com' },
    { ...blank, count: 100, returnRoute: undefined },
  ];
  for (const saved of invalid) {
    const before = structuredClone(saved);
    assert.deepEqual(create({ saved }).exportState(), blank);
    assert.deepEqual(saved, before);
  }
  const saved = { ...blank, count: 40, unknownField: 'not exported' };
  assert.deepEqual(create({ saved }).exportState(), { ...blank, count: 40 });
});

test('explicit reset clears the count, route and reaction memory', () => {
  const interaction = create();
  const firstLine = interaction.tap('#/start');
  reach(interaction, 100);
  interaction.reset();
  assert.equal(interaction.count, 0);
  assert.equal(interaction.returnRoute, null);
  assert.equal(interaction.tap('#/start'), firstLine);
});
