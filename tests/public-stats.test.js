import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicStats, jstCalendar, rankWorks, snapshotState, validateSnapshot } from '../src/public-stats.js';

const works = Array.from({ length: 5 }, (_, index) => ({
  id: `work-${index + 1}`, title: `公開作品 ${index + 1}`, pixiv_url: `https://www.pixiv.net/novel/show.php?id=${index + 1}`,
}));
const ids = works.map(work => work.id);
const at = new Date('2026-10-26T03:00:00Z');
function ready() {
  return {
    schema_version: 2, status: 'ready', generated_at: '2026-10-26T02:00:00Z', time_zone: 'Asia/Tokyo',
    collection_started_on: '2026-10-01', day: '2026-10-26', month: '2026-10', recent_started_on: '2026-10-20',
    visits: { today: 12, all_time: 45 },
    first_recommendations: {
      recent: ids.map((work_id, index) => ({ work_id, count: index === 0 ? 3 : 0 })),
      month: ids.map((work_id, index) => ({ work_id, count: index === 0 ? 8 : 0 })),
      all_time: ids.map((work_id, index) => ({ work_id, count: index === 0 ? 10 : 0 })),
    },
    work_opens: {
      recent: ids.map((work_id, index) => ({ work_id, count: index === 1 ? 2 : 0 })),
      all_time: ids.map((work_id, index) => ({ work_id, count: index === 1 ? 6 : 0 })),
    },
  };
}
const unconfigured = {
  schema_version: 2, status: 'unconfigured', generated_at: null, time_zone: 'Asia/Tokyo',
  collection_started_on: null, day: null, month: null, recent_started_on: null, visits: { today: null, all_time: null },
  first_recommendations: { recent: [], month: [], all_time: [] }, work_opens: { recent: [], all_time: [] },
};

// A small DOM fixture keeps the tests independent of a browser package while asserting displayed labels.
function makeDocument() {
  const doc = { visibilityState: 'visible', activeElement: null, listeners: new Map(),
    addEventListener(name, fn) { this.listeners.set(name, fn); },
  };
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map(); this.listeners = new Map(); this.text = ''; }
    get textContent() { return this.text + this.children.map(child => child.textContent ?? String(child)).join(''); }
    set textContent(value) { this.text = String(value); this.children = []; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.text = ''; this.children = children; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    contains(node) { return this === node || this.children.some(child => child.contains?.(node)); }
    querySelectorAll(tag) { return this.children.flatMap(child => [ ...(child.tagName === tag.toUpperCase() ? [child] : []), ...(child.querySelectorAll?.(tag) ?? []) ]); }
    focus() { doc.activeElement = this; }
  }
  doc.createElement = tag => new Element(tag);
  return doc;
}

test('Japan day and calendar month turn over at 15:00 UTC', () => {
  assert.deepEqual(jstCalendar('2026-10-31T14:59:59Z'), { day: '2026-10-31', month: '2026-10' });
  assert.deepEqual(jstCalendar('2026-10-31T15:00:00Z'), { day: '2026-11-01', month: '2026-11' });
  assert.throws(() => jstCalendar('invalid'));
});

test('snapshot normalization drops unknown works and unexpected payload fields', () => {
  const input = ready();
  input.private_notes = 'must not be returned';
  input.first_recommendations.recent.push({ work_id: 'unknown', count: 900 });
  input.first_recommendations.recent[0].title = '<script>ignored</script>';
  input.work_opens.recent.push({ work_id: 'unknown', count: 100 });
  const normalized = validateSnapshot(input, ids);
  assert.deepEqual(normalized, ready());
  assert.deepEqual(validateSnapshot(unconfigured, ids), unconfigured);
});

