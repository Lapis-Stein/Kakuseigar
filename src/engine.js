/** Browser-only recommendation and continuation-question selection. */
const CHANNELS = ['taste', 'behavior'];
const ROLES = ['main', 'support', 'indirect'];
// Match Python 3.12+ sum for float terms; small errors can change character ties.
function compensatedSum(values) {
  let sum = 0;
  let correction = 0;
  for (const value of values) {
    const next = sum + value;
    correction += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum;
    sum = next;
  }
  return correction && Number.isFinite(correction) ? sum + correction : sum;
}
const weightedProfile = (weights, profile) => compensatedSum(Object.entries(weights).map(([key, weight]) => weight * (profile[key] ?? 0)));
const total = (weights) => compensatedSum(Object.values(weights));

function compareText(left, right) {
  const a = Array.from(left, (value) => value.codePointAt(0));
  const b = Array.from(right, (value) => value.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

// Python round(float, 6): round the actual binary fraction, with ties to even.
function roundSix(value) {
  if (!Number.isFinite(value) || value === 0) return value;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = exponent === 0 ? fraction : fraction + (1n << 52n);
  const shift = exponent === 0 ? -1074 : exponent - 1075;
  let numerator = mantissa * 1000000n;
  let denominator = 1n;
  if (shift >= 0) numerator <<= BigInt(shift);
  else denominator <<= BigInt(-shift);
  let rounded = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && rounded % 2n !== 0n)) rounded += 1n;
  return Math.sign(value) * Number(rounded) / 1000000;
}

export class Recommender {
  constructor(data, { tieOrder = [], entryPoints } = {}) {
    this.data = data;
    this.rules = data.rules;
    this.questions = new Map(data.questions.map((question) => [question.id, question]));
    this.works = new Map(data.works.map((work) => [work.id, work]));
    this.maxima = this.rules.profile_maxima ?? { taste: 2, behavior: 2 };
    this.prior = this.rules.entry_prior ?? { max_points: 0, light_entry_max: 4 };
    this.entryPoints = entryPoints ?? this.prior.max_points;
    if (!Number.isFinite(this.entryPoints) || this.entryPoints < 0) throw new TypeError('Invalid entryPoints');
    this.tieOrder = new Map();
    for (const [index, id] of tieOrder.entries()) {
      if (!this.works.has(id) || this.tieOrder.has(id)) throw new TypeError('Invalid tieOrder');
      this.tieOrder.set(id, index);
    }
    this.options = new Map(data.questions.map((question) => [question.id, new Map(question.options.map((option) => [option.id, option]))]));
  }

  evidence(answers) {
    const values = { taste: {}, behavior: {} };
    const counts = { taste: 0, behavior: 0 };
    for (const [qid, oid] of answers) {
      const question = this.questions.get(qid);
      if (!question) throw new RangeError(`Unknown question: ${qid}`);
      if (oid === null) continue;
      const option = this.options.get(qid).get(oid);
      if (!option) throw new RangeError(`Unknown option for question: ${qid}`);
      counts[question.channel] += 1;
      const sum = total(option.weights);
      for (const [feature, weight] of Object.entries(option.weights)) {
        values[question.channel][feature] = (values[question.channel][feature] ?? 0) + weight / sum;
      }
    }
    return Object.fromEntries(CHANNELS.map((channel) => [channel, counts[channel] === 0 ? null : Object.fromEntries(Object.entries(values[channel]).map(([key, value]) => [key, value / counts[channel]]))]));
  }

  score(work, answers) { return this._score(work, this.evidence(answers)); }

  _score(work, evidence) {
    let taste = null;
    let behavior = null;
    let character = null;
    if (evidence.taste !== null) taste = 100 * weightedProfile(evidence.taste, work.taste) / this.maxima.taste;
    if (evidence.behavior !== null) {
      for (const member of work.characters) {
        if (member.behavior === null) continue;
        const value = 100 * weightedProfile(evidence.behavior, member.behavior) / this.maxima.behavior * this.rules.role_weights[member.role];
        if (behavior === null || value > behavior || (value === behavior && compareText(member.id, character) > 0)) {
          behavior = value;
          character = member.id;
        }
      }
    }
    const combined = taste !== null && behavior !== null
      ? this.rules.mixed_weights.taste * taste + this.rules.mixed_weights.behavior * behavior : taste ?? behavior;
    return { work_id: work.id, taste, behavior, combined, character };
  }

