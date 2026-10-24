import test from 'node:test';
import assert from 'node:assert/strict';
import { Recommender, reasonFor, validateRuntime } from '../src/engine.js';

function fixture() {
  const question = (id, channel, family = id, mixed = false) => ({
    id, channel, family, text: '場面を選ぶ', allow_skip: true,
    options: channel === 'taste'
      ? [{ id: 'a', text: '軽い話', weights: mixed ? { fun: 2, quiet: 1 } : { fun: 3 } }, { id: 'b', text: '静かな話', weights: { quiet: 3 } }]
      : [{ id: 'a', text: '確かめる', weights: { curious: 3 } }, { id: 'b', text: '気遣う', weights: { kind: 3 } }],
  });
  const character = (id, curious, kind) => ({ id, name: `人物${id}`, role: 'main', behavior: { curious, kind }, favorite_eligible: true });
  const questions = [question('T1', 'taste'), question('T2', 'taste', 'T1', true), question('T3', 'taste'), question('B1', 'behavior'), question('B2', 'behavior'), question('T4', 'taste'), question('B3', 'behavior')];
  return {
    schema_version: '0.4', author_x_url: null,
    features: { taste: { fun: '掛け合い', quiet: '静かな話' }, behavior: { curious: '確かめる', kind: '気遣う' } },
    rules: {
      profile_maxima: { taste: 4, behavior: 2 }, mixed_weights: { taste: 0.7, behavior: 0.3 },
      role_weights: { main: 1, support: 0.6, indirect: 0 }, taste_candidate_band: 20,
      entry_prior: { max_points: 16, light_entry_max: 4 },
      first_normal_result_after: 5, ordinary_questions_between_results: 2, skip_counts_as_presented: true,
      first_question_sets: [{ id: 'A', questions: ['T1', 'B1', 'T2', 'B2', 'T3'] }],
      continuation_priority: questions.map((item) => item.id),
      continuation_selection: { method: 'remaining_top_spread', top_candidates: 3, channel_order: ['taste', 'behavior'], prefer_new_family: true },
    },
    questions,
    works: [
      { id: 'A', title: '架空作品A', pixiv_url: 'https://www.pixiv.net/novel/show.php?id=1', author_caption: null, taste: { fun: 4, quiet: 0 }, light_entry: 0, entry_penalty: 12, characters: [character('alpha', 2, 0), character('zeta', 0, 2)] },
      { id: 'B', title: '架空作品B', pixiv_url: 'https://www.pixiv.net/novel/show.php?id=2', author_caption: null, taste: { fun: 3, quiet: 4 }, light_entry: 4, entry_penalty: 0, characters: [character('beta', 1, 2)] },
      { id: 'C', title: '架空作品C', pixiv_url: 'https://www.pixiv.net/novel/show.php?id=3', author_caption: null, taste: { fun: 0, quiet: 4 }, light_entry: 0, entry_penalty: 0, characters: [{ id: 'guest', name: '人物guest', role: 'main', behavior: null, favorite_eligible: true }] },
    ],
  };
}

test('normalizes every answer independently and skips without adding a denominator', () => {
  const engine = new Recommender(fixture());
  const evidence = engine.evidence([['T1', 'a'], ['T2', 'a'], ['T3', null], ['B1', null]]);
  assert.equal(evidence.taste.fun, (1 + 2 / 3) / 2);
  assert.equal(evidence.taste.quiet, 1 / 6);
  assert.equal(evidence.behavior, null);
  assert.throws(() => engine.evidence([['missing', null]]), /Unknown question/);
  assert.throws(() => engine.evidence([['T1', 'missing']]), /Unknown option/);
});

test('uses one character across behavior answers and Python character-ID tie breaking', () => {
  const engine = new Recommender(fixture());
  const row = engine.score(engine.works.get('A'), [['B1', 'a'], ['B2', 'b']]);
  assert.equal(row.behavior, 50);
  assert.equal(row.character, 'zeta');
  assert.equal(row.combined, 50);
});

