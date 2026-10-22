import { Recommender, reasonFor } from './engine.js';

const FORMAT_VERSION = 2;
const PHASES = new Set(['question', 'favorite', 'result', 'ending']);
const FAVORITE_ANSWERS = new Set(['yes', 'no', 'unknown']);
const REASON_KINDS = new Set(['taste', 'behavior', 'favorite', 'exploration', 'no_evidence']);
const clone = (value) => JSON.parse(JSON.stringify(value));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isInteger = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const unique = (values) => new Set(values).size === values.length;
const sameArray = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

/** Browser-independent progress. Rendering, navigation and storage belong to the caller. */
export class QuizSession {
  constructor(data, presentation, { random = Math.random, state = null } = {}) {
    assert(isObject(presentation) && typeof presentation.dataset_version === 'string'
      && presentation.dataset_version.length > 0, 'A dataset version is required.');
    this.data = data;
    this.presentation = presentation;
    this.random = random;
    this.engine = new Recommender(data);
    this.characters = new Map();
    for (const work of this.engine.works.values()) {
      for (const character of work.characters ?? []) this.characters.set(character.id, character);
    }
    const narrator = presentation.narrator;
    if (narrator?.id && !this.characters.has(narrator.id)) this.characters.set(narrator.id, narrator);
    if (state !== null) {
      this.restore(state);
      return;
    }
    const workIds = [...this.engine.works.keys()];
    const tieOrder = [...workIds];
    for (let index = tieOrder.length - 1; index > 0; index -= 1) {
      const target = this._randomIndex(index + 1);
      [tieOrder[index], tieOrder[target]] = [tieOrder[target], tieOrder[index]];
    }
    this.engine = new Recommender(data, { tieOrder });
    this.state = {
      formatVersion: FORMAT_VERSION,
      datasetVersion: presentation.dataset_version,
      started: false,
      phase: 'question',
      revision: 0,
      activeStepId: 'step-0',
      workIdsSnapshot: workIds,
      tieOrder,
      initialSetId: null,
      answers: [],
      round: null,
      pendingResult: null,
      resultHistory: [],
      introducedCharacterIds: [],
      favoritePromptAnswers: [],
      favoriteCharacterId: null,
      ordinarySinceResult: 0,
    };
  }

  _randomIndex(length) {
    const value = this.random();
    assert(Number.isFinite(value) && value >= 0 && value < 1, 'Random values must be in [0, 1).');
    return Math.floor(value * length);
  }

  _checkStep(token) {
    assert(token === this.state.activeStepId, 'This screen is no longer active.');
  }

  _advanceStep() {
    this.state.revision += 1;
    this.state.activeStepId = `step-${this.state.revision}`;
    return this.state;
  }

  _shownIds() {
    return this.state.resultHistory.map((result) => result.workId);
  }

  _favoriteCandidates(shownIds, askedIds) {
    const asked = new Set(askedIds);
    const shown = new Set(shownIds);
    const candidates = new Map();
    for (const work of this.engine.works.values()) {
      if (shown.has(work.id)) continue;
      for (const character of work.characters ?? []) {
        if (character.id !== 'seiga' && character.favorite_eligible === true && !asked.has(character.id)) {
          candidates.set(character.id, { id: character.id, name: character.name });
        }
      }
    }
    return [...candidates.values()];
  }

  _eligibleFavorites() {
    return this._favoriteCandidates(this._shownIds(), this.state.favoritePromptAnswers.map((item) => item.characterId));
  }

  _favoriteSlots(queueLength, roundNumber) {
    if (queueLength < 2) return [];
    if (roundNumber > 1 || queueLength === 2) return [1];
    return Array.from({ length: Math.min(4, queueLength - 1) - 1 }, (_, index) => index + 2);
  }

  _planFavorite(queue, number) {
    const slots = this._favoriteSlots(queue.length, number);
    const candidates = this._eligibleFavorites();
    if (!slots.length || !candidates.length) return null;
    // Fix both choices now: returning to a question or restoring never rerolls them.
    if (number > 1 && this._randomIndex(2) === 1) return null;
    const after = number === 1 ? slots[this._randomIndex(slots.length)] : slots[0];
    return { after, characterId: candidates[this._randomIndex(candidates.length)].id };
  }

