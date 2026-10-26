// Browser regression checks with a MOCK Google tag. All HTTP requests are
// intercepted: this script must never send test activity to the live property.
// Requires Playwright (or NODE_PATH) and Edge, as scripts/browser-check.mjs does.
// This verifies the app's event contract, NOT Google's real batching, automatic
// traffic, or actual tag download size. Measure those separately before launch.
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { jstCalendar } from '../src/public-stats.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const screenshots = path.join(root, 'test-results', 'analytics-mock');
await mkdir(screenshots, { recursive: true });
const base = 'https://lapis-stein.github.io/Kakuseigar/';
const origin = new URL(base).origin;
const runtime = JSON.parse(await readFile(path.join(root, 'data/runtime.json'), 'utf8'));
const instant = new Date();
const calendar = jstCalendar(instant);
const rows = runtime.works.map((work, index) => ({ work_id: work.id, count: runtime.works.length - index }));
const snapshot = {
  schema_version: 1, status: 'ready', generated_at: instant.toISOString(), time_zone: 'Asia/Tokyo',
  collection_started_on: calendar.day, day: calendar.day, month: calendar.month,
  visits: { today: 7, all_time: 71 },
  first_recommendations: { today: rows, month: rows, all_time: rows },
};
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' };
const mockedTag = `
  window.__analyticsMockEvents = [];
  const dataLayer = window.dataLayer;
  const originalPush = dataLayer.push;
  function record(entry) {
    const args = Array.from(entry);
    if (args[0] !== 'event') return;
    const event = { name: args[1], params: args[2] };
    window.__analyticsMockEvents.push(event);
    // The harness intercepts this URL and returns a synthetic response.
    // One mock request per event is intentional; it is not GA4 batching behavior.
    fetch('https://www.google-analytics.com/g/collect', {
      method: 'POST', body: JSON.stringify(event)
    }).catch(() => {});
  }
  dataLayer.forEach(record);
  dataLayer.push = function (entry) { record(entry); return originalPush.call(this, entry); };
  window.__analyticsMockReady = true;
`;
const requests = { tag: 0, stats: 0, events: [], unexpected: [] };
const errors = [];
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 960 },
  reducedMotion: 'reduce', serviceWorkers: 'block' });
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
// Do not replace this with route.continue(), route.fallback(), or route.fetch().
// Even unrecognized requests are stopped, rather than reaching the network.
await context.route('**/*', async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin === 'https://www.googletagmanager.com' && url.pathname === '/gtag/js') {
    requests.tag++;
    await route.fulfill({ contentType: 'text/javascript', body: mockedTag });
    return;
  }
  if (url.origin === 'https://www.google-analytics.com' && url.pathname === '/g/collect') {
    if (request.method() === 'POST') requests.events.push(JSON.parse(request.postData()));
    await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' } });
    return;
  }
  if (url.origin === 'https://www.pixiv.net') {
    await route.fulfill({ contentType: 'text/html', body: '<title>Mock external destination</title>' });
    return;
  }
  if (url.origin === origin && url.pathname.startsWith('/Kakuseigar/')) {
    let relative;
    try { relative = decodeURIComponent(url.pathname.slice('/Kakuseigar/'.length)) || 'index.html'; }
    catch { await route.abort(); return; }
    if (!/^(index\.html|styles\.css|(?:src|data|assets)\/[A-Za-z0-9_./-]+)$/.test(relative) || relative.includes('..')) {
      requests.unexpected.push(url.href);
      await route.abort(); return;
    }
    if (relative === 'data/public-stats.json') {
      requests.stats++;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshot) });
      return;
    }
    const file = path.resolve(root, relative);
    assert.ok(file.startsWith(path.resolve(root) + path.sep), 'Mock assets must remain inside checkout');
    try {
      await route.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body: await readFile(file) });
    } catch {
      requests.unexpected.push(url.href);
      await route.fulfill({ status: 404, body: 'Missing mock asset' });
    }
    return;
  }
  requests.unexpected.push(url.href);
  await route.abort();
});