test('character ties compare Unicode code points like Python tuples', () => {
  const data = fixture();
  data.works[0].characters = [
    { ...data.works[0].characters[0], id: '\uE000' },
    { ...data.works[0].characters[0], id: '\u{10000}' },
  ];
  assert.equal(new Recommender(data).score(data.works[0], [['B1', 'a']]).character, '\u{10000}');
});

test('compensated profile sums preserve small contributions when selecting a character', () => {
  const data = fixture();
  data.works[0].characters = [
    { ...data.works[0].characters[0], id: 'alpha', behavior: { curious: 2, kind: 1, extra: 1 } },
    { ...data.works[0].characters[0], id: 'zeta', behavior: { curious: 2, kind: 0, extra: 0 } },
  ];
  const evidence = { taste: null, behavior: { curious: 1, kind: Number.EPSILON, extra: Number.EPSILON } };
  const row = new Recommender(data)._score(data.works[0], evidence);
  assert.equal(row.character, 'alpha');
  assert.ok(row.behavior > 100);
});

test('distinguishes missing character evidence from a zero score and applies roles', () => {
  const data = fixture();
  data.works[0].characters[0].role = 'support';
  const engine = new Recommender(data);
  assert.equal(engine.score(data.works[0], [['B1', 'a']]).behavior, 60);
  assert.equal(engine.score(data.works[2], [['B1', 'a']]).behavior, null);
  data.works[0].characters[0].role = 'indirect';
  assert.equal(engine.score(data.works[0], [['B1', 'a']]).behavior, 0);
  assert.equal(engine.score(data.works[2], [['T1', 'b'], ['B1', 'a']]).combined, 100);
});

test('candidate band precedes entry bonuses and penalties', () => {
  const data = fixture();
  data.works[1].taste.fun = 3.2;
  data.works[2].light_entry = 4;
  const rows = new Recommender(data).rank([['T1', 'a']]);
  assert.deepEqual(rows.map((row) => row.work_id), ['B', 'A']);
  assert.equal(rows[0].taste, 80);
  assert.equal(rows[0].combined, 80);
  assert.equal(rows[0].entry_bonus, 16);
  assert.equal(rows[0].ranking_score, 96);
  assert.equal(rows[1].entry_penalty, 12);
  assert.equal(rows[1].ranking_score, 88);
});

test('favorite bypasses the ordinary candidate band and both editorial adjustments', () => {
  const engine = new Recommender(fixture());
  const rows = engine.rank([['T1', 'b']], [], 'alpha');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].work_id, 'A');
  assert.equal(rows[0].taste, 0);
  assert.equal(rows[0].entry_bonus, 0);
  assert.equal(rows[0].entry_penalty, 0);
  assert.deepEqual(engine.rank([['T1', 'b']], ['A'], 'alpha'), []);
});

test('unregistered behavior does not remove a favorite and eligibility is required', () => {
  const data = fixture();
  const engine = new Recommender(data);
  assert.equal(engine.rank([], [], 'guest')[0].work_id, 'C');
  data.works[2].characters[0].favorite_eligible = false;
  assert.deepEqual(engine.rank([], [], 'guest'), []);
});

function favoriteRolesFixture() {
  const data = fixture();
  for (const [index, role] of ['main', 'support', 'indirect'].entries()) {
    const work = data.works[index];
    work.taste.fun = index === 0 ? 1 : 4;
    work.characters = [{ id: 'chosen', name: '指定人物', role, behavior: null, favorite_eligible: true }];
  }
  data.works[1].characters.push({ id: 'someone-else', name: '別の人物', role: 'main', behavior: { curious: 2, kind: 2 }, favorite_eligible: true });
  return data;
}

test('favorite prioritizes the specified character role before higher match scores', () => {
  const data = favoriteRolesFixture();
  const rows = new Recommender(data).rank([['T1', 'a']], [], 'chosen');
  assert.deepEqual(rows.map(row => row.work_id), ['A', 'B', 'C']);
  assert.deepEqual(rows.map(row => row.favorite_role), ['main', 'support', 'indirect']);
  assert.ok(rows[0].ranking_score < rows[1].ranking_score);
  assert.ok(rows.every(row => row.entry_bonus === 0 && row.entry_penalty === 0 && row.ranking_score === row.combined));
});