  rank(answers, shown = [], favorite = null) {
    const seen = new Set(shown);
    const evidence = this.evidence(answers);
    let rows = [...this.works.values()].filter((work) => !seen.has(work.id) && (!favorite || work.characters.some((member) => member.id === favorite && member.favorite_eligible))).map((work) => this._score(work, evidence));
    if (rows.length > 0 && !favorite && evidence.taste !== null) {
      const best = Math.max(...rows.map((row) => row.taste));
      rows = rows.filter((row) => row.taste >= best - this.rules.taste_candidate_band - 1e-9);
    }
    for (const row of rows) {
      const work = this.works.get(row.work_id);
      const hasPrior = !favorite && row.combined !== null;
      row.entry_bonus = hasPrior ? this.entryPoints * (work.light_entry ?? 0) / this.prior.light_entry_max : 0;
      row.entry_penalty = hasPrior ? work.entry_penalty ?? 0 : 0;
      row.ranking_score = row.combined === null ? null : row.combined + row.entry_bonus - row.entry_penalty;
      if (favorite) row.favorite_role = work.characters.find((member) => member.id === favorite && member.favorite_eligible).role;
    }
    rows.sort((left, right) => {
      if (favorite) {
        const roleOrder = ROLES.indexOf(left.favorite_role) - ROLES.indexOf(right.favorite_role);
        if (roleOrder !== 0) return roleOrder;
      }
      for (const key of ['ranking_score', 'taste', 'behavior']) {
        const delta = roundSix(right[key] || 0) - roundSix(left[key] || 0);
        if (delta !== 0) return delta;
      }
      const delta = (this.tieOrder.get(left.work_id) ?? Infinity) - (this.tieOrder.get(right.work_id) ?? Infinity);
      return Number.isNaN(delta) || delta === 0 ? compareText(left.work_id, right.work_id) : delta;
    });
    return rows;
  }

  nextQuestions(answers, shown = []) {
    const settings = this.rules.continuation_selection;
    const remaining = this.rank(answers, shown).slice(0, settings.top_candidates);
    if (remaining.length === 0) return [];
    const asked = new Set(answers.map(([id]) => id));
    const families = new Set([...asked].map((id) => this.questions.get(id).family));
    const priority = new Map(this.rules.continuation_priority.map((id, index) => [id, index]));
    const chosen = [];
    for (const channel of settings.channel_order) {
      let best = null;
      let bestKey = null;
      for (const question of this.questions.values()) {
        if (question.channel !== channel || asked.has(question.id)) continue;
        let spread = 0;
        for (const option of question.options) {
          const evidence = { taste: null, behavior: null };
          const sum = total(option.weights);
          evidence[channel] = Object.fromEntries(Object.entries(option.weights).map(([key, value]) => [key, value / sum]));
          const scores = remaining.map((row) => this._score(this.works.get(row.work_id), evidence)[channel]).filter((score) => score !== null);
          if (scores.length > 0) {
            const mean = compensatedSum(scores) / scores.length;
            spread += compensatedSum(scores.map((score) => (score - mean) ** 2)) / scores.length;
          }
        }
        spread /= question.options.length;
        const key = [Number(settings.prefer_new_family && !families.has(question.family)), roundSix(spread), -priority.get(question.id)];
        let better = bestKey === null;
        if (bestKey !== null) {
          for (let index = 0; index < key.length; index += 1) {
            if (key[index] === bestKey[index]) continue;
            better = key[index] > bestKey[index];
            break;
          }
        }
        if (better) { best = question; bestKey = key; }
      }
      if (best) { chosen.push(best.id); asked.add(best.id); families.add(best.family); }
    }
    return chosen;
  }
}

const DEFAULT_LEADS = {
  taste: '今読みたいのは、このあたりでは？',
  behavior: 'その選び方なら、このやり取りは気になるかもしれません。',
  favorite: '{character}の活躍が見たい？では、こちらなどいかがでしょう',
  exploration: '少し方向を変えて、こちらはいかが？',
  no_evidence: 'では、まずこちらから。',
};