const page = await context.newPage();
const quiz = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('kakuseigar:session:v1')));
const custom = () => requests.events.filter(event => event.name !== 'page_view');
async function waitFor(test, label) {
  const until = Date.now() + 5000;
  while (!test() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(test(), label);
}
async function click(locator, target = page) {
  await locator.click();
  // The existing app intentionally prevents repeated answer actions for 320 ms.
  await target.waitForTimeout(350);
}
async function external(locator) {
  const opened = page.waitForEvent('popup');
  await locator.click();
  const popup = await opened;
  await popup.waitForLoadState('domcontentloaded');
  await popup.close();
  await page.waitForTimeout(50);
}
async function noOverflow(target = page) {
  assert.equal(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true, 'No horizontal overflow at the current viewport');
}
async function screenshot(name, target = page) {
  // Let mobile viewport units settle after a preceding full-page capture.
  await target.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo({ top: 0, behavior: 'instant' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await noOverflow(target);
  await target.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode().catch(() => {}))));
  // The label exists only in QA images. No fixture data is written to the site.
  await target.evaluate(() => {
    const label = document.createElement('div');
    label.dataset.analyticsFixtureLabel = '';
    label.textContent = '表示確認用の仮データです。実際の来訪数・推薦数ではありません。';
    label.style.cssText = 'padding:8px 12px;background:#fff3cd;color:#493a13;border-bottom:1px solid #bfa565;font:12px/1.6 sans-serif;overflow-wrap:anywhere;';
    document.body.prepend(label);
  });
  try { await target.screenshot({ path: path.join(screenshots, name), fullPage: true }); }
  finally { await target.locator('[data-analytics-fixture-label]').evaluate(node => node.remove()); }
}

