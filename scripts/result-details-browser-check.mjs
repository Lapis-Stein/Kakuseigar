// Optional integration checks. Requires Playwright (or NODE_PATH) and Edge.
// Every HTTP request is fulfilled locally or aborted. The Google tag below only
// records in memory; this script must never send test activity to the property.
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const screenshots = path.join(root, 'test-results', 'result-details');
await mkdir(screenshots, { recursive: true });
const base = 'https://lapis-stein.github.io/Kakuseigar/';
const origin = new URL(base).origin;
const runtime = JSON.parse(await readFile(path.join(root, 'data/runtime.json'), 'utf8'));
const approvedIds = new Set(runtime.works.map(work => work.id));
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' };
const mockedTag = `
  window.__resultDetailsEvents = [];
  const queue = window.dataLayer;
  const originalPush = queue.push;
  function record(entry) {
    const args = Array.from(entry);
    if (args[0] === 'event') window.__resultDetailsEvents.push({ name: args[1], params: args[2] });
  }
  queue.forEach(record);
  queue.push = function (entry) { record(entry); return originalPush.call(this, entry); };
  window.__resultDetailsTagReady = true;
`;
const requests = { tag: 0, stats: 0, pixiv: 0, unexpected: [] };
const errors = [];
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 960 },
  reducedMotion: 'reduce', serviceWorkers: 'block' });
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
// No continue(), fallback() or fetch(): even unknown destinations cannot reach
// the network. The canonical URL only enables the app's production host gate.
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin === 'https://www.googletagmanager.com' && url.pathname === '/gtag/js') {
    requests.tag++;
    await route.fulfill({ contentType: 'text/javascript', body: mockedTag });
    return;
  }
  if (url.origin === 'https://www.pixiv.net' && url.pathname === '/novel/show.php') {
    requests.pixiv++;
    await route.fulfill({ contentType: 'text/html', body: '<title>Mock pixiv destination</title>' });
    return;
  }
  if (url.origin === origin && url.pathname.startsWith('/Kakuseigar/')) {
    let relative;
    try { relative = decodeURIComponent(url.pathname.slice('/Kakuseigar/'.length)) || 'index.html'; }
    catch { requests.unexpected.push(url.href); await route.abort(); return; }
    if (!/^(index\.html|styles\.css|(?:src|data|assets)\/[A-Za-z0-9_./-]+)$/.test(relative) || relative.includes('..')) {
      requests.unexpected.push(url.href); await route.abort(); return;
    }
    if (relative === 'data/public-stats.json') requests.stats++;
    const file = path.resolve(root, relative);
    assert.ok(file.startsWith(path.resolve(root) + path.sep), 'Fixtures must stay inside the checkout');
    try {
      await route.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body: await readFile(file) });
    } catch {
      requests.unexpected.push(url.href);
      await route.fulfill({ status: 404, body: 'Missing local fixture' });
    }
    return;
  }
  requests.unexpected.push(url.href);
  await route.abort();
});

const page = await context.newPage();
const state = target => target.evaluate(() => JSON.parse(sessionStorage.getItem('kakuseigar:session:v1')));
const events = target => target.evaluate(() => window.__resultDetailsEvents || []);
const active = target => target.locator('.detail-scene:not([inert])');
async function recommendations(target) { return (await events(target)).filter(event => event.name === 'work_recommended'); }
async function settled(target) {
  await target.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}