test('malformed counts, duplicates and invalid calendar fields cannot become public counts', () => {
  for (const change of [
    value => { value.visits.today = -1; },
    value => { value.visits.today = '12'; },
    value => { value.first_recommendations.month[0].count = 1.2; },
    value => { value.first_recommendations.recent.push({ work_id: ids[0], count: 9 }); },
    value => { value.work_opens.recent.push({ work_id: ids[0], count: 9 }); },
    value => { value.work_opens.all_time[0].count = null; },
    value => { value.work_opens = null; },
    value => { value.recent_started_on = '2026-10-19'; },
    value => { value.schema_version = 1; },
    value => { value.day = '2026-02-30'; value.month = '2026-02'; },
    value => { value.generated_at = '2026-02-30T02:00:00Z'; },
    value => { value.month = '2026-11'; },
    value => { value.time_zone = 'UTC'; },
    value => { value.collection_started_on = '2026-10-27'; },
  ]) {
    const input = ready(); change(input);
    assert.throws(() => validateSnapshot(input, ids));
  }
  assert.throws(() => validateSnapshot({ ...unconfigured, visits: { today: 0, all_time: 0 } }, ids));
});

test('the recent window spans months and starts no earlier than collection', () => {
  const input = ready();
  input.day = '2026-11-02'; input.month = '2026-11';
  input.generated_at = '2026-11-02T02:00:00Z';
  input.recent_started_on = '2026-10-27';
  assert.equal(validateSnapshot(input, ids).recent_started_on, '2026-10-27');
  input.collection_started_on = '2026-10-30'; input.recent_started_on = '2026-10-30';
  assert.equal(validateSnapshot(input, ids).recent_started_on, '2026-10-30');
  input.recent_started_on = '2026-10-27';
  assert.throws(() => validateSnapshot(input, ids));
});

test('ties retain competition ranks and do not invent a lower place', () => {
  const rows = [12, 10, 8, 8, 0].map((count, index) => ({ work_id: ids[index], count }));
  assert.deepEqual(rankWorks(rows, works).map(({ rank, count }) => ({ rank, count })), [
    { rank: 1, count: 12 }, { rank: 2, count: 10 }, { rank: 3, count: 8 }, { rank: 3, count: 8 },
  ]);
  assert.deepEqual(rankWorks(ids.map(work_id => ({ work_id, count: 1 })), works).map(row => row.rank), [1, 1, 1, 1, 1]);
  assert.deepEqual(rankWorks([{ work_id: 'unknown', count: 999 }, { work_id: ids[0], count: 0 }], works), []);
});

test('a stale or wrong-period snapshot does not represent current-day or current-month counts', () => {
  const input = ready();
  assert.deepEqual(snapshotState(input, at), { ready: true, currentDay: true, currentMonth: true, stale: false });
  assert.deepEqual(snapshotState(input, '2026-11-01T00:00:00Z'), { ready: true, currentDay: false, currentMonth: false, stale: true });
  assert.equal(snapshotState(input, '2026-10-26T01:00:00Z').ready, false);
});

test('one successful fetch populates all views and is reused across new cards', async () => {
  let calls = 0;
  const selected = [];
  const doc = makeDocument();
  const stats = createPublicStats({ works, document: doc, now: () => at, onWorkSelect: (...args) => selected.push(args),
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url.pathname.endsWith('/data/public-stats.json'), true);
      assert.equal(options.credentials, 'omit');
      return new Response(JSON.stringify(ready()));
    },
  });
  const counter = stats.counter(), ranking = stats.rankings(), footprint = stats.footprint(ids[0]);
  assert.match(counter.textContent, /読み込んでいます/);
  const first = stats.load();
  assert.equal(stats.load(), first);
  await first;
  assert.match(counter.textContent, /本日 12回/);
  assert.match(counter.textContent, /累計 45回/);
  assert.match(footprint.textContent, /今月、最初の一作として8回/);
  assert.match(ranking.textContent, /最近のお薦め/);
  assert.match(ranking.textContent, /青娥のお薦め/);
  assert.doesNotMatch(ranking.textContent, /2026-10-20|からの累計|絵を押すと紹介/);
  assert.equal(ranking.querySelectorAll('a').length, 0, 'the gallery opens details rather than navigating to pixiv');
  const cards = ranking.querySelectorAll('button').filter(button => button.className === 'stats-work-button');
  assert.equal(cards.length, 2);
  cards[0].listeners.get('click')();
  cards[1].listeners.get('click')();
  assert.deepEqual(selected.map(([id, { metric, period }]) => [id, metric, period]), [
    [ids[0], 'recommendations', 'recent'], [ids[0], 'recommendations', 'all_time'],
  ]);
  assert.equal(selected[0][1].trigger, cards[0]);
  assert.deepEqual(ranking.querySelectorAll('span').filter(node => node.className === 'stats-ranking-count').map(node => node.textContent), ['3回', '10回']);
  assert.match(stats.footprint(ids[1]).textContent, /0回/);
  assert.equal(stats.footprint('unknown'), null);
  await stats.load();
  assert.equal(calls, 1);
});

