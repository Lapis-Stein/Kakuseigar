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
    schema_version: 1, status: 'ready', generated_at: '2026-10-26T02:00:00Z', time_zone: 'Asia/Tokyo',
    collection_started_on: '2026-10-25', day: '2026-10-26', month: '2026-10',
    visits: { today: 12, all_time: 45 },
    first_recommendations: {
      today: ids.map((work_id, index) => ({ work_id, count: index === 0 ? 3 : 0 })),
      month: ids.map((work_id, index) => ({ work_id, count: index === 0 ? 8 : 0 })),
      all_time: ids.map((work_id, index) => ({ work_id, count: index === 0 ? 10 : 0 })),
    },
  };
}
const unconfigured = {
  schema_version: 1, status: 'unconfigured', generated_at: null, time_zone: 'Asia/Tokyo',
  collection_started_on: null, day: null, month: null, visits: { today: null, all_time: null },
  first_recommendations: { today: [], month: [], all_time: [] },
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
  input.first_recommendations.today.push({ work_id: 'unknown', count: 900 });
  input.first_recommendations.today[0].title = '<script>ignored</script>';
  const normalized = validateSnapshot(input, ids);
  assert.deepEqual(normalized, ready());
  assert.deepEqual(validateSnapshot(unconfigured, ids), unconfigured);
});

test('malformed counts, duplicates and invalid calendar fields cannot become public counts', () => {
  for (const change of [
    value => { value.visits.today = -1; },
    value => { value.visits.today = '12'; },
    value => { value.first_recommendations.month[0].count = 1.2; },
    value => { value.first_recommendations.today.push({ work_id: ids[0], count: 9 }); },
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
  const clicked = [];
  const doc = makeDocument();
  const stats = createPublicStats({ works, document: doc, now: () => at, onWorkClick: (...args) => clicked.push(args),
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
  assert.match(ranking.textContent, /本日のお薦めランキング/);
  const links = ranking.querySelectorAll('a');
  assert.equal(links.length, 2);
  links[0].listeners.get('click')();
  links[1].listeners.get('click')();
  assert.deepEqual(clicked, [[ids[0], 'today'], [ids[0], 'all_time']]);
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

test('rollover updates existing labels locally without another request', async () => {
  let time = new Date('2026-10-31T14:59:00Z'), calls = 0;
  const input = ready();
  input.day = '2026-10-31';
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
  assert.match(ranking.textContent, /本日分の集計を待っています/);
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