async function click(target, locator) {
  await locator.click();
  // Answer actions intentionally retain a 320 ms duplicate-click guard.
  await target.waitForTimeout(350);
}
async function noOverflow(target) {
  assert.equal(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true, 'No horizontal overflow');
}
async function finishRound(target, { skip = false, last = false } = {}) {
  for (let step = 0; step < 80; step++) {
    const current = await state(target);
    if (current.phase === 'result') return current.resultHistory.at(-1);
    if (current.phase === 'favorite') await click(target, target.locator('[data-favorite-answer="no"]'));
    else if (current.phase === 'question') {
      if (skip) await click(target, target.getByRole('button', { name: '今は決められない', exact: true }));
      else await click(target, last ? target.locator('[data-option]').last() : target.locator('[data-option]').first());
    } else assert.fail(`Unexpected phase while answering: ${current.phase}`);
  }
  assert.fail('Question loop did not reach a result');
}
async function start(target) {
  await target.goto(base);
  await target.getByRole('button', { name: '青娥に聞いてもらう' }).waitFor();
  await target.waitForFunction(() => window.__resultDetailsTagReady === true);
  await click(target, target.getByRole('button', { name: '青娥に聞いてもらう' }));
}
async function openDetails(target, resultId, history = false) {
  const route = `#/${history ? 'review' : 'result'}/${resultId}/answers`;
  await target.locator(`a[href="${route}"]`).click();
  await active(target).filter({ has: target.locator('[aria-current="page"][href$="/answers"]') }).waitFor();
  await settled(target);
  assert.ok(target.url().endsWith(route));
}
async function tab(target, name) {
  await active(target).locator(`.detail-nav a[href$="/${name}"]`).click();
  await target.locator(`.detail-scene[data-detail-page="${name}"]:not([inert])`).waitFor();
  await settled(target);
}
async function geometry(target) {
  return active(target).evaluate(node => {
    const box = node.getBoundingClientRect();
    const links = node.querySelector('.detail-bottom').getBoundingClientRect();
    return { width: box.width, height: box.height, top: box.top + scrollY,
      linksTop: links.top - box.top, linksLeft: links.left - box.left };
  });
}
function sameGeometry(first, second, label) {
  for (const key of Object.keys(first)) assert.ok(Math.abs(first[key] - second[key]) < 1,
    `${label}: ${key} changed from ${first[key]} to ${second[key]}`);
}
async function detailSnapshot(target) {
  return active(target).evaluate(node => ({
    features: [...node.querySelectorAll('.feature-row')].map(row => row.getAttribute('aria-label')),
    values: [...node.querySelectorAll('.feature-value')].map(value => value.textContent.trim()),
    remark: node.querySelector('.remark-quote')?.textContent,
    pair: node.querySelector('.remark-pair')?.textContent,
  }));
}
async function capture(target, name) {
  await settled(target);
  await target.locator('img:visible').evaluateAll(images => Promise.all(images.map(image => image.decode().catch(() => {}))));
  await target.evaluate(() => {
    const label = document.createElement('div');
    label.dataset.resultDetailsFixtureLabel = '';
    label.textContent = '動作確認用の回答です。外部通信と集計送信はすべて遮断しています。';
    label.style.cssText = 'padding:8px 12px;background:#fff3cd;color:#493a13;border-bottom:1px solid #bfa565;font:12px/1.6 sans-serif;';
    document.body.prepend(label);
  });
  try { await target.screenshot({ path: path.join(screenshots, name), fullPage: true }); }
  finally { await target.locator('[data-result-details-fixture-label]').evaluate(node => node.remove()); }
}
async function external(target, locator) {
  const opened = target.waitForEvent('popup');
  await locator.click();
  const popup = await opened;
  await popup.waitForLoadState('domcontentloaded');
  assert.equal(await popup.title(), 'Mock pixiv destination');
  await popup.close();
}