  _makeRound(queue, number) {
    assert(Array.isArray(queue) && unique(queue) && queue.every((id) => this.engine.questions.has(id)),
      'The question queue is invalid.');
    const answered = new Set(this.state.answers.map(([id]) => id));
    assert(queue.every((id) => !answered.has(id)), 'A question was already answered.');
    this.state.round = {
      number, queue: [...queue], index: 0, answerStart: this.state.answers.length,
      favoritePlan: this._planFavorite(queue, number),
    };
    this.state.phase = 'question';
    this.state.favoriteCharacterId = null;
    if (queue.length === 0) this._prepareResult();
  }

  _prepareResult(favorite = null) {
    const row = this.engine.rank(this.state.answers, this._shownIds(), favorite)[0];
    assert(row && this.engine.works.has(row.work_id), 'No unintroduced work is available.');
    const evidence = reasonFor(this.data, row, this.state.answers, favorite);
    const introducedCount = this.state.resultHistory.length + 1;
    this.state.pendingResult = {
      resultId: `result-${introducedCount}`,
      workId: row.work_id,
      trigger: favorite === null ? 'ordinary' : 'favorite',
      reasonKind: evidence.kind,
      lead: evidence.lead,
      reason: evidence.reason ?? null,
      questionId: evidence.questionId ?? null,
      optionId: evidence.optionId ?? null,
      feature: evidence.feature ?? null,
      characterId: evidence.characterId ?? favorite,
      answerCount: this.state.answers.length,
      introducedCount,
      totalWorks: this.state.workIdsSnapshot.length,
      isLast: introducedCount === this.state.workIdsSnapshot.length,
    };
    this.state.phase = 'result';
    this.state.favoriteCharacterId = null;
  }

  start(token) {
    this._checkStep(token);
    assert(!this.state.started, 'This session has already started.');
    assert(this.state.workIdsSnapshot.length > 0, 'There are no published works to recommend.');
    const sets = this.data.rules.first_question_sets ?? [];
    const count = this.data.rules.first_normal_result_after ?? 5;
    const selected = sets.length ? sets[this._randomIndex(sets.length)] : null;
    const queue = (selected?.questions ?? [...this.engine.questions.keys()]).slice(0, count);
    this.state.started = true;
    this.state.initialSetId = selected?.id ?? null;
    this._makeRound(queue, 1);
    return this._advanceStep();
  }

  currentQuestion() {
    const { started, phase, round } = this.state;
    if (!started || phase !== 'question' || !round) return null;
    const question = this.engine.questions.get(round.queue[round.index]);
    if (!question) return null;
    return {
      id: question.id,
      text: question.text,
      options: question.options,
      allowSkip: question.allow_skip === true,
      ordinal: round.index + 1,
      roundTotal: round.queue.length,
      canUndo: round.index > 0,
    };
  }

  answer(optionId, token) {
    this._checkStep(token);
    const question = this.currentQuestion();
    assert(question, 'There is no active question.');
    assert(optionId === null ? question.allowSkip : question.options.some((option) => option.id === optionId),
      'The answer is not an option for this question.');
    this.state.answers.push([question.id, optionId]);
    this.state.round.index += 1;
    this.state.ordinarySinceResult += 1;
    if (this.state.round.index === this.state.round.queue.length) this._prepareResult();
    else {
      const plan = this.state.round.favoritePlan;
      if (plan && this.state.round.index === plan.after
        && !this.state.favoritePromptAnswers.some((item) => item.characterId === plan.characterId)) {
        this.state.phase = 'favorite';
        this.state.favoriteCharacterId = plan.characterId;
      }
    }
    return this._advanceStep();
  }

  undo(token) {
    this._checkStep(token);
    assert(this.currentQuestion()?.canUndo, 'An earlier result cannot be changed.');
    this.state.answers.pop();
    this.state.round.index -= 1;
    this.state.ordinarySinceResult -= 1;
    return this._advanceStep();
  }

