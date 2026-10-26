import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracker, createAnalytics, createBrowserTransport, japanDay,
  ANALYTICS_STORAGE_KEY, ANALYTICS_PREFERENCE_KEY } from '../src/analytics.js';

const options = { datasetVersion: 'public-v1:abc123', appVersion: '20261026-1', workIds: ['01', '02'] };
function storage() {
  const map = new Map();
  return { map, getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value),
    removeItem: key => map.delete(key) };
}
function quiz() {
  return { started: true, datasetVersion: options.datasetVersion, initialSetId: 'set-a',
    tieOrder: ['02', '01'], workIdsSnapshot: ['01', '02'], resultHistory: [] };
}
const result = (index = 1, route = 'ordinary') => ({ workId: index === 1 ? '01' : '02',
  introducedCount: index, totalWorks: 2, trigger: route, answers: 'must not leave browser',
  reason: 'not an analytics parameter', characterId: 'not-a-parameter', score: 99 });
function fixture(extra = {}) {
  const events = [], store = extra.storage || storage();
  const tracker = createTracker({ ...options, storage: store, now: () => '2026-10-26T14:59:00Z',
    randomId: () => 'local-only-marker', emit: (name, params) => events.push({ name, params }), ...extra });
  return { tracker, events, store };
}

test('questions stay local; each recommendation carries only a bounded delta summary', () => {
  const { tracker, events } = fixture();
  tracker.start(quiz());
  tracker.questionShown('round-1:private-question-key', 'ordinary');
  tracker.questionShown('round-1:private-question-key', 'ordinary');
  tracker.questionAction('answer');
  tracker.questionAction('undo');
  tracker.questionAction('skip');
  tracker.questionShown('round-1:favorite-key', 'favorite');
  tracker.questionAction('favorite_answer');
  assert.equal(events.length, 1);
  assert.equal(tracker.questionAction('__proto__'), false);
  assert.equal(tracker.questionAction('unknown'), false);
  tracker.recommend(result());
  const first = events.at(-1);
  assert.equal(first.name, 'work_recommended');
  assert.equal(first.params.work_id, 'work_01');
  assert.equal(first.params.first_recommendation, 'yes');
  assert.equal(first.params.question_count, 2);
  assert.equal(first.params.ordinary_question_count, 1);
  assert.equal(first.params.favorite_question_count, 1);
  assert.equal(first.params.skip_count, 1);
  assert.equal(first.params.undo_count, 1);
  assert.equal(first.params.answer_count, 1);
  assert.equal(first.params.favorite_answer_count, 1);
  assert.deepEqual(Object.keys(first.params).sort(), ['analytics_version', 'dataset_version', 'app_version',
    'play_start_day', 'initial_set', 'total_works', 'work_id', 'recommendation_index',
    'recommendation_route', 'first_recommendation', 'question_count', 'ordinary_question_count',
    'favorite_question_count', 'answer_count', 'skip_count', 'undo_count', 'favorite_answer_count'].sort());
  tracker.questionShown('round-2:q2', 'ordinary');
  tracker.questionAction('answer');
  tracker.recommend(result(2, 'favorite'));
  assert.equal(events.at(-1).params.work_id, 'work_02');
  assert.equal(events.at(-1).params.question_count, 1);
  assert.equal(events.at(-1).params.skip_count, 0);
  assert.equal(events.at(-1).params.first_recommendation, 'no');
  assert.doesNotMatch(JSON.stringify(events), /private-question|favorite-key|local-only-marker|must not leave|not an analytics|not-a-parameter/);
});

