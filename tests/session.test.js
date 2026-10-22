import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QuizSession } from '../src/session.js';

const runtime = JSON.parse(readFileSync(new URL('../data/runtime.json', import.meta.url), 'utf8'));
const presentation = { dataset_version: 'session-tests-v1', narrator: { id: 'seiga', name: '霍青娥' }, public_cast_by_work: {} };
const clone = (value) => JSON.parse(JSON.stringify(value));
const token = (session) => session.state.activeStepId;
const create = (data = runtime, display = presentation) => new QuizSession(data, display, { random: () => 0 });
const start = (session) => session.start(token(session));
const answer = (session, option = null) => session.answer(option, token(session));
const finishRound = (session) => {
  while (session.state.phase === 'question' || session.state.phase === 'favorite') {
    if (session.state.phase === 'favorite') session.answerFavorite('no', token(session));
    else answer(session);
  }
  assert.equal(session.state.phase, 'result');
  return session.state.pendingResult;
};
const commit = (session) => session.commitResult(session.state.pendingResult.resultId, token(session));
const resume = (session, data = runtime, display = presentation) => {
  const restored = new QuizSession(data, display, {
    state: session.exportState(), random: () => { throw new Error('Restoring must not draw random numbers.'); },
  });
  restored.random = () => 0;
  return restored;
};
const reachFavorite = (session) => {
  while (session.state.phase === 'question') answer(session);
  assert.equal(session.state.phase, 'favorite');
};

test('the welcome screen may introduce the narrator without starting or consuming a question', () => {
  const session = create();
  session.introduceCharacters(['seiga'], token(session));
  assert.equal(session.state.started, false);
  assert.deepEqual(session.state.answers, []);
  assert.deepEqual(session.eligibleFavorites(), []);
  assert.deepEqual(resume(session).state, session.state);
});

test('a dataset without published works cannot start a quiz or claim completion', () => {
  const data = clone(runtime);
  data.works = [];
  assert.throws(() => {
    const session = create(data);
    start(session);
  });
});

test('skipping is accepted only when the current question permits it', () => {
  const data = clone(runtime);
  const firstId = data.rules.first_question_sets[0].questions[0];
  data.questions.find((question) => question.id === firstId).allow_skip = false;
  const session = create(data);
  start(session);
  assert.equal(session.currentQuestion().allowSkip, false);
  assert.throws(() => answer(session), /not an option/);
  assert.equal(session.state.answers.length, 0);
  answer(session, 'a');
  assert.equal(session.state.answers.length, 1);
});

test('first round is fixed at start, progress is local to that round, stale answers are rejected', () => {
  const session = create();
  assert.equal(session.currentQuestion(), null);
  start(session);
  assert.equal(session.state.initialSetId, runtime.rules.first_question_sets[0].id);
  assert.deepEqual(session.state.round.queue, runtime.rules.first_question_sets[0].questions);
  assert.equal(session.currentQuestion().roundTotal, 5);
  const oldToken = token(session);
  const first = session.currentQuestion();
  answer(session, first.options[0].id);
  assert.equal(session.currentQuestion().ordinal, 2);
  assert.throws(() => session.answer(null, oldToken), /no longer active/);
  assert.equal(session.state.answers.length, 1);
  assert.throws(() => session.answer('not-an-option', token(session)), /not an option/);
  assert.throws(() => session.start(token(session)), /already started/);
});

test('undo changes only this round and keeps its question queue', () => {
  const session = create();
  start(session);
  const queue = [...session.state.round.queue];
  answer(session, 'a');
  answer(session, 'b');
  session.answerFavorite('no', token(session));
  const oldToken = token(session);
  session.undo(oldToken);
  assert.deepEqual(session.state.round.queue, queue);
  assert.deepEqual(session.state.answers, [[queue[0], 'a']]);
  assert.equal(session.currentQuestion().id, queue[1]);
  assert.equal(session.state.ordinarySinceResult, 1);
  assert.throws(() => session.undo(oldToken), /no longer active/);
  session.undo(token(session));
  assert.throws(() => session.undo(token(session)), /cannot be changed/);
  finishRound(session);
  commit(session);
  assert.throws(() => session.undo(token(session)), /cannot be changed/);
  session.decline(token(session));
  assert.throws(() => session.undo(token(session)), /cannot be changed/);
  assert.equal(session.currentQuestion().roundTotal, 2);
});