test('a shown main role leaves support reachable and another character cannot promote it', () => {
  const engine = new Recommender(favoriteRolesFixture());
  assert.equal(engine.rank([['T1', 'a']], [], 'chosen')[0].work_id, 'A');
  assert.deepEqual(engine.rank([['T1', 'a']], ['A'], 'chosen').map(row => row.work_id), ['B', 'C']);
  assert.equal(engine.rank([['T1', 'a']], ['A', 'B'], 'chosen')[0].work_id, 'C');
  assert.deepEqual(engine.rank([], ['A', 'B', 'C'], 'chosen'), []);
});

test('same favorite role uses existing match scores, then the session tie order', () => {
  const data = favoriteRolesFixture();
  data.works = data.works.slice(0, 2);
  data.works[1].characters[0].role = 'main';
  const engine = new Recommender(data, { tieOrder: ['A', 'B'] });
  assert.deepEqual(engine.rank([['T1', 'a']], [], 'chosen').map(row => row.work_id), ['B', 'A']);
  assert.deepEqual(engine.rank([], [], 'chosen').map(row => row.work_id), ['A', 'B']);
  assert.deepEqual(new Recommender(data, { tieOrder: ['B', 'A'] }).rank([], [], 'chosen').map(row => row.work_id), ['B', 'A']);
});

test('ordinary recommendations do not acquire favorite role priority or change their scores', () => {
  const data = favoriteRolesFixture();
  const answers = [['T1', 'a']];
  const ordinary = new Recommender(data).rank(answers);
  assert.deepEqual(ordinary.map(row => row.work_id), ['B', 'C']);
  assert.deepEqual(ordinary.map(row => row.ranking_score), [116, 100]);
  assert.ok(ordinary.every(row => !Object.hasOwn(row, 'favorite_role')));
  const swapped = structuredClone(data);
  for (const [index, role] of ['indirect', 'main', 'support'].entries()) swapped.works[index].characters[0].role = role;
  assert.deepEqual(new Recommender(swapped).rank(answers), ordinary);
});

test('all-skip rankings do not apply editorial adjustments; fixed tie order is honored', () => {
  const data = fixture();
  const engine = new Recommender(data, { tieOrder: ['C', 'B', 'A'] });
  const rows = engine.rank([['T1', null], ['B1', null]]);
  assert.deepEqual(rows.map((row) => row.work_id), ['C', 'B', 'A']);
  assert.ok(rows.every((row) => row.entry_bonus === 0 && row.entry_penalty === 0 && row.ranking_score === null));
  assert.deepEqual(new Recommender(data).rank([]).map((row) => row.work_id), ['A', 'B', 'C']);
  assert.throws(() => new Recommender(data, { tieOrder: ['A', 'A'] }), /tieOrder/);
});

test('ranking uses decimal ties-to-even at six places without rounding raw values', () => {
  const data = fixture();
  data.works = data.works.slice(0, 2);
  for (const work of data.works) { work.taste.fun = 0; work.entry_penalty = 0; }
  data.works[0].light_entry = 4 * 0.007812;
  data.works[1].light_entry = 4 * 0.0078125;
  const rows = new Recommender(data, { entryPoints: 1 }).rank([['T1', 'a']]);
  assert.deepEqual(rows.map((row) => row.work_id), ['A', 'B']);
  assert.equal(rows[1].ranking_score, 0.0078125);
  assert.ok(rows[1].ranking_score > rows[0].ranking_score);
});

test('continuation favors unused families, consumes skip, and selects taste then behavior', () => {
  const engine = new Recommender(fixture());
  const ids = engine.nextQuestions([['T1', null], ['B1', null]]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], 'T1');
  assert.notEqual(ids[0], 'T2');
  assert.notEqual(ids[1], 'B1');
  assert.equal(engine.questions.get(ids[0]).channel, 'taste');
  assert.equal(engine.questions.get(ids[1]).channel, 'behavior');
});

