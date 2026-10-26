// Only small, explicitly selected milestones leave the browser. Question details
// and the random local play marker never become Analytics parameters.
export const ANALYTICS_STORAGE_KEY = 'kakuseigar:analytics:v1';
export const ANALYTICS_PREFERENCE_KEY = 'kakuseigar:analytics-disabled';
export const ANALYTICS_VERSION = '1';
const CANONICAL_URL = 'https://lapis-stein.github.io/Kakuseigar/';
const COUNTERS = ['question_count', 'ordinary_question_count', 'favorite_question_count',
  'answer_count', 'skip_count', 'undo_count', 'favorite_answer_count'];
const RANKING_SOURCES = new Set(['ranking_today', 'ranking_recent', 'ranking_all_time']);
const RECOMMENDATION_SOURCES = new Set(['result', 'history']);
const MAX_COUNTER = 999;
const MAX_QUESTIONS = 500;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,100}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, max = MAX_COUNTER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const identifier = (value, fallback = 'none') => typeof value === 'string' && IDENTIFIER.test(value) ? value : fallback;
const counters = () => Object.fromEntries(COUNTERS.map(key => [key, 0]));
const unique = values => new Set(values).size === values.length;
// Keep zero-padded catalog IDs textual in GA4; local state retains the catalog ID.
const eventWorkId = id => `work_${id}`;

