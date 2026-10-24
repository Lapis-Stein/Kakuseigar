// Optional browser checks. Install Playwright separately, or provide it via NODE_PATH.
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const base = process.env.TEST_URL || 'http://127.0.0.1:4173/Kakuseigar/';
const presentation = JSON.parse(await readFile(new URL('../data/presentation.json', import.meta.url), 'utf8'));
const runtime = JSON.parse(await readFile(new URL('../data/runtime.json', import.meta.url), 'utf8'));
const totalWorks = runtime.works.length;
const questionImages = new Set(presentation.narrator.question_moods.map(mood =>
  new URL(presentation.narrator.images[mood], base).pathname));
const lastQuestionPortrait = new WeakMap();
const errors = [];
await mkdir('test-results', { recursive: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, reducedMotion: 'reduce' });
const page = await context.newPage();
page.on('pageerror', e => errors.push(e.message));
const state = p => p.evaluate(() => JSON.parse(sessionStorage.getItem('kakuseigar:session:v1')));
async function click(p, locator) {
  await locator.click();
  await p.waitForTimeout(350);
  await questionPortrait(p);
}
async function noOverflow(p) {
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Horizontal overflow');
}
async function portraitPath(p) {
  const img = p.locator('.portrait.has-image img');
  await img.waitFor();
  await img.evaluate(n => n.decode());
  return new URL(await img.getAttribute('src'), base).pathname;
}
async function portrait(p, mood) {
  assert.equal(await portraitPath(p), new URL(presentation.narrator.images[mood], base).pathname, `Expected ${mood} portrait`);
}
async function questionPortrait(p) {
  const stage = p.locator('.stage');
  const screen = await stage.getAttribute('data-screen');
  if (!['question', 'favorite'].includes(screen)) return;
  const key = `${screen}:${await stage.locator('h1').textContent()}:${await stage.locator('.question-count').allTextContents()}`;
  const path = await portraitPath(p);
  assert.ok(questionImages.has(path), 'Question portraits must come from the configured pool');
  const previous = lastQuestionPortrait.get(p);
  if (previous?.key === key) assert.equal(path, previous.path, 'Same question must retain its portrait');
  else if (previous) assert.notEqual(path, previous.path, 'Consecutive questions must use different portraits');
  lastQuestionPortrait.set(p, { key, path });
  return path;
}
async function questionNearViewportTop(p) {
  await p.waitForFunction(() => {
    const scene = document.querySelector('.stage[data-screen="question"] .scene, .stage[data-screen="favorite"] .scene');
    const target = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
    // The entry animation translates the panel by up to 6px while scrolling starts.
    return scene && scrollY > 0 && Math.abs(scene.getBoundingClientRect().top - target) < 8;
  });
  const position = await p.locator('.scene').evaluate(n => ({ top: n.getBoundingClientRect().top, scroll: scrollY }));
  assert.ok(position.top >= 0 && position.top < 64 && position.scroll > 0, 'Next question should be near the viewport top, not at page scroll 0');
}
async function declineFavorite(p) {
  if (await p.locator('[data-favorite-answer="no"]').count()) {
    const before = (await state(p)).answers;
    await click(p, p.locator('[data-favorite-answer="no"]'));
    assert.deepEqual((await state(p)).answers, before);
  }
}
try {
  await page.goto(base);
  await page.getByRole('heading', { name: 'お探しのお話は、 どんなお話？' }).waitFor();
  await portrait(page, 'idle');
  await page.screenshot({ path: 'test-results/start-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.screenshot({ path: 'test-results/start-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 960 });
  await click(page, page.getByRole('button', { name: '青娥に聞いてもらう' }));
  assert.equal((await state(page)).answers.length, 0);
  // Exercise the actual smooth-scroll path after an answer on a phone viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await click(page, page.locator('[data-option]').first());
  await questionNearViewportTop(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 960 });
  const firstAnswer = (await state(page)).answers[0];
  await click(page, page.getByRole('button', { name: 'ひとつ前の回答を直す' }));
  assert.equal((await state(page)).answers.length, 0);
  await click(page, page.locator('[data-option]').first());
  assert.deepEqual((await state(page)).answers[0], firstAnswer);
  const beforeSkipLink = page.url();
  await page.locator('.skip-link').evaluate(a => a.click());
  assert.equal(page.url(), beforeSkipLink);
  await page.screenshot({ path: 'test-results/question-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  assert.equal(await page.locator('[data-option]').first().evaluate(n => getComputedStyle(n).fontSize), '16px');
  await page.screenshot({ path: 'test-results/question-mobile.png', fullPage: true });
  for (let i = 1; i < runtime.rules.first_normal_result_after; i++) {
    await declineFavorite(page);
    await click(page, page.getByRole('button', { name: '今は決められない', exact: true }));
  }
  assert.equal((await state(page)).resultHistory.length, 1);
  const firstResult = (await state(page)).resultHistory[0];
  await portrait(page, firstResult.isLast ? 'celebrate' : 'recommend');
  await page.screenshot({ path: 'test-results/result-mobile.png', fullPage: true });
  assert.match(await page.getByRole('link', { name: 'pixivで読む' }).getAttribute('href'), /^https:\/\/www\.pixiv\.net\/novel\/show\.php\?id=/);
  await page.reload();
  lastQuestionPortrait.delete(page);
  await page.locator('.work-title').waitFor();
  assert.deepEqual((await state(page)).resultHistory[0], firstResult);
  await click(page, page.locator('[data-action="history"]'));
  await click(page, page.locator('.history-title').first());
  assert.equal(await page.getByRole('button', { name: 'いいえ、もう少し探す' }).count(), 0);
  await click(page, page.getByRole('button', { name: '今の案内に戻る' }));
  for (let resultNumber = 1; resultNumber < totalWorks; resultNumber++) {
    await click(page, page.getByRole('button', { name: 'いいえ、もう少し探す' }));
    if (resultNumber === 1) {
      const before = (await state(page)).answers.length;
      const currentPortrait = await questionPortrait(page);
      await page.goto(base + '#/result/' + firstResult.resultId);
      assert.equal(await page.getByRole('button', { name: 'いいえ、もう少し探す' }).count(), 0);
      await click(page, page.getByRole('button', { name: '今の案内に戻る' }));
      assert.equal((await state(page)).answers.length, before);
      assert.equal(await questionPortrait(page), currentPortrait);
    }
    while (['question', 'favorite'].includes((await state(page)).phase)) {
      await declineFavorite(page);
      await click(page, page.getByRole('button', { name: '今は決められない', exact: true }));
    }
    assert.equal((await state(page)).resultHistory.length, resultNumber + 1);
  }
  const complete = await state(page);
  const initialQuestions = runtime.rules.first_question_sets.find(set => set.id === complete.initialSetId).questions;
  const expectedQuestions = initialQuestions.length + runtime.rules.continuation_selection.channel_order.reduce((sum, channel) =>
    sum + Math.min(totalWorks - 1, runtime.questions.filter(question => question.channel === channel && !initialQuestions.includes(question.id)).length), 0);
  assert.equal(complete.answers.length, expectedQuestions);
  assert.equal(new Set(complete.answers.map(([id]) => id)).size, expectedQuestions);
  assert.equal(new Set(complete.resultHistory.map(r => r.workId)).size, totalWorks);
  await page.getByText('制覇おめでとう！', { exact: true }).waitFor();
  await portrait(page, 'celebrate');
  await page.setViewportSize({ width: 320, height: 720 });
  await noOverflow(page);
  await page.screenshot({ path: 'test-results/complete-320.png', fullPage: true });
  await click(page, page.getByRole('button', { name: 'いいえ、もう少し探す' }));
  assert.equal((await state(page)).phase, 'ending');
  await portrait(page, 'ending');
  assert.equal(await page.getByRole('link', { name: '作者のXを開く' }).getAttribute('href'), 'https://x.com/LapisIsStein');
  await noOverflow(page);
  await page.screenshot({ path: 'test-results/ending-mobile.png', fullPage: true });
  await page.reload();
  await page.getByRole('link', { name: '作者のXを開く' }).waitFor();
  // A separate play exercises the favorite interruption and replay after reload.
  const fresh = await context.newPage();
  fresh.on('pageerror', e => errors.push(e.message));
  await fresh.goto(base);
  await click(fresh, fresh.getByRole('button', { name: '青娥に聞いてもらう' }));
  while ((await state(fresh)).phase === 'question') {
    await click(fresh, fresh.getByRole('button', { name: '今は決められない', exact: true }));
  }
  assert.equal((await state(fresh)).phase, 'favorite');
  const prompt = await state(fresh);
  assert.ok(prompt.answers.length >= 2 && prompt.answers.length <= 4);
  assert.equal(await fresh.getByRole('button', { name: '気になる人物の話をする' }).count(), 0);
  await questionPortrait(fresh);
  await fresh.screenshot({ path: 'test-results/favorite-automatic.png', fullPage: true });
  await fresh.reload();
  lastQuestionPortrait.delete(fresh);
  await fresh.locator('[data-favorite-answer="yes"]').waitFor();
  assert.equal((await state(fresh)).favoriteCharacterId, prompt.favoriteCharacterId);
  const reloadedPortrait = await questionPortrait(fresh);
  await click(fresh, fresh.getByRole('link', { name: 'このサイトについて' }));
  await click(fresh, fresh.getByRole('button', { name: '案内に戻る', exact: true }));
  assert.equal((await state(fresh)).favoriteCharacterId, prompt.favoriteCharacterId);
  assert.equal(await questionPortrait(fresh), reloadedPortrait, 'About-page return must keep the same favorite portrait');
  await fresh.goto(base + '#/play');
  await fresh.locator('[data-favorite-answer="yes"]').waitFor();
  assert.equal((await state(fresh)).favoriteCharacterId, prompt.favoriteCharacterId);
  assert.equal(await questionPortrait(fresh), reloadedPortrait, 'Pending favorite redraw must keep its portrait');
  await click(fresh, fresh.getByRole('button', { name: 'はい、見たい', exact: true }));
  assert.equal((await state(fresh)).resultHistory[0].trigger, 'favorite');
  assert.equal((await state(fresh)).resultHistory[0].characterId, prompt.favoriteCharacterId);
  assert.equal((await state(fresh)).answers.length, prompt.answers.length);
  await click(fresh, fresh.getByRole('button', { name: 'いいえ、もう少し探す' }));
  await click(fresh, fresh.getByRole('button', { name: '今は決められない', exact: true }));
  assert.equal(await fresh.getByRole('button', { name: '気になる人物の話をする' }).count(), 0);
  if ((await state(fresh)).phase === 'favorite') assert.notEqual((await state(fresh)).favoriteCharacterId, prompt.favoriteCharacterId);
  await declineFavorite(fresh);
  await click(fresh, fresh.getByRole('button', { name: '今は決められない', exact: true }));
  assert.equal((await state(fresh)).resultHistory.length, 2);
  assert.equal((await state(fresh)).answers.length, prompt.answers.length + 2);
  // Browser-side storage denial should not prevent answering.
  const denied = await context.newPage();
  await denied.addInitScript(() => Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }));
  await denied.goto(base);
  await click(denied, denied.getByRole('button', { name: '青娥に聞いてもらう' }));
  for (let i = 0; i < 5; i++) {
    if (await denied.locator('[data-favorite-answer="no"]').count()) await click(denied, denied.locator('[data-favorite-answer="no"]'));
    await click(denied, denied.getByRole('button', { name: '今は決められない', exact: true }));
  }
  await denied.locator('.work-title').waitFor();
  assert.deepEqual(errors, []);
  console.log(`Browser checks passed: ${totalWorks} unique works, ${expectedQuestions} ordinary questions, question portrait rotation, special portraits, automatic favorite, resume, history, ending, mobile auto-scroll, storage denied.`);
} finally { await browser.close(); }