  eligibleFavorites() {
    if (!this.state.started || this.state.phase !== 'question' || this.state.ordinarySinceResult < 1) return [];
    return this._eligibleFavorites();
  }

  answerFavorite(answer, token) {
    this._checkStep(token);
    assert(this.state.phase === 'favorite' && FAVORITE_ANSWERS.has(answer), 'There is no matching favorite question.');
    const characterId = this.state.favoriteCharacterId;
    assert(this._eligibleFavorites().some((character) => character.id === characterId), 'This favorite is no longer available.');
    this.state.favoritePromptAnswers.push({
      characterId, answer, roundNumber: this.state.round.number, after: this.state.round.index,
    });
    if (answer === 'yes') {
      // Unanswered queued questions remain available to later rounds.
      this.state.round.queue = this.state.round.queue.slice(0, this.state.round.index);
      this._prepareResult(characterId);
    } else {
      this.state.phase = 'question';
      this.state.favoriteCharacterId = null;
    }
    return this._advanceStep();
  }

  commitResult(resultId, token) {
    // A renderer may confirm the same visible card more than once.
    if (this.state.phase === 'result' && this.state.pendingResult === null
      && this.state.resultHistory.at(-1)?.resultId === resultId) return this.state;
    this._checkStep(token);
    assert(this.state.phase === 'result' && this.state.pendingResult?.resultId === resultId,
      'This result is no longer awaiting display.');
    assert(!this._shownIds().includes(this.state.pendingResult.workId), 'This work has already been introduced.');
    this.state.resultHistory.push(this.state.pendingResult);
    this.state.pendingResult = null;
    this.state.ordinarySinceResult = 0;
    return this._advanceStep();
  }

  decline(token) {
    this._checkStep(token);
    assert(this.state.phase === 'result' && this.state.pendingResult === null
      && this.state.resultHistory.length > 0, 'Only the latest displayed result can be declined.');
    if (this.state.resultHistory.length === this.state.workIdsSnapshot.length) {
      this.state.phase = 'ending';
    } else {
      const count = this.data.rules.ordinary_questions_between_results ?? 2;
      const queue = this.engine.nextQuestions(this.state.answers, this._shownIds()).slice(0, count);
      this._makeRound(queue, this.state.resultHistory.length + 1);
    }
    return this._advanceStep();
  }

  introduceCharacters(characterIds, token) {
    this._checkStep(token);
    assert(Array.isArray(characterIds) && characterIds.every((id) => typeof id === 'string'),
      'Characters must be an array of IDs.');
    const visibleWorkIds = [...this._shownIds(), ...(this.state.pendingResult ? [this.state.pendingResult.workId] : [])];
    const allowed = new Set([this.presentation.narrator?.id]);
    if (this.state.phase === 'favorite') allowed.add(this.state.favoriteCharacterId);
    for (const item of this.state.favoritePromptAnswers) allowed.add(item.characterId);
    for (const workId of visibleWorkIds) {
      for (const id of this.presentation.public_cast_by_work?.[workId] ?? []) allowed.add(id);
    }
    assert(characterIds.every((id) => allowed.has(id) && this.characters.has(id)),
      'This character has not been approved for display here.');
    const additions = characterIds.filter((id) => !this.state.introducedCharacterIds.includes(id));
    if (additions.length === 0) return this.state;
    this.state.introducedCharacterIds = [...new Set([...this.state.introducedCharacterIds, ...additions])];
    return this._advanceStep();
  }

  exportState() {
    return clone(this.state);
  }

  restore(saved) {
    this._validateSavedState(saved);
    this.state = clone(saved);
    this.engine = new Recommender(this.data, { tieOrder: this.state.tieOrder });
    return this.state;
  }

