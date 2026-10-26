const MAX_BYTES = 32 * 1024;
const MAX_ROWS = 256;
const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET = 9 * 60 * 60 * 1000;
const TIME_ZONE = 'Asia/Tokyo';
const countFormat = new Intl.NumberFormat('ja-JP');
const updateFormat = new Intl.DateTimeFormat('ja-JP', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function jstCalendar(value = new Date()) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) throw new TypeError('Invalid date');
  const day = new Date(time + JST_OFFSET).toISOString().slice(0, 10);
  return { day, month: day.slice(0, 7) };
}

function isDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function isCount(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only normalized, public counters leave this boundary. Missing counts are not zeroes. */
export function validateSnapshot(input, workIds) {
  const allowed = new Set(workIds);
  const fail = () => { throw new TypeError('Invalid public statistics'); };
  if (!object(input) || input.schema_version !== 2 || input.time_zone !== TIME_ZONE
      || !['ready', 'unconfigured'].includes(input.status)
      || !object(input.visits) || !object(input.first_recommendations) || !object(input.work_opens)
      || !isCount(input.visits.today) || !isCount(input.visits.all_time)) fail();
  const groups = {};
  for (const [group, periods] of [['first_recommendations', ['recent', 'month', 'all_time']], ['work_opens', ['recent', 'all_time']]]) {
    const rows = groups[group] = {};
    for (const period of periods) {
      const raw = input[group][period];
      if (!Array.isArray(raw) || raw.length > MAX_ROWS) fail();
      const seen = new Set();
      rows[period] = [];
      for (const row of raw) {
        if (!object(row) || typeof row.work_id !== 'string' || row.work_id.length > 100
            || seen.has(row.work_id) || row.count === null || !isCount(row.count)) fail();
        seen.add(row.work_id);
        if (allowed.has(row.work_id)) rows[period].push({ work_id: row.work_id, count: row.count });
      }
    }
  }
  if (input.status === 'unconfigured') {
    if (input.generated_at !== null || input.collection_started_on !== null || input.day !== null
        || input.month !== null || input.recent_started_on !== null || input.visits.today !== null || input.visits.all_time !== null
        || [input.first_recommendations, input.work_opens].some(group => Object.values(group).some(value => !Array.isArray(value) || value.length))) fail();
    return {
      schema_version: 2, status: 'unconfigured', generated_at: null, time_zone: TIME_ZONE,
      collection_started_on: null, day: null, month: null, recent_started_on: null,
      visits: { today: null, all_time: null }, ...groups,
    };
  }
  if (typeof input.generated_at !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.generated_at)
      || !Number.isFinite(Date.parse(input.generated_at)) || !isDay(input.generated_at.slice(0, 10)) || !isDay(input.collection_started_on)
      || !isDay(input.day) || !isDay(input.recent_started_on) || input.month !== input.day.slice(0, 7)
      || input.day < input.collection_started_on || jstCalendar(input.generated_at).day < input.day) fail();
  const sevenDaysStart = new Date(Date.parse(`${input.day}T00:00:00Z`) - 6 * DAY_MS).toISOString().slice(0, 10);
  if (input.recent_started_on !== (sevenDaysStart < input.collection_started_on ? input.collection_started_on : sevenDaysStart)) fail();
  return {
    schema_version: 2, status: 'ready', generated_at: input.generated_at, time_zone: TIME_ZONE,
    collection_started_on: input.collection_started_on, day: input.day, month: input.month,
    recent_started_on: input.recent_started_on,
    visits: { today: input.visits.today, all_time: input.visits.all_time },
    ...groups,
  };
}

export function snapshotState(snapshot, at = new Date()) {
  if (!snapshot || snapshot.status !== 'ready') return { ready: false, currentDay: false, currentMonth: false, stale: false };
  const calendar = jstCalendar(at);
  const age = new Date(at).getTime() - Date.parse(snapshot.generated_at);
  const ready = age >= -5 * 60 * 1000;
  return {
    ready,
    currentDay: ready && snapshot.day === calendar.day,
    currentMonth: ready && snapshot.month === calendar.month,
    stale: ready && age > DAY_MS,
  };
}

/** Competition ranks: all works tied at rank three are included. */
export function rankWorks(rows, works, limit = 3) {
  const workMap = new Map(works.map((work, index) => [work.id, { work, index }]));
  const sorted = rows.filter(row => row.count > 0 && workMap.has(row.work_id))
    .map(row => ({ ...row, ...workMap.get(row.work_id) }))
    .sort((a, b) => b.count - a.count || a.index - b.index);
  let previous = null, rank = 0;
  return sorted.map((row, index) => {
    if (row.count !== previous) rank = index + 1;
    previous = row.count;
    return { rank, work_id: row.work_id, count: row.count, work: row.work };
  }).filter(row => row.rank <= limit);
}

