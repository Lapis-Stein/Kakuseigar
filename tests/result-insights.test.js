import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createResultInsights, REMARK_DRAFTS } from '../src/result-insights.js';

const runtime = JSON.parse(await readFile(new URL('../data/runtime.json', import.meta.url), 'utf8'));
const keys = Object.keys(runtime.features.taste);
const keyOf = pair => [...pair].sort().join('|');
const valuesOf = insight => Object.fromEntries(insight.features.map(row => [row.key, row.interest]));

function fromWeights(weights, options = {}) {
  const data = structuredClone(runtime);
  data.questions.push({ id: 'TEST_TASTE', channel: 'taste', options: [{ id: 'a', weights }] });
  return createResultInsights({ data, answers: [['TEST_TASTE', 'a']], result: { workId: '01', answerCount: 1 }, ...options });
}

test('historical insight only uses the answers available at recommendation time', () => {
  const prefix = [['T01', 'a'], ['T02', 'b']];
  const result = { workId: '01', answerCount: prefix.length };
  const original = createResultInsights({ data: runtime, answers: prefix, result });
  const continued = createResultInsights({ data: runtime, answers: [...prefix, ['T03', 'b']], result });
  assert.deepEqual(continued, original);
  assert.deepEqual(valuesOf(original), { banter: 33, schemes: 0, craft: 50, action: 0, warmth: 17, reflection: 0, values: 0 });
  assert.deepEqual(original.features.map(row => row.key), keys);
  assert.deepEqual(original.features.map(row => row.label), Object.values(runtime.features.taste));
  assert.deepEqual(original.features.map(row => row.value), Object.values(runtime.works[0].taste));
  // A later response is not parsed as part of an earlier result.
  assert.deepEqual(createResultInsights({ data: runtime, answers: [...prefix, ['later', 'unknown']], result }), original);
});

test('behavior answers and skipped taste questions do not dilute the interest distribution', () => {
  const behavior = runtime.questions.find(question => question.channel === 'behavior');
  const answers = [['T01', 'a'], [behavior.id, behavior.options[0].id], ['T02', null]];
  const insight = createResultInsights({ data: runtime, answers, result: { workId: '01', answerCount: answers.length } });
  assert.equal(insight.hasInterests, true);
  assert.equal(valuesOf(insight).banter, 67);
  assert.equal(valuesOf(insight).warmth, 33);
  assert.equal(insight.features.reduce((sum, row) => sum + row.interest, 0), 100);
});

test('all skipped or behavior-only answers remain missing rather than zero interest', () => {
  const behavior = runtime.questions.find(question => question.channel === 'behavior');
  for (const answers of [[], [['T01', null]], [[behavior.id, behavior.options[0].id]]]) {
    const insight = createResultInsights({ data: runtime, answers, result: { workId: '01', answerCount: answers.length } });
    assert.equal(insight.hasInterests, false);
    assert.ok(insight.features.every(row => row.interest === null && row.hasSignal === false));
    assert.deepEqual(insight.remark.pair, []);
    assert.match(insight.remark.text, /お返事が足りません/);
  }
});

test('integer percentages total 100 with stable remainder ties and preserve small signals', () => {
  const thirds = fromWeights({ banter: 1, schemes: 1, craft: 1 });
  assert.deepEqual(thirds.features.slice(0, 3).map(row => row.interest), [34, 33, 33]);
  const seventh = fromWeights(Object.fromEntries(keys.map(key => [key, 1])));
  assert.deepEqual(seventh.features.map(row => row.interest), [15, 15, 14, 14, 14, 14, 14]);
  assert.equal(seventh.features.reduce((sum, row) => sum + row.interest, 0), 100);
  const small = fromWeights({ banter: 999, craft: 1 });
  assert.deepEqual(small.features.find(row => row.key === 'craft'), {
    key: 'craft', label: runtime.features.taste.craft, interest: 0, hasSignal: true, value: runtime.works[0].taste.craft,
  });
  assert.equal(small.features.find(row => row.key === 'warmth').hasSignal, false);
});

test('the common four-interval scale expands to fit the largest displayed percentage', () => {
  const cases = [
    [{ banter: 1, schemes: 1, craft: 1, action: 1, warmth: 1 }, 20],
    [{ banter: 25, schemes: 15, craft: 35, warmth: 20, values: 5 }, 40],
    [{ banter: 45, craft: 30, warmth: 25 }, 60],
    [{ banter: 65, craft: 35 }, 80],
    [{ banter: 100 }, 100],
  ];
  for (const [weights, maximum] of cases) {
    const { scale, features } = fromWeights(weights);
    assert.equal(scale.maximum, maximum);
    assert.deepEqual(scale.ticks, [0, maximum / 4, maximum / 2, maximum * 3 / 4, maximum]);
    assert.ok(features.every(row => row.interest <= maximum));
  }
});