  _validateSavedState(saved) {
    const fail = 'The saved session is invalid or belongs to a different dataset.';
    assert(isObject(saved) && saved.formatVersion === FORMAT_VERSION
      && saved.datasetVersion === this.presentation.dataset_version, fail);
    assert(typeof saved.started === 'boolean' && PHASES.has(saved.phase)
      && isInteger(saved.revision) && saved.activeStepId === `step-${saved.revision}`, fail);
    const workIds = [...this.engine.works.keys()];
    assert(Array.isArray(saved.workIdsSnapshot) && sameArray(saved.workIdsSnapshot, workIds)
      && Array.isArray(saved.tieOrder) && saved.tieOrder.length === workIds.length
      && unique(saved.tieOrder) && saved.tieOrder.every((id) => this.engine.works.has(id)), fail);
    assert(Array.isArray(saved.answers) && saved.answers.length <= this.engine.questions.size, fail);
    for (const pair of saved.answers) {
      assert(Array.isArray(pair) && pair.length === 2 && this.engine.questions.has(pair[0]), fail);
      const question = this.engine.questions.get(pair[0]);
      assert(pair[1] === null ? question.allow_skip === true
        : question.options.some((option) => option.id === pair[1]), fail);
    }
    assert(unique(saved.answers.map(([id]) => id)), fail);
    assert(Array.isArray(saved.resultHistory) && saved.resultHistory.length <= workIds.length, fail);
    const validationEngine = new Recommender(this.data, { tieOrder: saved.tieOrder });
    let previousAnswerCount = 0;
    const results = [...saved.resultHistory];
    if (saved.pendingResult !== null) results.push(saved.pendingResult);
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      assert(isObject(result) && result.resultId === `result-${index + 1}`
        && this.engine.works.has(result.workId) && ['ordinary', 'favorite'].includes(result.trigger)
        && REASON_KINDS.has(result.reasonKind) && typeof result.lead === 'string'
        && result.lead.length <= 20000 && (result.reason === null || typeof result.reason === 'string')
        && (result.reason?.length ?? 0) <= 20000
        && isInteger(result.answerCount) && result.answerCount >= previousAnswerCount
        && result.answerCount <= saved.answers.length
        && result.introducedCount === index + 1 && result.totalWorks === workIds.length
        && result.isLast === (index + 1 === workIds.length), fail);
      for (const field of ['questionId', 'optionId', 'feature', 'characterId']) {
        assert(result[field] === null || (typeof result[field] === 'string' && result[field].length <= 200), fail);
      }
      if (result.questionId !== null) {
        assert(saved.answers.slice(0, result.answerCount)
          .some(([id, optionId]) => id === result.questionId && optionId === result.optionId), fail);
      } else assert(result.optionId === null, fail);
      if (result.characterId !== null) assert(this.characters.has(result.characterId), fail);
      if (result.feature !== null) {
        assert(Object.hasOwn(this.data.features.taste, result.feature)
          || Object.hasOwn(this.data.features.behavior, result.feature), fail);
      }
      if (result.trigger === 'favorite') {
        assert(result.reasonKind === 'favorite' && result.characterId !== null && result.answerCount > previousAnswerCount
          && this.engine.works.get(result.workId).characters.some((character) =>
            character.id === result.characterId && character.favorite_eligible === true), fail);
      }
      const resultAnswers = saved.answers.slice(0, result.answerCount);
      const favorite = result.trigger === 'favorite' ? result.characterId : null;
      const ranked = validationEngine.rank(resultAnswers, results.slice(0, index).map((item) => item.workId), favorite);
      assert(ranked[0]?.work_id === result.workId, fail);
      const expectedReason = reasonFor(this.data, ranked[0], resultAnswers, favorite);
      assert(result.reasonKind === expectedReason.kind && result.lead === expectedReason.lead
        && result.reason === (expectedReason.reason ?? null)
        && result.questionId === (expectedReason.questionId ?? null)
        && result.optionId === (expectedReason.optionId ?? null)
        && result.feature === (expectedReason.feature ?? null)
        && result.characterId === (expectedReason.characterId ?? favorite), fail);
      previousAnswerCount = result.answerCount;
    }
    assert(results.length <= workIds.length && unique(results.map((result) => result.workId)), fail);
    assert(Array.isArray(saved.introducedCharacterIds) && unique(saved.introducedCharacterIds)
      && saved.introducedCharacterIds.every((id) => this.characters.has(id)), fail);
    const allowedCharacters = new Set([this.presentation.narrator?.id]);
    if (saved.phase === 'favorite') allowedCharacters.add(saved.favoriteCharacterId);
    assert(Array.isArray(saved.favoritePromptAnswers)
      && unique(saved.favoritePromptAnswers.map((item) => item?.characterId))
      && unique(saved.favoritePromptAnswers.map((item) => item?.roundNumber)), fail);
    for (const item of saved.favoritePromptAnswers) {
      assert(isObject(item) && this.characters.has(item.characterId)
        && FAVORITE_ANSWERS.has(item.answer) && isInteger(item.roundNumber, 1)
        && isInteger(item.after, 1), fail);
      allowedCharacters.add(item.characterId);
    }
    for (const result of results) {
      for (const id of this.presentation.public_cast_by_work?.[result.workId] ?? []) allowedCharacters.add(id);
    }
    assert(saved.introducedCharacterIds.every((id) => allowedCharacters.has(id)), fail);
    for (const result of results.filter((item) => item.trigger === 'favorite')) {
      assert(saved.favoritePromptAnswers.some((item) => item.characterId === result.characterId
        && item.answer === 'yes' && item.roundNumber === result.introducedCount), fail);
    }
    assert(isInteger(saved.ordinarySinceResult), fail);
    const sets = this.data.rules.first_question_sets ?? [];
    assert(saved.initialSetId === null || sets.some((set) => set.id === saved.initialSetId), fail);
    if (!saved.started) {
      assert(saved.phase === 'question' && saved.round === null && saved.answers.length === 0
        && results.length === 0 && saved.favoritePromptAnswers.length === 0
        && saved.favoriteCharacterId === null && saved.ordinarySinceResult === 0
        && saved.initialSetId === null, fail);
      return;
    }
    assert(workIds.length > 0 && (sets.length === 0 || saved.initialSetId !== null), fail);
    const round = saved.round;
    assert(isObject(round) && isInteger(round.number, 1) && isInteger(round.answerStart)
      && isInteger(round.index) && Array.isArray(round.queue) && unique(round.queue)
      && round.queue.every((id) => this.engine.questions.has(id))
      && round.index <= round.queue.length && round.answerStart + round.index === saved.answers.length, fail);
    const priorAnswers = saved.answers.slice(0, round.answerStart).map(([id]) => id);
    assert(round.queue.every((id) => !priorAnswers.includes(id))
      && sameArray(round.queue.slice(0, round.index), saved.answers.slice(round.answerStart).map(([id]) => id)), fail);
    const roundLimit = round.number === 1 ? (this.data.rules.first_normal_result_after ?? 5)
      : (this.data.rules.ordinary_questions_between_results ?? 2);
    assert(round.queue.length <= roundLimit, fail);
    const expectedQueueFor = (number) => {
      if (number === 1) {
        const selected = sets.find((set) => set.id === saved.initialSetId);
        return (selected?.questions ?? [...this.engine.questions.keys()])
          .slice(0, this.data.rules.first_normal_result_after ?? 5);
      }
      const previousCount = results[number - 2]?.answerCount ?? 0;
      return validationEngine.nextQuestions(saved.answers.slice(0, previousCount),
        results.slice(0, number - 1).map((result) => result.workId))
        .slice(0, this.data.rules.ordinary_questions_between_results ?? 2);
    };
    if (round.number === 1) {
      const initialQueue = expectedQueueFor(1);
      assert(sameArray(round.queue, initialQueue.slice(0, round.queue.length)), fail);
      const interrupted = ['result', 'ending'].includes(saved.phase) && results.at(-1)?.trigger === 'favorite';
      if (!interrupted) assert(round.queue.length === initialQueue.length, fail);
    }
    const committedResult = saved.phase === 'result' && saved.pendingResult === null;
    const expectedRoundNumber = saved.resultHistory.length + (committedResult || saved.phase === 'ending' ? 0 : 1);
    assert(round.number === expectedRoundNumber, fail);
    if (round.number > 1) {
      const expectedQueue = expectedQueueFor(round.number);
      const interrupted = ['result', 'ending'].includes(saved.phase) && results.at(-1)?.trigger === 'favorite';
      assert(sameArray(round.queue, interrupted ? expectedQueue.slice(0, round.index) : expectedQueue), fail);
    }
    const previousResult = committedResult || saved.phase === 'ending'
      ? saved.resultHistory.at(-2) : saved.resultHistory.at(-1);
    assert(round.answerStart === (previousResult?.answerCount ?? 0), fail);
    if (saved.phase === 'question' || saved.phase === 'favorite') {
      assert(saved.pendingResult === null && round.index < round.queue.length, fail);
    } else {
      assert(round.index === round.queue.length && results.at(-1)?.answerCount === saved.answers.length, fail);
      if (saved.phase === 'ending') assert(saved.pendingResult === null && saved.resultHistory.length === workIds.length, fail);
      else assert(results.length > 0, fail);
    }
    const latestCommittedCount = saved.resultHistory.at(-1)?.answerCount ?? 0;
    assert(saved.ordinarySinceResult === saved.answers.length - latestCommittedCount, fail);