export function japanDay(value = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function quizKey(state) {
  if (!object(state) || !Array.isArray(state.tieOrder) || state.tieOrder.length > 100) return null;
  return JSON.stringify([state.datasetVersion, state.initialSetId, state.tieOrder]);
}

/** Pure milestone recorder. emit is injectable; this function never loads a tag. */
export function createTracker({ emit = () => {}, storage = null, now = () => new Date(),
  randomId = () => globalThis.crypto?.randomUUID?.() || `play-${Date.now()}-${Math.random()}`,
  datasetVersion, appVersion, workIds = [], enabled = true } = {}) {
  const approved = new Set(workIds.filter(id => typeof id === 'string' && IDENTIFIER.test(id)));
  const dataset = identifier(datasetVersion, 'unknown');
  const app = identifier(appVersion, 'unknown');
  let active = Boolean(enabled), play = null, candidate = null;
  const rankingClicks = new Set();
  const remove = () => { try { storage?.removeItem(ANALYTICS_STORAGE_KEY); } catch {} };
  const save = () => { try { if (play) storage?.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify(play)); } catch {} };
  const send = (name, params) => {
    if (!active) return false;
    try { return emit(name, params) !== false; } catch { return false; }
  };
  const common = () => ({ analytics_version: ANALYTICS_VERSION, dataset_version: dataset,
    app_version: app, ...(play ? { play_start_day: play.startDay, initial_set: play.initialSet,
      total_works: play.totalWorks } : {}) });
  const record = result => {
    if (!object(result) || !approved.has(result.workId)
        || !integer(result.introducedCount, approved.size) || result.introducedCount < 1
        || !['ordinary', 'favorite'].includes(result.trigger)) return null;
    return { workId: result.workId, index: result.introducedCount, route: result.trigger };
  };
  const validate = value => object(value) && value.version === ANALYTICS_VERSION
    && value.dataset === dataset && typeof value.id === 'string' && value.id.length <= 100
    && typeof value.quizKey === 'string' && value.quizKey.length <= 4096
    && validDay(value.startDay) && identifier(value.initialSet, null) !== null
    && value.totalWorks === approved.size
    && Array.isArray(value.recommendations) && value.recommendations.length <= approved.size
    && value.recommendations.every((item, index) => object(item) && approved.has(item.workId)
      && item.index === index + 1 && ['ordinary', 'favorite'].includes(item.route))
    && unique(value.recommendations.map(item => item.workId))
    && Array.isArray(value.opened) && value.opened.length <= approved.size && unique(value.opened)
    && value.opened.every(id => value.recommendations.some(item => item.workId === id))
    && Array.isArray(value.questions) && value.questions.length <= MAX_QUESTIONS && unique(value.questions)
    && value.questions.every(key => typeof key === 'string' && key.length > 0 && key.length <= 200)
    && object(value.counts) && COUNTERS.every(key => integer(value.counts[key]));
  try {
    const raw = storage?.getItem(ANALYTICS_STORAGE_KEY);
    // Analytics is always disposable. Do not parse unbounded or unrelated state.
    if (typeof raw === 'string' && raw.length <= 150000) {
      const parsed = JSON.parse(raw);
      if (validate(parsed)) candidate = parsed;
      else remove();
    } else if (raw !== null && raw !== undefined) remove();
  } catch { remove(); }

  function reset() { play = null; candidate = null; remove(); }

  return {
    get enabled() { return active; },
    setEnabled(value) { active = Boolean(value); reset(); },
    reset,
    sync(state) {
      if (!active || !state?.started) { reset(); return false; }
      const saved = play || candidate;
      candidate = null;
      if (!saved || !validate(saved) || saved.quizKey !== quizKey(state)
          || state.datasetVersion !== datasetVersion || !Array.isArray(state.resultHistory)) {
        reset(); return false;
      }
      const history = state.resultHistory.map(record);
      if (history.some(item => item === null) || history.length < saved.recommendations.length
          || !unique(history.map(item => item.workId))
          || history.some((item, index) => item.index !== index + 1)
          || saved.recommendations.some((item, index) => JSON.stringify(item) !== JSON.stringify(history[index]))) {
        reset(); return false;
      }
      // A crash between the quiz save and analytics save must not replay old events.
      if (history.length !== saved.recommendations.length) saved.counts = counters();
      saved.recommendations = history;
      play = saved;
      save();
      return true;
    },
    start(state) {
      if (!active || play || !state?.started || state.datasetVersion !== datasetVersion
          || !Array.isArray(state.resultHistory) || state.resultHistory.length !== 0
          || !Array.isArray(state.workIdsSnapshot) || state.workIdsSnapshot.length !== approved.size
          || !unique(state.workIdsSnapshot) || state.workIdsSnapshot.some(id => !approved.has(id))) return false;
      const key = quizKey(state), startDay = japanDay(now());
      if (!key || key.length > 4096 || !startDay) return false;
      let id;
      try { id = String(randomId()).slice(0, 100); } catch { id = 'local-play'; }
      play = { version: ANALYTICS_VERSION, dataset, id, quizKey: key, startDay,
        initialSet: identifier(state.initialSetId), totalWorks: approved.size,
        recommendations: [], opened: [], questions: [], counts: counters() };
      candidate = null;
      save();
      return send('play_start', common());
    },
    questionShown(key, type) {
      if (!active || !play || !['ordinary', 'favorite'].includes(type)
          || typeof key !== 'string' || !key || key.length > 200
          || play.questions.includes(key) || play.questions.length >= MAX_QUESTIONS) return false;
      play.questions.push(key);
      play.counts.question_count = Math.min(MAX_COUNTER, play.counts.question_count + 1);
      const field = type === 'ordinary' ? 'ordinary_question_count' : 'favorite_question_count';
      play.counts[field] = Math.min(MAX_COUNTER, play.counts[field] + 1);
      save(); return true;
    },
    questionAction(kind) {
      if (!active || !play) return false;
      const fields = { answer: 'answer_count', skip: 'skip_count', undo: 'undo_count',
        favorite_answer: 'favorite_answer_count' };
      const field = Object.hasOwn(fields, kind) ? fields[kind] : null;
      if (!field) return false;
      play.counts[field] = Math.min(MAX_COUNTER, play.counts[field] + 1);
      save(); return true;
    },
    recommend(result) {
      if (!active || !play) return false;
      const item = record(result);
      if (!item || result.totalWorks !== play.totalWorks
          || item.index !== play.recommendations.length + 1
          || play.recommendations.some(previous => previous.workId === item.workId)) return false;
      const summary = Object.fromEntries(COUNTERS.map(key => [key, play.counts[key]]));
      play.counts = counters();
      play.recommendations.push(item);
      save();
      return send('work_recommended', { ...common(), work_id: eventWorkId(item.workId),
        recommendation_index: item.index, recommendation_route: item.route,
        first_recommendation: item.index === 1 ? 'yes' : 'no', ...summary });
    },
    click(workId, source, result = null) {
      if (!active || !approved.has(workId)) return false;
      if (RANKING_SOURCES.has(source)) {
        const key = `${source}:${workId}`;
        if (rankingClicks.has(key)) return false;
        rankingClicks.add(key);
        return send('work_opened', { analytics_version: ANALYTICS_VERSION,
          dataset_version: dataset, app_version: app, work_id: eventWorkId(workId),
          recommendation_context: 'ranking', link_source: source });
      }
      if (!RECOMMENDATION_SOURCES.has(source) || !play || play.opened.includes(workId)) return false;
      const item = record(result);
      const shown = play.recommendations.find(previous => previous.workId === workId);
      if (!item || !shown || item.workId !== workId || item.index !== shown.index || item.route !== shown.route) return false;
      const first = play.opened.length === 0;
      play.opened.push(workId);
      save();
      return send('work_opened', { ...common(), work_id: eventWorkId(workId),
        recommendation_context: 'recommended', link_source: source,
        recommendation_index: shown.index, recommendation_route: shown.route,
        first_recommendation: shown.index === 1 ? 'yes' : 'no', first_work_open: first ? 'yes' : 'no' });
    },
  };
}