test('preparing a recommendation does not mark it shown; display commit is idempotent', () => {
  const session = create();
  start(session);
  const result = finishRound(session);
  assert.equal(result.reasonKind, 'no_evidence');
  assert.equal(session.state.resultHistory.length, 0);
  assert.throws(() => session.decline(token(session)), /latest displayed/);
  const pendingToken = token(session);
  session.commitResult(result.resultId, pendingToken);
  assert.equal(session.state.pendingResult, null);
  assert.equal(session.state.resultHistory.length, 1);
  session.commitResult(result.resultId, pendingToken);
  assert.equal(session.state.resultHistory.length, 1);
  session.decline(token(session));
  assert.throws(() => session.commitResult(result.resultId, pendingToken), /no longer active/);
});

test('all works can be introduced once, with an explicit final decline to the ending', () => {
  let session = create();
  start(session);
  for (let index = 0; index < runtime.works.length; index += 1) {
    while (session.state.phase === 'question' || session.state.phase === 'favorite') {
      if (session.state.phase === 'favorite') session.answerFavorite('no', token(session));
      else answer(session);
      session = resume(session);
    }
    assert.equal(session.state.pendingResult.introducedCount, index + 1);
    assert.equal(session.state.pendingResult.isLast, index === runtime.works.length - 1);
    commit(session);
    session = resume(session);
    assert.equal(session.state.phase, 'result');
    const oldToken = token(session);
    session.decline(oldToken);
    assert.throws(() => session.decline(oldToken), /no longer active/);
    session = resume(session);
  }
  assert.equal(session.state.phase, 'ending');
  assert.equal(new Set(session.state.resultHistory.map((result) => result.workId)).size, runtime.works.length);
  assert.equal(session.state.answers.length, 5 + 2 * (runtime.works.length - 1));
  assert.throws(() => session.decline(token(session)), /latest displayed/);
});

test('question shortage uses one remaining question, then recommends without inventing questions', () => {
  const data = clone(runtime);
  const first = data.rules.first_question_sets[0];
  const remaining = data.questions.find((question) => !first.questions.includes(question.id)).id;
  const retained = new Set([...first.questions, remaining]);
  data.questions = data.questions.filter((question) => retained.has(question.id));
  data.rules.first_question_sets = [first];
  data.rules.continuation_priority = data.rules.continuation_priority.filter((id) => retained.has(id));
  const session = create(data);
  start(session);
  finishRound(session);
  commit(session);
  session.decline(token(session));
  assert.equal(session.currentQuestion().roundTotal, 1);
  assert.equal(session.state.round.favoritePlan, null);
  assert.equal(session.currentQuestion().id, remaining);
  answer(session);
  commit(session);
  session.decline(token(session));
  assert.equal(session.state.phase, 'result');
  assert.equal(session.state.round.queue.length, 0);
  assert.equal(session.state.round.favoritePlan, null);
  assert.equal(session.state.answers.length, 6);
  assert.equal(session.state.resultHistory.length, 2);
  assert.deepEqual(resume(session, data).state, session.state);
});

test('a favorite question is inserted automatically after the fixed second, third or fourth normal answer', () => {
  for (const [draw, expectedAfter] of [[0, 2], [0.5, 3], [0.99, 4]]) {
    const session = create();
    session.random = () => draw;
    start(session);
    assert.equal(session.state.round.favoritePlan.after, expectedAfter);
    for (let index = 0; index < expectedAfter; index += 1) {
      assert.equal(session.state.phase, 'question');
      answer(session);
    }
    assert.equal(session.state.phase, 'favorite');
    assert.equal(session.currentQuestion(), null);
    assert.equal(session.state.favoriteCharacterId, session.state.round.favoritePlan.characterId);
    assert.throws(() => answer(session), /no active question/);
    assert.throws(() => session.undo(token(session)), /cannot be changed/);
  }
});