export function reasonFor(data, row, answers, favorite = null) {
  const work = data.works.find((item) => item.id === row.work_id);
  if (!work) throw new RangeError(`Unknown work: ${row.work_id}`);
  const output = { kind: 'exploration', lead: '', reason: null, questionId: null, optionId: null, feature: null, characterId: null };
  let member = null;
  if (favorite) {
    member = work.characters.find((item) => item.id === favorite && item.favorite_eligible);
    if (!member) throw new RangeError('Favorite is not eligible in the recommended work');
    output.kind = 'favorite'; output.characterId = favorite;
  } else if (row.combined === null) output.kind = 'no_evidence';
  else if (row.taste !== null && row.taste >= 60) output.kind = 'taste';
  else if (row.behavior !== null && row.behavior >= 60) {
    output.kind = 'behavior';
    member = work.characters.find((item) => item.id === row.character);
    output.characterId = member?.id ?? null;
  }
  if (output.kind === 'taste' || output.kind === 'behavior') {
    const profile = output.kind === 'taste' ? work.taste : member?.behavior;
    let strongest = null;
    if (profile) for (const [qid, oid] of answers) {
      const question = data.questions.find((item) => item.id === qid);
      if (!question || question.channel !== output.kind || oid === null) continue;
      const option = question.options.find((item) => item.id === oid);
      if (!option) continue;
      const contribution = weightedProfile(option.weights, profile) / total(option.weights);
      if (contribution <= 0 || (strongest && contribution <= strongest.contribution)) continue;
      let feature = null;
      let largest = 0;
      for (const [key, weight] of Object.entries(option.weights)) {
        const score = weight * (profile[key] ?? 0);
        if (score > largest) { largest = score; feature = key; }
      }
      if (feature) strongest = { contribution, questionId: qid, optionId: oid, feature };
    }
    if (strongest) {
      output.questionId = strongest.questionId; output.optionId = strongest.optionId; output.feature = strongest.feature;
      const label = data.features[output.kind][strongest.feature];
      output.reason = output.kind === 'taste' ? `「${label}」が気になるなら、こちらのお話はいかがでしょう。` : `「${label}」という選び方から、こちらのお話をご紹介します。`;
    } else { output.kind = 'exploration'; output.characterId = null; }
  }
  const lead = data.copy_draft?.[output.kind];
  output.lead = typeof lead === 'string' && lead.trim() ? lead : DEFAULT_LEADS[output.kind];
  if (favorite) output.lead = output.lead.replaceAll('{character}', member.name);
  return output;
}