test('continuation handles one remaining work, exhausted channels, and no remaining work', () => {
  const data = fixture();
  const engine = new Recommender(data);
  assert.deepEqual(engine.nextQuestions([], ['B', 'C']), ['T1', 'B1']);
  const tasteDone = data.questions.filter((question) => question.channel === 'taste').map((question) => [question.id, null]);
  assert.deepEqual(engine.nextQuestions(tasteDone, ['B', 'C']), ['B1']);
  assert.deepEqual(engine.nextQuestions(data.questions.map((question) => [question.id, null])), []);
  assert.deepEqual(engine.nextQuestions([], ['A', 'B', 'C']), []);
});

test('taste reasons select actual answer evidence and ignore draft plot introductions', () => {
  const data = fixture();
  data.works[0].draft_intro_by_taste = { fun: 'この仮文は利用しない' };
  const answers = [['T1', 'a'], ['T2', 'a']];
  const row = new Recommender(data).score(data.works[0], answers);
  const result = reasonFor(data, row, answers);
  assert.equal(result.kind, 'taste');
  assert.equal(result.questionId, 'T1');
  assert.equal(result.optionId, 'a');
  assert.equal(result.feature, 'fun');
  assert.match(result.reason, /掛け合い/);
  assert.doesNotMatch(result.reason, /仮文/);
});

test('reason threshold is inclusive at 60 and ranking bonus cannot establish evidence', () => {
  const data = fixture();
  data.works[1].taste.fun = 2.4;
  const answers = [['T1', 'a']];
  let row = new Recommender(data).score(data.works[1], answers);
  assert.equal(reasonFor(data, row, answers).kind, 'taste');
  data.works[1].taste.fun = 2;
  row = new Recommender(data).score(data.works[1], answers);
  row.ranking_score = 66;
  row.entry_bonus = 16;
  assert.equal(reasonFor(data, row, answers).kind, 'exploration');
});

test('behavior, favorite, and no-evidence reasons remain distinct', () => {
  const data = fixture();
  const engine = new Recommender(data);
  const answers = [['B1', 'a']];
  const behavior = reasonFor(data, engine.score(data.works[0], answers), answers);
  assert.equal(behavior.kind, 'behavior');
  assert.equal(behavior.characterId, 'alpha');
  assert.equal(behavior.questionId, 'B1');
  const favorite = reasonFor(data, engine.rank([], [], 'guest')[0], [], 'guest');
  assert.equal(favorite.kind, 'favorite');
  assert.equal(favorite.characterId, 'guest');
  assert.match(favorite.lead, /人物guest/);
  const absent = reasonFor(data, engine.rank([['T1', null]])[0], [['T1', null]]);
  assert.equal(absent.kind, 'no_evidence');
  assert.equal(absent.questionId, null);
});

test('runtime validation accepts valid synthetic data and zero works', () => {
  const data = fixture();
  assert.equal(validateRuntime(data), true);
  data.works = [];
  assert.equal(validateRuntime(data), true);
});

test('runtime validation rejects bad references, duplicate IDs, invalid ranges, and unsafe links', () => {
  const invalid = [
    (data) => { data.questions.push(data.questions[0]); },
    (data) => { data.rules.first_question_sets[0].questions[0] = 'missing'; },
    (data) => { data.rules.continuation_priority.pop(); },
    (data) => { data.questions[0].options[0].weights.fun = 0; },
    (data) => { data.questions[0].options[0].weights.fun = -1; },
    (data) => { data.questions[0].options[0].weights.unknown = 1; },
    (data) => { data.works[0].taste.fun = 5; },
    (data) => { data.works[0].characters[0].behavior.curious = NaN; },
    (data) => { data.works[0].pixiv_url = 'javascript:alert(1)'; },
    (data) => { data.author_x_url = 'https://example.com/user'; },
  ];
  for (const mutate of invalid) {
    const data = fixture(); mutate(data);
    assert.throws(() => validateRuntime(data), TypeError);
  }
});