/** A host-gated transport. Pending events are bounded if the Google tag is blocked. */
export function createBrowserTransport({ measurementId, canonicalUrl,
  windowRef = globalThis.window, documentRef = globalThis.document, enabled = true } = {}) {
  let allowed = false, active = Boolean(enabled), initialized = false, ready = false, failed = false;
  let pending = [];
  let command = null;
  try {
    const canonical = new URL(canonicalUrl), location = new URL(windowRef.location.href);
    allowed = /^G-[A-Z0-9]{4,20}$/.test(measurementId)
      && canonical.href === CANONICAL_URL && location.origin === canonical.origin
      && location.pathname === canonical.pathname && Boolean(documentRef?.createElement);
  } catch {}
  const disableKey = `ga-disable-${measurementId}`;
  const cleanReferrer = () => {
    try {
      const referrer = new URL(documentRef.referrer);
      return ['https:', 'http:'].includes(referrer.protocol) ? referrer.origin + '/' : '';
    } catch { return ''; }
  };
  const page = { page_location: CANONICAL_URL, page_referrer: allowed ? cleanReferrer() : '',
    page_title: '青娥の小説案内' };
  const transport = {
    get available() { return allowed; },
    init() {
      if (!allowed || !active || initialized || failed) return false;
      initialized = true;
      try {
        windowRef[disableKey] = false;
        windowRef.dataLayer = windowRef.dataLayer || [];
        command = function () { windowRef.dataLayer.push(arguments); };
        windowRef.gtag = command;
        command('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
        command('js', new Date());
        command('config', measurementId, { send_page_view: false, allow_google_signals: false,
          allow_ad_personalization_signals: false, ...page });
        const script = documentRef.createElement('script');
        script.id = 'kakuseigar-google-tag';
        script.async = true;
        script.referrerPolicy = 'origin';
        script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
        script.onload = () => {
          ready = true;
          const queued = pending;
          pending = [];
          if (!active) return;
          for (const [name, params] of queued) {
            try { command('event', name, { ...params, send_to: measurementId, ...page }); } catch {}
          }
        };
        script.onerror = () => { failed = true; pending = []; };
        documentRef.head.append(script);
        transport.emit('page_view', {});
        return true;
      } catch { failed = true; pending = []; return false; }
    },
    emit(name, params) {
      if (!allowed || !active || !initialized || failed) return false;
      if (!['page_view', 'play_start', 'work_recommended', 'work_opened'].includes(name)) return false;
      if (!ready) {
        if (pending.length >= 64) return false;
        pending.push([name, params]);
        return true;
      }
      try { command('event', name, { ...params, send_to: measurementId, ...page }); return true; }
      catch { return false; }
    },
    setEnabled(value) {
      active = Boolean(value);
      if (!active) pending = [];
      try { if (allowed) windowRef[disableKey] = !active; } catch {}
    },
  };
  return transport;
}

export function createAnalytics({ measurementId, canonicalUrl, datasetVersion, appVersion, workIds,
  windowRef = globalThis.window, documentRef = globalThis.document } = {}) {
  let sessionStore = null, preferences = null, preferred = true, preferenceScope = 'page';
  try { sessionStore = windowRef.sessionStorage; } catch {}
  try {
    preferences = windowRef.localStorage;
    preferred = preferences.getItem(ANALYTICS_PREFERENCE_KEY) !== 'true';
    preferenceScope = 'browser';
  } catch {}
  // A tab override is only written when the browser-wide preference cannot be
  // saved. It must take precedence over a possibly stale localStorage value.
  try {
    const fallback = sessionStore?.getItem(ANALYTICS_PREFERENCE_KEY);
    if (fallback === 'true' || fallback === 'false') {
      preferred = fallback !== 'true';
      preferenceScope = 'tab';
    }
  } catch {}
  const registryKey = `__kakuseigarAnalytics_${measurementId}`;
  let transport;
  try { transport = windowRef[registryKey]; } catch {}
  if (!transport) {
    transport = createBrowserTransport({ measurementId, canonicalUrl, windowRef, documentRef, enabled: preferred });
    try { if (transport.available) windowRef[registryKey] = transport; } catch {}
  }
  transport.setEnabled(preferred);
  transport.init();
  const tracker = createTracker({ storage: sessionStore, emit: transport.emit,
    datasetVersion, appVersion, workIds, enabled: preferred && transport.available });
  return {
    sync: tracker.sync, start: tracker.start, questionShown: tracker.questionShown,
    questionAction: tracker.questionAction, recommend: tracker.recommend,
    click: tracker.click, reset: tracker.reset,
    get enabled() { return preferred; },
    get available() { return transport.available; },
    get preferenceScope() { return preferenceScope; },
    get preferencePersisted() { return preferenceScope !== 'page'; },
    setEnabled(value) {
      preferred = Boolean(value);
      const stored = preferred ? 'false' : 'true';
      preferenceScope = 'page';
      try {
        preferences?.setItem(ANALYTICS_PREFERENCE_KEY, stored);
        if (preferences?.getItem(ANALYTICS_PREFERENCE_KEY) === stored) preferenceScope = 'browser';
      } catch {}
      if (preferenceScope === 'browser') {
        try { sessionStore?.removeItem(ANALYTICS_PREFERENCE_KEY); } catch {}
      } else {
        try {
          sessionStore?.setItem(ANALYTICS_PREFERENCE_KEY, stored);
          if (sessionStore?.getItem(ANALYTICS_PREFERENCE_KEY) === stored) preferenceScope = 'tab';
        } catch {}
      }
      transport.setEnabled(preferred);
      tracker.setEnabled(preferred && transport.available);
      if (preferred) transport.init();
      return preferred;
    },
  };
}