test('missing period rows and unavailable visits stay unknown, while explicit zeroes remain zeroes', async () => {
  const input = ready();
  input.visits.today = null;
  input.first_recommendations.month = [];
  const stats = createPublicStats({ works, document: makeDocument(), now: () => at,
    fetcher: async () => new Response(JSON.stringify(input)),
  });
  await stats.load();
  assert.match(stats.counter().textContent, /本日 集計待ち/);
  assert.match(stats.footprint(ids[0]).textContent, /集計を待っています/);
  assert.doesNotMatch(stats.footprint(ids[0]).textContent, /0回/);
});

test('ranking tabs switch counts with keyboard focus, keep the selection and do not fetch or select a work', async () => {
  let requests = 0, selections = 0, prevented = 0;
  const doc = makeDocument();
  const stats = createPublicStats({ works, document: doc, now: () => at,
    onWorkSelect: () => { selections++; },
    fetcher: async () => { requests++; return new Response(JSON.stringify(ready())); },
  });
  await stats.load();
  const ranking = stats.rankings();
  const tabs = () => ranking.querySelectorAll('button').filter(node => node.getAttribute('role') === 'tab');
  assert.deepEqual(tabs().map(tab => [tab.getAttribute('aria-selected'), tab.tabIndex]), [['true', 0], ['false', -1]]);
  tabs()[0].listeners.get('keydown')({ key: 'ArrowRight', preventDefault() { prevented++; } });
  assert.match(ranking.textContent, /pixivへのリンクが押された回数/);
  assert.deepEqual(ranking.querySelectorAll('span').filter(node => node.className === 'stats-ranking-count').map(node => node.textContent), ['2回', '6回']);
  assert.equal(doc.activeElement, tabs()[1]);
  const panel = ranking.querySelectorAll('div').find(node => node.getAttribute('role') === 'tabpanel');
  assert.equal(panel.getAttribute('aria-labelledby'), tabs()[1].id);
  assert.equal(tabs()[1].getAttribute('aria-controls'), panel.id);
  assert.equal(stats.rankings().querySelectorAll('button').find(node => node.textContent === 'みんなが選んだ').getAttribute('aria-selected'), 'true');
  tabs()[1].listeners.get('keydown')({ key: 'Home', preventDefault() { prevented++; } });
  assert.equal(doc.activeElement, tabs()[0]);
  tabs()[0].listeners.get('keydown')({ key: 'End', preventDefault() { prevented++; } });
  assert.equal(doc.activeElement, tabs()[1]);
  tabs()[1].listeners.get('keydown')({ key: 'ArrowLeft', preventDefault() { prevented++; } });
  assert.equal(doc.activeElement, tabs()[0]);
  assert.equal(prevented, 4);
  assert.equal(requests, 1);
  assert.equal(selections, 0);
});