async function readBounded(response) {
  const length = response.headers?.get?.('content-length');
  if (length !== null && length !== undefined && Number(length) > MAX_BYTES) throw new Error('Statistics are too large');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('Statistics are too large');
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        throw new Error('Statistics are too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

export function createPublicStats({ works, fetcher = globalThis.fetch, now = () => new Date(),
  document = globalThis.document, workArtByWork = {}, onWorkSelect = () => {} } = {}) {
  const workMap = new Map(works.map(work => [work.id, work]));
  const slots = new Set();
  let snapshot = null, state = 'loading', request = null, calendarTimer = null;
  let selectedMetric = 'recommendations', rankingId = 0;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function placeholder() {
    if (state === 'error') return 'ただいま集計を表示できません。';
    if (state === 'loading') return '集計を読み込んでいます。';
    return '集計を準備しています。';
  }

  function meta(status) {
    const line = el('p', 'stats-meta', `${updateFormat.format(new Date(snapshot.generated_at))} 更新（日本時間）`);
    if (status.stale) line.append(el('span', 'stats-stale', '更新が遅れています。'));
    return line;
  }

  function drawCounter(node, status) {
    node.replaceChildren(el('span', 'visitor-counter-title', 'この書斎への訪問'));
    if (!status.ready) { node.append(el('span', 'stats-empty', placeholder())); return; }
    const values = el('div', 'visitor-counter-values');
    values.append(
      el('span', '', `本日 ${status.currentDay && snapshot.visits.today !== null ? countFormat.format(snapshot.visits.today) + '回' : '集計待ち'}`),
      el('span', '', `累計 ${snapshot.visits.all_time !== null ? countFormat.format(snapshot.visits.all_time) + '回' : '集計待ち'}`),
    );
    node.append(values, meta(status), el('p', 'stats-meta', `${snapshot.collection_started_on} からの訪問回数です。`));
  }

  function drawRanking(metric, period, status) {
    const section = el('section', 'stats-ranking');
    const heading = period === 'recent' ? '最近のお薦め' : '今まで';
    section.append(el('h2', 'stats-heading', heading));
    if (!status.ready) { section.append(el('p', 'stats-empty', placeholder())); return section; }
    const rows = (metric === 'opens' ? snapshot.work_opens : snapshot.first_recommendations)[period];
    if (!rows.length) {
      section.append(el('p', 'stats-empty', '集計を準備しています。'));
      return section;
    }
    const ranks = rankWorks(rows, works);
    if (!ranks.length) {
      section.append(el('p', 'stats-empty', metric === 'opens'
        ? 'この期間のpixivへの移動は、まだ記録されていません。'
        : 'この期間の初回推薦は、まだ記録されていません。'));
      return section;
    }
    const list = el('ol', 'stats-ranking-list');
    list.tabIndex = 0;
    list.setAttribute('aria-label', `${heading}のランキング。横にスクロールできます`);
    for (const row of ranks) {
      const item = el('li', 'stats-ranking-item');
      item.value = row.rank;
      const trigger = el('button', 'stats-work-button');
      trigger.type = 'button';
      trigger.setAttribute('data-stats-focus', `${metric}:${period}:${row.work_id}`);
      trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.setAttribute('aria-label', `${row.rank}位 『${row.work.title}』の紹介を開く、${countFormat.format(row.count)}回`);
      const art = workArtByWork?.[row.work_id];
      // Images come only from the approved local illustration catalog, never from a report.
      if (typeof art?.preview === 'string' && /^assets\/works\/[0-9]+-preview\.webp$/.test(art.preview)) {
        const image = el('img', 'stats-work-image');
        image.src = new URL(`../${art.preview}`, import.meta.url).href;
        image.alt = '';
        image.width = 160;
        image.height = 240;
        image.loading = 'lazy';
        image.decoding = 'async';
        image.addEventListener('error', () => trigger.replaceChildren(el('span', 'stats-work-placeholder', row.work.title)));
        trigger.append(image);
      } else {
        trigger.append(el('span', 'stats-work-placeholder', row.work.title));
      }
      trigger.addEventListener('click', () => onWorkSelect(row.work_id, { metric, period, trigger }));
      item.append(el('span', 'stats-rank', `${row.rank}位`), trigger,
        el('span', 'stats-ranking-count', `${countFormat.format(row.count)}回`));
      list.append(item);
    }
    section.append(list);
    return section;
  }

  function drawRankings(node, status, entry) {
    const choices = [['recommendations', '青娥のお薦め'], ['opens', 'みんなが選んだ']];
    const tabs = el('div', 'stats-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'ランキングの種類');
    const panelId = `stats-panel-${entry.rankingId}`;
    function activate(metric) {
      selectedMetric = metric;
      drawRankings(node, status, entry);
      [...node.querySelectorAll('button')].find(button => button.getAttribute('data-stats-focus') === `tab:${metric}`)?.focus();
    }
    choices.forEach(([metric, label], index) => {
      const tab = el('button', 'stats-tab', label);
      tab.type = 'button';
      tab.id = `stats-tab-${entry.rankingId}-${metric}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(selectedMetric === metric));
      tab.setAttribute('aria-controls', panelId);
      tab.setAttribute('data-stats-focus', `tab:${metric}`);
      tab.tabIndex = selectedMetric === metric ? 0 : -1;
      tab.addEventListener('click', () => activate(metric));
      tab.addEventListener('keydown', event => {
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % choices.length;
        else if (event.key === 'ArrowLeft') next = (index + choices.length - 1) % choices.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = choices.length - 1;
        else return;
        event.preventDefault();
        activate(choices[next][0]);
      });
      tabs.append(tab);
    });
    const panel = el('div', 'stats-tab-panel');
    panel.id = panelId;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `stats-tab-${entry.rankingId}-${selectedMetric}`);
    const summary = el('div', 'stats-summary');
    summary.append(el('p', 'stats-intro', selectedMetric === 'opens'
      ? 'pixivへのリンクが押された回数です。'
      : '最初の一作としてご紹介した回数です。'));
    panel.append(summary);
    node.replaceChildren(tabs, panel);
    const periods = el('div', 'stats-periods');
    periods.append(drawRanking(selectedMetric, 'recent', status), drawRanking(selectedMetric, 'all_time', status));
    panel.append(periods);
    if (status.ready) {
      const statusLine = el('div', 'stats-status');
      statusLine.append(meta(status));
      panel.append(statusLine);
    }
  }

  function drawFootprint(node, workId, status) {
    if (!status.ready) { node.textContent = placeholder(); return; }
    if (!status.currentMonth) { node.textContent = '今月分の足跡は、集計を待っています。'; return; }
    const row = snapshot.first_recommendations.month.find(item => item.work_id === workId);
    if (!row) { node.textContent = 'このお話の足跡は、集計を待っています。'; return; }
    node.replaceChildren(el('span', '', `今月、最初の一作として${countFormat.format(row.count)}回ご紹介しました。`),
      el('span', 'stats-footprint-date', `${updateFormat.format(new Date(snapshot.generated_at))} 時点${status.stale ? '・更新が遅れています' : ''}`));
  }

  function draw(slot) {
    const node = slot.ref.deref();
    if (!node) { slots.delete(slot); return; }
    const status = snapshotState(snapshot, now());
    if (snapshot?.status === 'ready' && !status.ready) {
      state = 'error';
    }
    const signature = `${state}:${status.ready}:${status.currentDay}:${status.currentMonth}:${status.stale}`;
    if (slot.signature === signature) return;
    slot.signature = signature;
    const focused = document.activeElement;
    const focusKey = focused && node.contains?.(focused) ? focused.getAttribute?.('data-stats-focus') : null;
    if (slot.kind === 'counter') drawCounter(node, status);
    else if (slot.kind === 'rankings') drawRankings(node, status, slot);
    else drawFootprint(node, slot.workId, status);
    if (focusKey) {
      [...node.querySelectorAll('button')].find(button => button.getAttribute('data-stats-focus') === focusKey)?.focus({ preventScroll: true });
    }
  }

  function refresh() {
    for (const slot of slots) draw(slot);
    if (calendarTimer !== null) clearTimeout(calendarTimer);
    // This timer only updates date labels locally at midnight/expiry; it never fetches data.
    if (snapshot?.status === 'ready' && document) {
      const time = new Date(now()).getTime();
      const midnight = DAY_MS - ((time + JST_OFFSET) % DAY_MS);
      const expiry = Date.parse(snapshot.generated_at) + DAY_MS - time;
      const delay = Math.min(midnight, expiry > 0 ? expiry : DAY_MS) + 50;
      calendarTimer = setTimeout(refresh, delay);
      calendarTimer.unref?.();
    }
  }

  function slot(kind, workId) {
    const node = el(kind === 'footprint' ? 'p' : 'div', kind === 'counter' ? 'visitor-counter' : kind === 'rankings' ? 'public-rankings' : 'stats-footprint');
    if (kind === 'counter') node.setAttribute('aria-label', '来訪者カウンター');
    for (const existing of slots) if (!existing.ref.deref()) slots.delete(existing);
    const entry = { kind, workId, ref: new WeakRef(node), rankingId: ++rankingId };
    slots.add(entry);
    draw(entry);
    return node;
  }

  function load() {
    if (request) return request;
    request = (async () => {
      const controller = new AbortController();
      let timer;
      try {
        const read = async () => {
          const response = await fetcher(new URL('../data/public-stats.json', import.meta.url), {
            signal: controller.signal, credentials: 'omit', cache: 'default',
          });
          if (!response.ok) throw new Error('Statistics unavailable');
          return validateSnapshot(JSON.parse(await readBounded(response)), workMap.keys());
        };
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('Statistics timed out')); }, 7000);
        });
        snapshot = await Promise.race([read(), timeout]);
        state = 'loaded';
      } catch { snapshot = null; state = 'error'; }
      finally { clearTimeout(timer); refresh(); }
      return snapshot;
    })();
    return request;
  }

  document?.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
  return {
    load,
    counter: () => slot('counter'),
    rankings: () => slot('rankings'),
    footprint: workId => workMap.has(workId) ? slot('footprint', workId) : null,
  };
}