test('reload, review and repeated recommendation cannot inflate counts', () => {
  const { tracker, store, events } = fixture();
  const state = quiz();
  tracker.start(state);
  tracker.recommend(result());
  state.resultHistory.push(result());
  assert.equal(tracker.recommend(result()), false);
  assert.equal(tracker.click('01', 'result', result()), true);
  assert.equal(events.at(-1).params.work_id, 'work_01');
  assert.equal(tracker.click('01', 'history', result()), false);
  const local = JSON.parse(store.getItem(ANALYTICS_STORAGE_KEY));
  assert.equal(local.recommendations[0].workId, '01');
  assert.deepEqual(local.opened, ['01']);
  const reload = fixture({ storage: store });
  assert.equal(reload.tracker.sync(state), true);
  assert.equal(reload.tracker.start(state), false);
  assert.equal(reload.tracker.recommend(result()), false);
  assert.equal(reload.tracker.click('01', 'history', result()), false);
  assert.equal(reload.events.length, 0);
  reload.tracker.recommend(result(2));
  reload.tracker.click('02', 'history', result(2));
  assert.deepEqual(reload.events.map(event => event.params.work_id), ['work_02', 'work_02']);
  assert.equal(reload.events.at(-1).params.first_work_open, 'no');
  assert.equal(events.filter(event => event.name === 'play_start').length, 1);
});

test('ranking clicks are independent of recommended conversions and are source limited', () => {
  const { tracker, events } = fixture();
  assert.equal(tracker.click('01', 'ranking_today'), true);
  assert.equal(tracker.click('01', 'ranking_today'), false);
  assert.equal(tracker.click('01', 'ranking_all_time'), true);
  assert.equal(tracker.click('01', 'unknown'), false);
  assert.equal(tracker.click('secret-work', 'ranking_today'), false);
  tracker.start(quiz());
  tracker.recommend(result());
  assert.equal(tracker.click('01', 'result', result()), true);
  assert.equal(events.at(-1).params.first_work_open, 'yes');
  assert.equal(events.at(-1).params.recommendation_context, 'recommended');
  assert.equal(events[0].params.recommendation_context, 'ranking');
  assert.deepEqual(events.filter(event => event.params.work_id).map(event => event.params.work_id),
    ['work_01', 'work_01', 'work_01', 'work_01']);
  assert.equal(Object.hasOwn(events[0].params, 'play_start_day'), false);
});

test('untracked resumed quizzes are not backfilled into starts or conversion rates', () => {
  const { tracker, events } = fixture();
  const state = quiz();
  state.resultHistory.push(result());
  assert.equal(tracker.sync(state), false);
  assert.equal(tracker.start(state), false);
  assert.equal(tracker.recommend(result(2)), false);
  assert.equal(tracker.click('01', 'history', result()), false);
  assert.equal(events.length, 0);
  tracker.reset();
  assert.equal(tracker.start(quiz()), true);
  assert.equal(tracker.recommend(result()), true);
});

test('the play start day stays in Japan time across a later midnight', () => {
  let time = '2026-10-26T14:59:00Z';
  const { tracker, events } = fixture({ now: () => time });
  tracker.start(quiz());
  time = '2026-10-26T15:01:00Z';
  tracker.recommend(result());
  assert.equal(events.at(-1).params.play_start_day, '2026-10-26');
  assert.equal(japanDay(time), '2026-10-27');
  tracker.reset();
  tracker.start(quiz());
  assert.equal(events.at(-1).params.play_start_day, '2026-10-27');
});

test('disabled analytics, unavailable storage and a failing sender never block play', () => {
  const disabled = fixture({ enabled: false });
  assert.equal(disabled.tracker.start(quiz()), false);
  assert.equal(disabled.tracker.click('01', 'ranking_today'), false);
  assert.equal(disabled.events.length, 0);
  const broken = fixture({ storage: { getItem() { throw Error('blocked'); },
    setItem() { throw Error('blocked'); }, removeItem() { throw Error('blocked'); } },
  emit() { throw Error('offline'); } });
  assert.doesNotThrow(() => {
    broken.tracker.start(quiz());
    broken.tracker.questionShown('q', 'ordinary');
    broken.tracker.questionAction('answer');
    broken.tracker.recommend(result());
    broken.tracker.click('01', 'result', result());
    broken.tracker.reset();
  });
});

test('invalid or mismatched persisted tracking is discarded without touching quiz storage', () => {
  const { tracker, store } = fixture();
  store.setItem('kakuseigar:session:v1', 'keep quiz');
  tracker.start(quiz());
  const raw = JSON.parse(store.getItem(ANALYTICS_STORAGE_KEY));
  raw.recommendations.push({ workId: 'unapproved', index: 1, route: 'ordinary' });
  store.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify(raw));
  const invalid = fixture({ storage: store });
  assert.equal(invalid.tracker.sync(quiz()), false);
  assert.equal(store.getItem('kakuseigar:session:v1'), 'keep quiz');
  assert.equal(store.getItem(ANALYTICS_STORAGE_KEY), null);
  tracker.reset();
  tracker.start(quiz());
  const changed = fixture({ storage: store, datasetVersion: 'public-v2' });
  assert.equal(changed.tracker.sync(quiz()), false);
});