try {
  await page.goto(base + '?ignored=private-value');
  await page.getByRole('button', { name: '青娥に聞いてもらう' }).waitFor();
  await waitFor(() => requests.events.length === 1 && requests.stats === 1, 'Initial mocked pageview and snapshot');
  assert.equal(requests.tag, 1);
  assert.deepEqual(requests.events.map(event => event.name), ['page_view']);
  await page.getByText('本日 7回', { exact: true }).waitFor();
  assert.equal(requests.events[0].params.page_location, base);

  await click(page.getByRole('button', { name: '青娥に聞いてもらう' }));
  await waitFor(() => custom().length === 1, 'One play_start');
  assert.equal(custom()[0].name, 'play_start');
  await click(page.locator('[data-option]').first());
  await click(page.getByRole('button', { name: 'ひとつ前の回答を直す' }));
  assert.equal(custom().length, 1, 'Answer and undo must not send analytics');

  while (['question', 'favorite'].includes((await quiz()).phase)) {
    const before = custom().length;
    if ((await quiz()).phase === 'favorite') await click(page.locator('[data-favorite-answer="no"]'));
    else await click(page.getByRole('button', { name: '今は決められない', exact: true }));
    if ((await quiz()).phase !== 'result') assert.equal(custom().length, before, 'Questions must not send analytics');
  }
  await page.locator('.work-title').waitFor();
  await waitFor(() => custom().length === 2, 'One recommendation after display');
  const first = (await quiz()).resultHistory[0];
  const recommendation = custom()[1];
  assert.equal(recommendation.name, 'work_recommended');
  assert.equal(recommendation.params.work_id, first.workId);
  assert.equal(recommendation.params.first_recommendation, 'yes');
  assert.equal(recommendation.params.answer_count, 1);
  assert.equal(recommendation.params.undo_count, 1);
  assert.equal(recommendation.params.skip_count, runtime.rules.first_normal_result_after);
  assert.equal(requests.stats, 1, 'Results reuse the original statistics fetch');
  await page.locator('.stats-footprint').filter({ hasText: '今月、最初の一作として' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('result-footprint-mobile.png');
  await page.setViewportSize({ width: 1280, height: 960 });

  await external(page.getByRole('link', { name: 'pixivで読む' }));
  await waitFor(() => custom().length === 3, 'First recommended work click');
  assert.equal(custom()[2].params.recommendation_context, 'recommended');
  assert.equal(custom()[2].params.first_work_open, 'yes');
  await click(page.locator('[data-action="history"]'));
  await external(page.getByRole('link', { name: 'pixivで読む' }));
  assert.equal(custom().length, 3, 'History and result links share a conversion deduplication key');
  await click(page.locator('.history-title').first());
  assert.equal(custom().length, 3, 'Reviewing a result does not recommend it again');

  await click(page.getByRole('link', { name: 'みんなへのお薦め' }));
  await page.getByRole('heading', { name: '本日のお薦めランキング' }).waitFor();
  await screenshot('statistics-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('statistics-mobile.png');
  await page.setViewportSize({ width: 1280, height: 960 });
  await external(page.locator('[data-stats-link^="today:"]').first());
  await waitFor(() => custom().length === 4, 'Ranking click counted separately');
  assert.equal(custom()[3].params.recommendation_context, 'ranking');
  assert.equal(custom()[3].params.link_source, 'ranking_today');
  assert.equal(Object.hasOwn(custom()[3].params, 'first_work_open'), false);
  await external(page.locator('[data-stats-link^="today:"]').first());
  assert.equal(custom().length, 4, 'Repeated ranking clicks are limited within a document');
  assert.equal(requests.stats, 1, 'Ranking and footprint displays share one snapshot');

  await click(page.getByRole('button', { name: '案内に戻る', exact: true }));
  await page.reload();
  await page.locator('.work-title').waitFor();
  await waitFor(() => requests.stats === 2 && requests.events.filter(event => event.name === 'page_view').length === 2,
    'Reload performs one new snapshot fetch and a pageview');
  assert.equal(custom().length, 4, 'Reload must not replay play_start or recommendation');
  await external(page.getByRole('link', { name: 'pixivで読む' }));
  assert.equal(custom().length, 4, 'Reload preserves recommendation-click deduplication');
  assert.equal(requests.tag, 2, 'Exactly one mock tag per document');

  // Opt-out must update in place, preserving the recommendation and snapshot.
  const progressBeforeToggle = await quiz();
  await page.evaluate(() => { window.__qaDocumentMarker = 'same-document'; });
  await click(page.getByRole('link', { name: 'このサイトについて' }));
  await click(page.getByRole('button', { name: 'このブラウザーでのアクセス解析を停止する' }));
  await page.getByText('アクセス解析は停止中です。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__qaDocumentMarker), 'same-document', 'Opt-out must not reload');
  assert.deepEqual(await quiz(), progressBeforeToggle, 'Opt-out must not erase the current game');
  assert.equal(requests.stats, 2);
  assert.equal(requests.tag, 2);
  assert.equal(custom().length, 4);
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('about-opt-out-mobile.png');
  await click(page.getByRole('button', { name: '案内に戻る', exact: true }));
  assert.equal((await quiz()).resultHistory[0].workId, first.workId);

  // Both storage APIs denied: the preference still takes effect in this page,
  // the UI explains its lifetime, and the in-memory game remains playable.
  const denied = await context.newPage();
  await denied.setViewportSize({ width: 390, height: 844 });
  await denied.addInitScript(() => {
    for (const name of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(window, name, { get() { throw new DOMException('blocked for QA', 'SecurityError'); } });
    }
    window.__qaDocumentMarker = 'memory-only-game';
  });
  await denied.goto(base);
  await denied.getByRole('button', { name: '青娥に聞いてもらう' }).waitFor();
  await click(denied.getByRole('button', { name: '青娥に聞いてもらう' }), denied);
  await waitFor(() => custom().length === 5, 'Storage-denied page can start a new in-memory game');
  const questionBeforeToggle = await denied.locator('.scene h1').textContent();
  await click(denied.getByRole('link', { name: 'このサイトについて' }), denied);
  await click(denied.getByRole('button', { name: 'このブラウザーでのアクセス解析を停止する' }), denied);
  await denied.getByText(/アクセス解析は停止中です。設定を保存できない/).waitFor();
  assert.equal(await denied.evaluate(() => window.__qaDocumentMarker), 'memory-only-game');
  assert.equal(await denied.evaluate(() => window['ga-disable-G-LX9EPBLR4G']), true);
  await screenshot('about-storage-denied-mobile.png', denied);
  await click(denied.getByRole('button', { name: '案内に戻る', exact: true }), denied);
  assert.equal(await denied.locator('.scene h1').textContent(), questionBeforeToggle);
  const countBeforeDisabledAnswer = requests.events.length;
  await click(denied.locator('[data-option]').first(), denied);
  assert.equal(requests.events.length, countBeforeDisabledAnswer, 'Disabled measurement remains silent without persistence');
  await noOverflow(denied);
  await denied.close();

  assert.doesNotMatch(JSON.stringify(requests.events), /private-value|"answers"|"reason"|"score"|"characterId"/);
  assert.deepEqual(requests.unexpected, [], 'Every request must be served from fixtures or known mocks');
  assert.deepEqual(errors, []);
  console.log('Analytics browser checks passed: core journey 4 custom events and 2 mocked pageviews across reload; zero question events; history/reload deduplication; ranking separation; one snapshot fetch per document; opt-out without reload; storage-denied in-memory play; no horizontal overflow at 390px. All Google traffic was mocked; real GA4 bandwidth was not measured.');
  console.log(`QA screenshots with explicit synthetic-data labels: ${screenshots}`);
} finally {
  await context.close();
  await browser.close();
}