try {
  await start(page);
  const first = await finishRound(page);
  assert.equal((await state(page)).resultHistory.length, 1);
  assert.equal((await recommendations(page)).length, 1);
  const beforeDetails = await state(page);
  const initialEvents = await events(page);
  await openDetails(page, first.resultId);
  const originalDetails = await detailSnapshot(page);
  assert.equal(originalDetails.features.length, 7);
  assert.equal(originalDetails.values.reduce((sum, value) => sum + (parseFloat(value) || 0), 0), 100,
    'The rounded interest percentages add to 100');
  assert.ok(originalDetails.remark?.trim(), 'A Seiga remark is visible');

  for (const width of [1280, 820, 390, 320]) {
    await page.setViewportSize({ width, height: width >= 820 ? 960 : 844 });
    await tab(page, 'answers');
    await noOverflow(page);
    const answersGeometry = await geometry(page);
    assert.equal(await page.locator('.detail-scene[inert]').count(), 1);
    assert.equal(await page.locator('.detail-scene[inert]').evaluate(node =>
      node.inert && node.getAttribute('aria-hidden') === 'true' && getComputedStyle(node).visibility === 'hidden'), true);
    assert.equal(await page.locator('.detail-scene[inert] a').first().isVisible(), false);
    await capture(page, `answers-${width}.png`);
    await tab(page, 'work');
    await noOverflow(page);
    sameGeometry(answersGeometry, await geometry(page), `${width}px tab switch`);
    assert.equal(await active(page).locator('.nearby-book').count(), Math.min(2, runtime.works.length - 1));
    assert.equal(await active(page).locator('.feature-row').count(), 7);
    await capture(page, `work-${width}.png`);
    await tab(page, 'answers');
    sameGeometry(answersGeometry, await geometry(page), `${width}px return tab switch`);
    assert.deepEqual(await detailSnapshot(page), originalDetails);
  }
  assert.deepEqual(await state(page), beforeDetails, 'Details must not alter the diagnosis state');
  assert.deepEqual(await events(page), initialEvents, 'Tab changes must not send any analytics');
  assert.equal(requests.stats, 1, 'Details reuse the document snapshot');

  await page.setViewportSize({ width: 1280, height: 960 });
  await tab(page, 'work');
  const related = active(page).locator('.nearby-book').first();
  const relatedId = await related.getAttribute('data-related-work');
  assert.ok(approvedIds.has(relatedId));
  assert.notEqual(relatedId, first.workId);
  await related.click();
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.getByRole('dialog').locator('a[href^="#/"]').count(), 0,
    'Related preview has no recursive related/detail navigation');
  await capture(page, 'related-desktop.png');
  await page.getByRole('dialog').getByRole('button', { name: '閉じる ×', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await related.evaluate(node => node === document.activeElement), true);
  await related.click();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await related.evaluate(node => node === document.activeElement), true);
  assert.deepEqual(await state(page), beforeDetails);
  assert.deepEqual(await events(page), initialEvents, 'Opening and closing previews are not recommendations or clicks');
  await related.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await capture(page, 'related-mobile.png');
  await external(page, page.getByRole('dialog').getByRole('link', { name: 'pixivで読む' }));
  const afterRelated = await events(page);
  assert.equal(afterRelated.length, initialEvents.length + 1);
  assert.equal(afterRelated.at(-1).name, 'work_opened');
  assert.equal(afterRelated.at(-1).params.work_id, `work_${relatedId}`);
  assert.equal(afterRelated.at(-1).params.recommendation_context, 'related');
  assert.equal(afterRelated.at(-1).params.link_source, 'related');
  assert.equal(Object.hasOwn(afterRelated.at(-1).params, 'first_recommendation'), false);
  assert.equal(Object.hasOwn(afterRelated.at(-1).params, 'first_work_open'), false);
  await external(page, page.getByRole('dialog').getByRole('link', { name: 'pixivで読む' }));
  assert.deepEqual(await events(page), afterRelated, 'Repeated related clicks are suppressed');
  await page.keyboard.press('Escape');
  assert.deepEqual(await state(page), beforeDetails, 'Reading a related work does not consume a recommendation');

  await active(page).locator('.detail-context-back').click();
  await page.locator('.work-title').waitFor();
  await click(page, page.getByRole('button', { name: 'いいえ、もう少し探す' }));
  const second = await finishRound(page, { last: true });
  const afterSecond = await state(page);
  assert.ok(afterSecond.answers.length > first.answerCount);
  assert.equal(afterSecond.resultHistory.length, 2);
  assert.equal((await recommendations(page)).length, 2);
  await click(page, page.locator('[data-action="history"]'));
  await click(page, page.locator('.history-title').first());
  await openDetails(page, first.resultId, true);
  assert.deepEqual(await detailSnapshot(page), originalDetails, 'History retains the interests and remark at recommendation time');
  assert.deepEqual(await state(page), afterSecond);
  await page.reload();
  await active(page).waitFor();
  await page.waitForFunction(() => window.__resultDetailsTagReady === true);
  assert.ok(page.url().endsWith(`#/review/${first.resultId}/answers`));
  assert.deepEqual(await detailSnapshot(page), originalDetails, 'A deep URL reload restores the same historical details');
  assert.deepEqual(await state(page), afterSecond);
  assert.equal((await recommendations(page)).length, 0, 'Reloaded details do not replay a recommendation');
  await page.goto(base + '#/review/not-a-result/answers');
  await page.locator('.work-title').waitFor();
  assert.ok(page.url().endsWith(`#/result/${second.resultId}`), 'Unknown detail IDs safely return to the current guide');
  assert.deepEqual(await state(page), afterSecond);

  const skipped = await context.newPage();
  await skipped.setViewportSize({ width: 390, height: 844 });
  await start(skipped);
  const skippedResult = await finishRound(skipped, { skip: true });
  const skippedState = await state(skipped);
  await openDetails(skipped, skippedResult.resultId);
  const empty = await detailSnapshot(skipped);
  assert.equal(empty.values.length, 7);
  assert.ok(empty.values.every(value => value === '—'), 'All skips show unknown interests, not zero preference');
  assert.match(await active(skipped).locator('.scale-explanation').innerText(), /まだ表示できません/);
  assert.ok(empty.remark?.trim());
  const emptyGeometry = await geometry(skipped);
  await tab(skipped, 'work');
  sameGeometry(emptyGeometry, await geometry(skipped), 'All-skipped details stay the same size');
  await tab(skipped, 'answers');
  await capture(skipped, 'answers-all-skipped.png');
  assert.deepEqual(await state(skipped), skippedState);
  assert.equal((await recommendations(skipped)).length, 1);
  await skipped.close();

  assert.deepEqual(requests.unexpected, [], 'Every HTTP request was a known local fixture or mock');
  assert.deepEqual(errors, []);
  console.log('Result details browser checks passed: 1280/820/390/320px equal panel geometry, historical interests, 100% display, hidden-pane isolation, related preview and click deduplication, deep URL reload/fallback, all-skipped state. All external traffic was blocked or mocked.');
  console.log(`QA screenshots: ${screenshots}`);
} finally {
  await context.close();
  await browser.close();
}