test('all 21 distinct pairs have approved remarks independent of first and second order', () => {
  const expected = new Set(keys.flatMap((left, index) => keys.slice(index + 1).map(right => keyOf([left, right]))));
  assert.equal(REMARK_DRAFTS.length, 21);
  assert.deepEqual(new Set(REMARK_DRAFTS.map(row => keyOf(row.pair))), expected);
  for (const draft of REMARK_DRAFTS) {
    assert.ok(draft.text.length > 0);
    const [a, b] = draft.pair;
    const forward = fromWeights({ [a]: 2, [b]: 1 }).remark;
    const reversed = fromWeights({ [a]: 1, [b]: 2 }).remark;
    assert.deepEqual(forward, draft);
    assert.deepEqual(reversed, draft);
  }
});

test('single-feature and selection-boundary ties do not fabricate a pair', () => {
  const single = fromWeights({ craft: 1 });
  assert.deepEqual(single.remark.pair, ['craft']);
  assert.match(single.remark.text, /こちらにばかり/);
  assert.deepEqual(fromWeights({ banter: 3, craft: 1, warmth: 1 }).remark.pair, []);
  assert.deepEqual(fromWeights({ banter: 1, craft: 1, warmth: 1 }).remark.pair, []);
  const topTwoTied = fromWeights({ banter: 2, craft: 2, warmth: 1 });
  assert.deepEqual(topTwoTied.remark.pair, ['banter', 'craft']);
});

test('remark selection uses unrounded proportions instead of tied displayed integers', () => {
  const insight = fromWeights({ craft: 100, banter: 50, schemes: 49 });
  assert.equal(valuesOf(insight).banter, valuesOf(insight).schemes);
  assert.deepEqual(insight.remark.pair, ['banter', 'craft']);
});

test('related works use work profiles, excluding the source and ignoring reader answers', () => {
  const a = fromWeights({ craft: 3, banter: 2 });
  const b = fromWeights({ values: 3, reflection: 2 });
  assert.deepEqual(a.relatedWorks.map(work => work.id), ['02', '11']);
  assert.deepEqual(b.relatedWorks, a.relatedWorks);
  assert.ok(a.relatedWorks.every(work => work.id !== '01'));
});

test('related-work ties are stable by ID and small catalogs return only available works', () => {
  const data = structuredClone(runtime);
  const work = data.works[0];
  data.works = ['z', 'base', 'b', 'a'].map(id => ({ ...structuredClone(work), id }));
  const inspect = () => createResultInsights({ data, answers: [], result: { workId: 'base', answerCount: 0 } });
  assert.deepEqual(inspect().relatedWorks.map(row => row.id), ['a', 'b']);
  data.works.reverse();
  assert.deepEqual(inspect().relatedWorks.map(row => row.id), ['a', 'b']);
  data.works = data.works.filter(row => ['base', 'a'].includes(row.id));
  assert.deepEqual(inspect().relatedWorks.map(row => row.id), ['a']);
  data.works = data.works.filter(row => row.id === 'base');
  assert.deepEqual(inspect().relatedWorks, []);
});

test('rejects missing works and invalid historical boundaries', () => {
  const answers = [['T01', 'a']];
  for (const answerCount of [-1, 0.5, 2, NaN, '1', undefined]) {
    assert.throws(() => createResultInsights({ data: runtime, answers, result: { workId: '01', answerCount } }), RangeError);
  }
  assert.throws(() => createResultInsights({ data: runtime, answers, result: { workId: 'unknown', answerCount: 0 } }), /Unknown result work/);
  assert.throws(() => createResultInsights(), RangeError);
});

test('insights do not mutate answers, the result, the catalog or the remark table', () => {
  const input = { data: structuredClone(runtime), answers: [['T01', 'c'], ['T02', 'd']], result: { workId: '01', answerCount: 2 } };
  const before = structuredClone(input);
  const insight = createResultInsights(input);
  assert.deepEqual(input, before);
  insight.remark.pair.reverse();
  assert.deepEqual(createResultInsights(input).remark.pair, ['banter', 'craft']);
});