test('character choice samples people evenly, regardless of appearances or whether they were displayed', () => {
  const data = clone(runtime);
  const base = data.works[0].characters[0];
  for (const work of data.works) work.characters = [
    { ...base, id: 'seiga', name: '霍青娥', favorite_eligible: true },
    { ...base, id: 'common', name: 'Common', favorite_eligible: true },
    { ...base, id: 'indirect', name: 'Indirect', favorite_eligible: false },
  ];
  data.works[0].characters.push({ ...base, id: 'rare', name: 'Rare', favorite_eligible: true });
  const counts = { common: 0, rare: 0 };
  for (let index = 0; index < 100; index += 1) {
    const session = create(data);
    session.random = () => (index + 0.5) / 100;
    start(session);
    counts[session.state.round.favoritePlan.characterId] += 1;
    reachFavorite(session);
    assert.deepEqual(session.state.introducedCharacterIds, []);
    session.introduceCharacters([session.state.favoriteCharacterId], token(session));
    assert.deepEqual(resume(session, data).state, session.state);
  }
  assert.deepEqual(counts, { common: 50, rare: 50 });
});

test('continuation rounds have a fifty-percent insertion chance and always start with a normal question', () => {
  let inserted = 0;
  for (let index = 0; index < 100; index += 1) {
    const session = create();
    start(session);
    finishRound(session);
    commit(session);
    session.random = () => (index + 0.5) / 100;
    session.decline(token(session));
    assert.equal(session.state.phase, 'question');
    assert.deepEqual(resume(session).state, session.state);
    const plan = session.state.round.favoritePlan;
    answer(session);
    if (plan) {
      inserted += 1;
      assert.equal(plan.after, 1);
      assert.equal(session.state.phase, 'favorite');
      session.answerFavorite('no', token(session));
    } else assert.equal(session.state.phase, 'question');
    answer(session);
    assert.equal(session.state.phase, 'result');
    assert.deepEqual(resume(session).state, session.state);
  }
  assert.equal(inserted, 50);
});

test('asked characters and characters with no unseen eligible work cannot be scheduled again', () => {
  const baseline = create();
  start(baseline);
  const firstWorkId = finishRound(baseline).workId;
  const data = clone(runtime);
  const base = data.works[0].characters[0];
  for (const work of data.works) work.characters = [
    { ...base, id: 'common', name: 'Common', favorite_eligible: true },
  ];
  data.works.find((work) => work.id === firstWorkId).characters.push(
    { ...base, id: 'single', name: 'Single', favorite_eligible: true });
  const session = create(data);
  start(session);
  assert.equal(session.state.round.favoritePlan.characterId, 'common');
  assert.equal(finishRound(session).workId, firstWorkId);
  commit(session);
  session.decline(token(session));
  assert.equal(session.state.round.favoritePlan, null);
  answer(session);
  assert.deepEqual(session.eligibleFavorites(), []);
  assert.deepEqual(resume(session, data).state, session.state);
});

test('datasets without eligible characters other than Seiga keep the ordinary flow', () => {
  for (const eligibleId of [null, 'seiga']) {
    const data = clone(runtime);
    for (const work of data.works) for (const character of work.characters) character.favorite_eligible = character.id === eligibleId;
    const session = create(data);
    start(session);
    assert.equal(session.state.round.favoritePlan, null);
    finishRound(session);
    assert.deepEqual(session.state.favoritePromptAnswers, []);
    assert.deepEqual(resume(session, data).state, session.state);
  }
});

test('short initial queues use only an available slot and never interrupt the final normal answer', () => {
  for (const count of [0, 1, 2, 3]) {
    const data = clone(runtime);
    const first = data.rules.first_question_sets[0];
    first.questions = first.questions.slice(0, count);
    data.rules.first_question_sets = [first];
    data.rules.first_normal_result_after = count;
    data.questions = data.questions.filter((question) => first.questions.includes(question.id));
    data.rules.continuation_priority = [...first.questions];
    const session = create(data);
    start(session);
    assert.equal(session.state.round.favoritePlan?.after ?? null, count < 2 ? null : count - 1);
    finishRound(session);
    assert.equal(session.state.answers.length, count);
    assert.equal(session.state.favoritePromptAnswers.length, count < 2 ? 0 : 1);
    assert.deepEqual(resume(session, data).state, session.state);
  }
});