    // A prompt is allowed once per round, and only for someone with an unseen eligible work.
    let previousPromptRound = 0;
    for (const item of saved.favoritePromptAnswers) {
      assert(item.roundNumber > previousPromptRound && item.roundNumber <= round.number, fail);
      const queue = expectedQueueFor(item.roundNumber);
      const priorShown = results.slice(0, item.roundNumber - 1).map((result) => result.workId);
      const priorAsked = saved.favoritePromptAnswers.filter((entry) => entry.roundNumber < item.roundNumber)
        .map((entry) => entry.characterId);
      assert(this._favoriteSlots(queue.length, item.roundNumber).includes(item.after)
        && this._favoriteCandidates(priorShown, priorAsked).some((character) => character.id === item.characterId), fail);
      const result = results[item.roundNumber - 1];
      const priorCount = results[item.roundNumber - 2]?.answerCount ?? 0;
      if (item.answer === 'yes') {
        assert(result?.trigger === 'favorite' && result.characterId === item.characterId
          && result.answerCount === priorCount + item.after, fail);
      } else if (result) {
        assert(result.trigger === 'ordinary' && result.answerCount === priorCount + queue.length, fail);
      }
      previousPromptRound = item.roundNumber;
    }
    const firstCandidates = this._favoriteCandidates([], []);
    if (round.number > 1 && firstCandidates.length && this._favoriteSlots(expectedQueueFor(1).length, 1).length) {
      assert(saved.favoritePromptAnswers.some((item) => item.roundNumber === 1), fail);
    }
    const plan = round.favoritePlan;
    const promptAnswer = saved.favoritePromptAnswers.find((item) => item.roundNumber === round.number);
    const eligibleAtRoundStart = this._favoriteCandidates(
      results.slice(0, round.number - 1).map((result) => result.workId),
      saved.favoritePromptAnswers.filter((item) => item.roundNumber < round.number).map((item) => item.characterId));
    const slots = this._favoriteSlots(expectedQueueFor(round.number).length, round.number);
    if (plan === null) {
      assert(!promptAnswer && saved.phase !== 'favorite'
        && !(round.number === 1 && slots.length && eligibleAtRoundStart.length), fail);
    } else {
      assert(isObject(plan) && slots.includes(plan.after)
        && eligibleAtRoundStart.some((character) => character.id === plan.characterId), fail);
      if (promptAnswer) assert(promptAnswer.characterId === plan.characterId && promptAnswer.after === plan.after, fail);
      else if (saved.phase === 'question') assert(round.index < plan.after, fail);
      else assert(saved.phase === 'favorite', fail);
    }
    if (saved.phase === 'favorite') {
      assert(typeof saved.favoriteCharacterId === 'string'
        && plan?.characterId === saved.favoriteCharacterId && round.index === plan.after && !promptAnswer
        && saved.ordinarySinceResult >= 1
        && !saved.favoritePromptAnswers.some((item) => item.characterId === saved.favoriteCharacterId)
        && [...this.engine.works.values()].some((work) => !saved.resultHistory.some((result) => result.workId === work.id)
          && (work.characters ?? []).some((character) => character.id === saved.favoriteCharacterId && character.favorite_eligible === true)), fail);
    } else assert(saved.favoriteCharacterId === null, fail);
  }
}