test('unknown fields in persisted summaries never enter transmitted events', () => {
  const { tracker, store } = fixture();
  tracker.start(quiz());
  const raw = JSON.parse(store.getItem(ANALYTICS_STORAGE_KEY));
  raw.counts.raw_answers = 'private';
  store.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify(raw));
  const restored = fixture({ storage: store });
  assert.equal(restored.tracker.sync(quiz()), true);
  restored.tracker.recommend(result());
  assert.equal(Object.hasOwn(restored.events[0].params, 'raw_answers'), false);
});

test('a quiz saved ahead of analytics is adopted without replaying its old result', () => {
  const { tracker, store } = fixture();
  const state = quiz();
  tracker.start(state);
  state.resultHistory.push(result());
  const restored = fixture({ storage: store });
  assert.equal(restored.tracker.sync(state), true);
  assert.equal(restored.tracker.recommend(result()), false);
  assert.equal(restored.events.length, 0);
  restored.tracker.recommend(result(2));
  assert.equal(restored.events.length, 1);
});

function browser(href = 'https://lapis-stein.github.io/Kakuseigar/#/play') {
  const scripts = [];
  return { scripts,
    windowRef: { location: { href }, sessionStorage: storage(), localStorage: storage() },
    documentRef: { referrer: 'https://example.com/private-path?token=secret#detail',
      createElement: () => ({}), head: { append: script => scripts.push(script) } } };
}
const browserOptions = { ...options, measurementId: 'G-LX9EPBLR4G',
  canonicalUrl: 'https://lapis-stein.github.io/Kakuseigar/' };
const commands = env => (env.windowRef.dataLayer || []).map(args => [...args]);

test('localhost, other paths, preview hosts and invalid IDs never load the Google tag', () => {
  for (const href of ['http://127.0.0.1:4173/Kakuseigar/', 'https://lapis-stein.github.io/other/',
    'https://preview.example/Kakuseigar/', 'http://lapis-stein.github.io/Kakuseigar/']) {
    const env = browser(href);
    const analytics = createAnalytics({ ...browserOptions, ...env });
    analytics.start(quiz());
    assert.equal(analytics.available, false);
    assert.equal(env.scripts.length, 0);
    assert.equal(commands(env).length, 0);
  }
  const env = browser();
  createAnalytics({ ...browserOptions, measurementId: 'not-an-id', ...env });
  assert.equal(env.scripts.length, 0);
});

test('the tag loads once, queues milestones, and sanitizes page URLs', () => {
  const env = browser('https://lapis-stein.github.io/Kakuseigar/?private=secret#/result/result-1');
  const analytics = createAnalytics({ ...browserOptions, ...env });
  createAnalytics({ ...browserOptions, ...env });
  assert.equal(env.scripts.length, 1);
  assert.equal(env.scripts[0].async, true);
  analytics.start(quiz());
  analytics.questionAction('answer');
  assert.equal(commands(env).filter(args => args[0] === 'event').length, 0);
  env.scripts[0].onload();
  const sent = commands(env).filter(args => args[0] === 'event');
  assert.deepEqual(sent.map(args => args[1]), ['page_view', 'play_start']);
  assert.equal(sent[0][2].page_location, browserOptions.canonicalUrl);
  assert.equal(sent[0][2].page_referrer, 'https://example.com/');
  assert.doesNotMatch(JSON.stringify(commands(env)), /private=secret|private-path|token=secret|result-1/);
  const config = commands(env).find(args => args[0] === 'config')[2];
  assert.equal(config.send_page_view, false);
  assert.equal(config.allow_google_signals, false);
  assert.equal(config.allow_ad_personalization_signals, false);
});