test('all tied gallery cards remain selectable, with only local previews and readable image fallbacks', async () => {
  const input = ready();
  input.first_recommendations.recent = [12, 10, 8, 8, 0].map((count, index) => ({ work_id: ids[index], count }));
  const doc = makeDocument();
  const selected = [];
  const stats = createPublicStats({ works, document: doc, now: () => at,
    workArtByWork: {
      [ids[0]]: { preview: 'assets/works/01-preview.webp' },
      [ids[1]]: { preview: 'https://example.invalid/private-preview.webp' },
      [ids[2]]: { preview: 'assets/works/../secret-preview.webp' },
      [ids[3]]: { preview: 'assets/works/04-preview.webp' },
    },
    onWorkSelect: (...args) => selected.push(args),
    fetcher: async () => new Response(JSON.stringify(input)),
  });
  await stats.load();
  const ranking = stats.rankings();
  const recent = ranking.querySelectorAll('section')[0];
  const rail = recent.querySelectorAll('ol')[0];
  const cards = recent.querySelectorAll('button');
  assert.equal(rail.tabIndex, 0);
  assert.equal(cards.length, 4);
  assert.deepEqual(recent.querySelectorAll('li').map(item => item.value), [1, 2, 3, 3]);
  assert.equal(recent.querySelectorAll('img').length, 2);
  assert.match(cards[1].textContent, /公開作品 2/);
  assert.match(cards[2].textContent, /公開作品 3/);
  const image = cards[0].querySelectorAll('img')[0];
  assert.match(image.src, /\/assets\/works\/01-preview\.webp$/);
  assert.equal(image.loading, 'lazy');
  image.listeners.get('error')();
  assert.match(cards[0].textContent, /公開作品 1/);
  cards[3].listeners.get('click')();
  assert.equal(selected[0][0], ids[3]);
  assert.deepEqual({ ...selected[0][1], trigger: undefined }, { metric: 'recommendations', period: 'recent', trigger: undefined });
});

test('rollover updates existing labels locally without another request', async () => {
  let time = new Date('2026-10-31T14:59:00Z'), calls = 0;
  const input = ready();
  input.day = '2026-10-31';
  input.recent_started_on = '2026-10-25';
  input.generated_at = '2026-10-31T14:00:00Z';
  const doc = makeDocument();
  const stats = createPublicStats({ works, document: doc, now: () => time,
    fetcher: async () => { calls++; return new Response(JSON.stringify(input)); },
  });
  const counter = stats.counter(), ranking = stats.rankings(), footprint = stats.footprint(ids[0]);
  await stats.load();
  time = new Date('2026-10-31T15:01:00Z');
  doc.listeners.get('visibilitychange')();
  assert.match(counter.textContent, /本日 集計待ち/);
  assert.match(ranking.textContent, /2026\/10\/31 23:00 更新/);
  assert.match(ranking.textContent, /3回/);
  assert.match(footprint.textContent, /今月分の足跡は、集計を待っています/);
  assert.equal(calls, 1);
});

test('unconfigured and failed snapshots never display fabricated zero statistics or retry', async () => {
  for (const [fetcher, label] of [
    [async () => new Response(JSON.stringify(unconfigured)), /集計を準備しています/],
    [async () => { throw new Error('offline'); }, /ただいま集計を表示できません/],
    [async () => new Response('{invalid'), /ただいま集計を表示できません/],
    [async () => new Response('', { status: 404 }), /ただいま集計を表示できません/],
  ]) {
    let calls = 0;
    const stats = createPublicStats({ works, document: makeDocument(), now: () => at,
      fetcher: (...args) => { calls++; return fetcher(...args); },
    });
    const counter = stats.counter();
    await stats.load(); await stats.load();
    assert.equal(calls, 1);
    assert.match(counter.textContent, label);
    assert.doesNotMatch(counter.textContent, /0回/);
  }
});

test('response size is bounded with and without Content-Length', async () => {
  for (const headers of [{}, { 'Content-Length': String(40 * 1024) }]) {
    const stats = createPublicStats({ works, document: makeDocument(), now: () => at,
      fetcher: async () => new Response('あ'.repeat(12000), { headers }),
    });
    assert.equal(await stats.load(), null);
    assert.match(stats.counter().textContent, /表示できません/);
  }
});