test('favorite prompt timing and character survive restore, undo and reanswer without new random draws', () => {
  const session = create();
  start(session);
  const plan = clone(session.state.round.favoritePlan);
  session.random = () => { throw new Error('The current round must not reroll.'); };
  answer(session);
  session.undo(token(session));
  assert.deepEqual(session.state.round.favoritePlan, plan);
  assert.deepEqual(resume(session).state, session.state);
  reachFavorite(session);
  assert.deepEqual(resume(session).state, session.state);
  session.answerFavorite('unknown', token(session));
  session.undo(token(session));
  session.undo(token(session));
  assert.deepEqual(resume(session).state, session.state);
  assert.deepEqual(session.state.round.favoritePlan, plan);
  finishRound(session);
  assert.equal(session.state.favoritePromptAnswers.length, 1);
});

test('favorite yes ends the round early, preserves answers, and starts a two-question round next', () => {
  let session = create();
  start(session);
  answer(session, 'a');
  const originalQueue = [...session.state.round.queue];
  reachFavorite(session);
  const characterId = session.state.favoriteCharacterId;
  const after = session.state.round.favoritePlan.after;
  const oldToken = token(session);
  session = resume(session);
  session.answerFavorite('yes', token(session));
  assert.throws(() => session.answerFavorite('yes', oldToken), /no longer active/);
  assert.equal(session.state.pendingResult.trigger, 'favorite');
  assert.equal(session.state.pendingResult.reasonKind, 'favorite');
  assert.equal(session.state.pendingResult.characterId, characterId);
  assert.equal(session.state.answers.length, after);
  assert.deepEqual(session.state.round.queue, originalQueue.slice(0, after));
  assert.equal(session.state.resultHistory.length, 0);
  session = resume(session);
  commit(session);
  session.decline(token(session));
  assert.equal(session.currentQuestion().roundTotal, 2);
  assert.deepEqual(session.eligibleFavorites(), []);
  assert.equal(session.state.phase, 'question');
  answer(session);
  assert.equal(session.state.phase, 'favorite');
  assert.notEqual(session.state.favoriteCharacterId, characterId);
  assert.equal(session.state.answers.length, after + 1);
  assert.deepEqual(resume(session).state, session.state);
});

for (const choice of ['no', 'unknown']) {
  test(`favorite ${choice} leaves normal answers and rankings unchanged, and cannot repeat`, () => {
    const session = create();
    start(session);
    answer(session, 'a');
    reachFavorite(session);
    const characterId = session.state.favoriteCharacterId;
    const beforeAnswers = clone(session.state.answers);
    const beforeRank = session.engine.rank(session.state.answers);
    const questionId = session.state.round.queue[session.state.round.index];
    session.answerFavorite(choice, token(session));
    assert.deepEqual(session.state.answers, beforeAnswers);
    assert.deepEqual(session.engine.rank(session.state.answers), beforeRank);
    assert.equal(session.currentQuestion().id, questionId);
    assert(!session.eligibleFavorites().some((character) => character.id === characterId));
    assert.deepEqual(resume(session).state, session.state);
  });
}

test('public cast approval still controls result-card introductions separately from automatic prompts', () => {
  const display = clone(presentation);
  display.public_cast_by_work = Object.fromEntries(runtime.works.map((work) =>
    [work.id, work.characters.map((character) => character.id)]));
  let session = create(runtime, display);
  start(session);
  const otherCharacter = runtime.works.flatMap((work) => work.characters).find((character) => character.id !== 'seiga').id;
  assert.throws(() => session.introduceCharacters([otherCharacter], token(session)), /not been approved/);
  const result = finishRound(session);
  commit(session);
  const cast = display.public_cast_by_work[result.workId];
  session.introduceCharacters(cast, token(session));
  const unchangedToken = token(session);
  session.introduceCharacters(cast, token(session));
  assert.equal(token(session), unchangedToken);
  session = resume(session, runtime, display);
  session.decline(token(session));
  assert.deepEqual(session.eligibleFavorites(), []);
  answer(session);
  assert.equal(session.state.phase, 'favorite');
  session.introduceCharacters([session.state.favoriteCharacterId], token(session));
  assert.deepEqual(resume(session, runtime, display).state, session.state);
});