test('blocked tag queues are bounded, do not retry, and never hold navigation', () => {
  const env = browser();
  const transport = createBrowserTransport({ ...browserOptions, ...env });
  transport.init();
  for (let index = 0; index < 1000; index++) transport.emit('work_opened', { work_id: 'work_01' });
  env.scripts[0].onload();
  assert.equal(commands(env).filter(args => args[0] === 'event').length, 64);
  const failed = browser();
  const failedTransport = createBrowserTransport({ ...browserOptions, ...failed });
  failedTransport.init();
  failed.scripts[0].onerror();
  assert.equal(failedTransport.emit('work_opened', {}), false);
  assert.equal(failedTransport.init(), false);
  assert.equal(failed.scripts.length, 1);
});

test('opt-out is persistent and removes pending events before tag load', () => {
  const env = browser();
  const analytics = createAnalytics({ ...browserOptions, ...env });
  analytics.start(quiz());
  analytics.setEnabled(false);
  env.scripts[0].onload();
  assert.equal(env.windowRef['ga-disable-G-LX9EPBLR4G'], true);
  assert.equal(env.windowRef.localStorage.getItem(ANALYTICS_PREFERENCE_KEY), 'true');
  assert.equal(commands(env).filter(args => args[0] === 'event').length, 0);
  assert.equal(analytics.recommend(result()), false);
  const reload = browser();
  reload.windowRef.localStorage = env.windowRef.localStorage;
  const optedOut = createAnalytics({ ...browserOptions, ...reload });
  assert.equal(optedOut.enabled, false);
  assert.equal(reload.scripts.length, 0);
});

test('preference falls back to the tab and survives reload when browser storage is denied', () => {
  const env = browser();
  Object.defineProperty(env.windowRef, 'localStorage', { get() { throw Error('blocked'); } });
  const analytics = createAnalytics({ ...browserOptions, ...env });
  analytics.setEnabled(false);
  assert.equal(analytics.enabled, false);
  assert.equal(analytics.preferenceScope, 'tab');
  assert.equal(analytics.preferencePersisted, true);
  assert.equal(env.windowRef['ga-disable-G-LX9EPBLR4G'], true);
  const reload = browser();
  reload.windowRef.sessionStorage = env.windowRef.sessionStorage;
  Object.defineProperty(reload.windowRef, 'localStorage', { get() { throw Error('blocked'); } });
  const restored = createAnalytics({ ...browserOptions, ...reload });
  assert.equal(restored.enabled, false);
  assert.equal(restored.preferenceScope, 'tab');
  assert.equal(reload.scripts.length, 0);
});

test('a failed preference write is reported while the current page remains disabled', () => {
  const env = browser();
  const denied = { getItem() { return null; }, setItem() { throw Error('full'); }, removeItem() {} };
  env.windowRef.localStorage = denied;
  env.windowRef.sessionStorage = denied;
  const analytics = createAnalytics({ ...browserOptions, ...env });
  analytics.start(quiz());
  analytics.setEnabled(false);
  assert.equal(analytics.enabled, false);
  assert.equal(analytics.preferenceScope, 'page');
  assert.equal(analytics.preferencePersisted, false);
  assert.equal(env.windowRef['ga-disable-G-LX9EPBLR4G'], true);
  env.scripts[0].onload();
  assert.equal(commands(env).filter(args => args[0] === 'event').length, 0);
  assert.equal(analytics.click('01', 'ranking_today'), false);
});

test('enabling an initially disabled page loads the tag and only tracks a new play', () => {
  const env = browser();
  env.windowRef.localStorage.setItem(ANALYTICS_PREFERENCE_KEY, 'true');
  const analytics = createAnalytics({ ...browserOptions, ...env });
  analytics.sync(quiz());
  assert.equal(env.scripts.length, 0);
  analytics.setEnabled(true);
  assert.equal(analytics.preferenceScope, 'browser');
  assert.equal(env.scripts.length, 1);
  assert.equal(analytics.recommend(result()), false);
  env.scripts[0].onload();
  assert.deepEqual(commands(env).filter(args => args[0] === 'event').map(args => args[1]), ['page_view']);
  analytics.reset();
  analytics.start(quiz());
  assert.equal(commands(env).filter(args => args[0] === 'event').at(-1)[1], 'play_start');
});