/** Validate the public runtime structure before starting a session. */
export function validateRuntime(data) {
  const fail = (path, message) => { throw new TypeError(`${path}: ${message}`); };
  const object = (value, path) => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected object'); return value; };
  const array = (value, path) => { if (!Array.isArray(value)) fail(path, 'expected array'); return value; };
  const text = (value, path) => { if (typeof value !== 'string' || !value.trim()) fail(path, 'expected text'); };
  const number = (value, path, min = 0, max = Infinity) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(path, 'invalid number'); };
  const integer = (value, path) => { number(value, path, 1); if (!Number.isInteger(value)) fail(path, 'expected positive integer'); };
  const boolean = (value, path) => { if (typeof value !== 'boolean') fail(path, 'expected boolean'); };
  const unique = (values, path) => { if (new Set(values).size !== values.length) fail(path, 'duplicate IDs'); };
  const url = (value, path, hosts) => {
    let parsed;
    try { parsed = new URL(value); } catch { fail(path, 'invalid URL'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !hosts.includes(parsed.hostname)) fail(path, 'unsupported URL');
    return parsed;
  };
  object(data, 'data');
  if (data.schema_version !== '0.4') fail('schema_version', 'unsupported version');
  object(data.features, 'features');
  for (const channel of CHANNELS) {
    object(data.features[channel], `features.${channel}`);
    if (!Object.keys(data.features[channel]).length) fail(`features.${channel}`, 'missing labels');
    for (const [key, label] of Object.entries(data.features[channel])) text(label, `features.${channel}.${key}`);
  }
  const rules = object(data.rules, 'rules');
  object(rules.profile_maxima, 'rules.profile_maxima');
  if (rules.profile_maxima.taste !== 4 || rules.profile_maxima.behavior !== 2) fail('rules.profile_maxima', 'schema 0.4 requires 4 and 2');
  object(rules.mixed_weights, 'rules.mixed_weights');
  for (const channel of CHANNELS) number(rules.mixed_weights[channel], `rules.mixed_weights.${channel}`, 0, 1);
  if (Math.abs(rules.mixed_weights.taste + rules.mixed_weights.behavior - 1) > 1e-9) fail('rules.mixed_weights', 'must sum to one');
  object(rules.role_weights, 'rules.role_weights');
  for (const role of ROLES) number(rules.role_weights[role], `rules.role_weights.${role}`, 0, 1);
  number(rules.taste_candidate_band, 'rules.taste_candidate_band', 0, 100);
  object(rules.entry_prior, 'rules.entry_prior');
  number(rules.entry_prior.max_points, 'rules.entry_prior.max_points', 0, 100);
  if (rules.entry_prior.light_entry_max !== 4) fail('rules.entry_prior.light_entry_max', 'schema 0.4 requires 4');
  integer(rules.first_normal_result_after, 'rules.first_normal_result_after');
  integer(rules.ordinary_questions_between_results, 'rules.ordinary_questions_between_results');
  boolean(rules.skip_counts_as_presented, 'rules.skip_counts_as_presented');
  const profile = (value, channel, path, max) => {
    object(value, path);
    for (const [key, score] of Object.entries(value)) {
      if (!Object.prototype.hasOwnProperty.call(data.features[channel], key)) fail(path, 'unknown feature');
      number(score, `${path}.${key}`, 0, max);
    }
  };
  const questions = array(data.questions, 'questions');
  for (const [index, question] of questions.entries()) {
    const path = `questions[${index}]`;
    object(question, path); text(question.id, `${path}.id`); text(question.family, `${path}.family`); text(question.text, `${path}.text`);
    if (!CHANNELS.includes(question.channel)) fail(`${path}.channel`, 'unknown channel');
    boolean(question.allow_skip, `${path}.allow_skip`);
    const options = array(question.options, `${path}.options`);
    if (options.length < 2 || options.length > 4) fail(`${path}.options`, 'expected two to four');
    for (const option of options) {
      object(option, `${path}.option`); text(option.id, `${path}.option.id`); text(option.text, `${path}.option.text`);
      profile(option.weights, question.channel, `${path}.option.weights`, Infinity);
      if (total(option.weights) <= 0) fail(`${path}.option.weights`, 'expected positive total');
    }
    unique(options.map((option) => option.id), `${path}.options`);
  }
  const questionIds = questions.map((question) => question.id);
  unique(questionIds, 'questions');
  const known = new Set(questionIds);
  const references = (values, path) => { array(values, path); unique(values, path); if (values.some((id) => !known.has(id))) fail(path, 'unknown question reference'); };
  const sets = array(rules.first_question_sets, 'rules.first_question_sets');
  if (!sets.length && questions.length) fail('rules.first_question_sets', 'missing initial set');
  for (const set of sets) {
    object(set, 'question set'); text(set.id, 'question set.id'); references(set.questions, 'question set.questions');
    if (set.questions.length !== rules.first_normal_result_after) fail('question set.questions', 'unexpected initial count');
  }
  unique(sets.map((set) => set.id), 'rules.first_question_sets');
  references(rules.continuation_priority, 'rules.continuation_priority');
  if (rules.continuation_priority.length !== questions.length) fail('rules.continuation_priority', 'must include every question');
  const selection = object(rules.continuation_selection, 'rules.continuation_selection');
  if (selection.method !== 'remaining_top_spread') fail('rules.continuation_selection.method', 'unsupported method');
  integer(selection.top_candidates, 'rules.continuation_selection.top_candidates');
  if (JSON.stringify(selection.channel_order) !== JSON.stringify(CHANNELS)) fail('rules.continuation_selection.channel_order', 'expected taste then behavior');
  if (selection.prefer_new_family !== true) fail('rules.continuation_selection.prefer_new_family', 'expected true');
  const works = array(data.works, 'works');
  for (const [index, work] of works.entries()) {
    const path = `works[${index}]`;
    object(work, path); text(work.id, `${path}.id`); text(work.title, `${path}.title`);
    const link = url(work.pixiv_url, `${path}.pixiv_url`, ['pixiv.net', 'www.pixiv.net']);
    if (link.pathname !== '/novel/show.php' || !/^[1-9]\d*$/.test(link.searchParams.get('id') ?? '')) fail(`${path}.pixiv_url`, 'expected novel link');
    if (work.author_caption !== null && typeof work.author_caption !== 'string') fail(`${path}.author_caption`, 'expected text or null');
    profile(work.taste, 'taste', `${path}.taste`, 4); number(work.light_entry, `${path}.light_entry`, 0, 4); number(work.entry_penalty, `${path}.entry_penalty`, 0, 100);
    const characters = array(work.characters, `${path}.characters`);
    for (const member of characters) {
      object(member, `${path}.character`); text(member.id, `${path}.character.id`); text(member.name, `${path}.character.name`);
      if (!ROLES.includes(member.role)) fail(`${path}.character.role`, 'unknown role');
      boolean(member.favorite_eligible, `${path}.character.favorite_eligible`);
      if (member.behavior !== null) profile(member.behavior, 'behavior', `${path}.character.behavior`, 2);
    }
    unique(characters.map((member) => member.id), `${path}.characters`);
    if (work.draft_intro_by_taste !== undefined) {
      object(work.draft_intro_by_taste, `${path}.draft_intro_by_taste`);
      for (const [key, intro] of Object.entries(work.draft_intro_by_taste)) {
        if (!Object.prototype.hasOwnProperty.call(data.features.taste, key)) fail(`${path}.draft_intro_by_taste`, 'unknown feature');
        text(intro, `${path}.draft_intro_by_taste.${key}`);
      }
    }
  }
  unique(works.map((work) => work.id), 'works');
  if (data.author_x_url !== null) {
    const link = url(data.author_x_url, 'author_x_url', ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
    if (!/^\/[A-Za-z0-9_]{1,15}\/?$/.test(link.pathname)) fail('author_x_url', 'expected author profile');
  }
  return true;
}