test('restore preserves pending selection and fixed order without re-randomizing', () => {
  const session = create();
  start(session);
  answer(session, 'b');
  const savedQueue = [...session.state.round.queue];
  let restored = resume(session);
  assert.deepEqual(restored.state.round.queue, savedQueue);
  assert.deepEqual(restored.state.tieOrder, session.state.tieOrder);
  finishRound(restored);
  const pending = clone(restored.state.pendingResult);
  restored = resume(restored);
  assert.deepEqual(restored.state.pendingResult, pending);
  assert.equal(restored.state.resultHistory.length, 0);
  const exported = restored.exportState();
  exported.answers[0][1] = 'd';
  assert.notDeepEqual(exported.answers, restored.state.answers);
});

test('restore rejects corrupt, mismatched or inconsistent state without changing the session', () => {
  const session = create();
  start(session);
  answer(session, 'a');
  const baseline = session.exportState();
  const corruptions = [
    (state) => { state.datasetVersion = 'another-version'; },
    (state) => { state.formatVersion = 999; },
    (state) => { state.activeStepId = 'step-999'; },
    (state) => { state.phase = 'not-a-phase'; },
    (state) => { state.answers[0][0] = 'unknown-question'; },
    (state) => { state.answers[0][1] = 'unknown-option'; },
    (state) => { state.answers.push([...state.answers[0]]); },
    (state) => { state.tieOrder[0] = state.tieOrder[1]; },
    (state) => { state.round.index = 4; },
    (state) => { state.round.queue[0] = 'unknown-question'; },
    (state) => { state.round.favoritePlan = null; },
    (state) => { state.round.favoritePlan.after = 1; },
    (state) => { state.round.favoritePlan.characterId = 'unknown-character'; },
    (state) => { state.round.favoritePlan.characterId = 'seiga'; },
    (state) => { state.ordinarySinceResult = 0; },
    (state) => { state.favoriteCharacterId = 'seiga'; },
    (state) => { state.favoritePromptAnswers = [{ characterId: 'seiga', answer: 'yes' }]; },
    (state) => { state.introducedCharacterIds = ['unknown-character']; },
  ];
  for (const corrupt of corruptions) {
    const saved = clone(baseline);
    corrupt(saved);
    assert.throws(() => session.restore(saved));
    assert.deepEqual(session.exportState(), baseline);
  }
  finishRound(session);
  commit(session);
  const displayed = session.exportState();
  const badResult = clone(displayed);
  badResult.resultHistory[0].answerCount = 0;
  assert.throws(() => session.restore(badResult));
  const changedReason = clone(displayed);
  changedReason.resultHistory[0].lead = 'Unrecognized saved copy';
  assert.throws(() => session.restore(changedReason));
  const duplicate = clone(displayed);
  duplicate.resultHistory.push({ ...duplicate.resultHistory[0], resultId: 'result-2', introducedCount: 2 });
  assert.throws(() => session.restore(duplicate));
});

test('restore rejects inconsistent prompt schedules, pending questions and answer provenance', () => {
  const session = create();
  start(session);
  reachFavorite(session);
  const pending = session.exportState();
  const corruptions = [
    (state) => { state.round.favoritePlan.after += 1; },
    (state) => { state.round.favoritePlan.characterId = 'seiga'; state.favoriteCharacterId = 'seiga'; },
    (state) => { state.favoriteCharacterId = 'unknown-character'; },
    (state) => { state.phase = 'question'; state.favoriteCharacterId = null; },
    (state) => { state.favoritePromptAnswers.push({ characterId: state.favoriteCharacterId, answer: 'no', roundNumber: 1, after: 2 }); },
  ];
  for (const corrupt of corruptions) {
    const saved = clone(pending);
    corrupt(saved);
    assert.throws(() => session.restore(saved));
    assert.deepEqual(session.state, pending);
  }
  session.answerFavorite('no', token(session));
  const answered = session.exportState();
  for (const corrupt of [
    (state) => { state.favoritePromptAnswers[0].roundNumber = 2; },
    (state) => { state.favoritePromptAnswers[0].after = 3; },
    (state) => { state.favoritePromptAnswers[0].answer = 'yes'; },
    (state) => { state.favoritePromptAnswers = []; },
  ]) {
    const saved = clone(answered);
    corrupt(saved);
    assert.throws(() => session.restore(saved));
  }
  finishRound(session);
  commit(session);
  session.decline(token(session));
  const missingFirst = session.exportState();
  missingFirst.favoritePromptAnswers = [];
  assert.throws(() => session.restore(missingFirst));
});
