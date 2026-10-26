import { validateRuntime } from './engine.js?v=20261025-1';
import { QuizSession } from './session.js?v=20261025-1';
import { createStorage, fingerprint } from './storage.js?v=20261023-1';
import { QuestionPortraits } from './portraits.js';
import { NarratorInteraction, NARRATOR_THRESHOLDS } from './narrator-interaction.js';
import { shareWork, shareCompletion, shareRobot } from './sharing.js?v=20261025-2';
import { createAnalytics } from './analytics.js?v=20261026-2';
import { createPublicStats } from './public-stats.js?v=20261026-4';
import { ANALYTICS_CONFIG } from './analytics-config.js?v=20261026-2';

const app = document.querySelector('#app');
const notice = document.querySelector('#notice');
const toastElement = document.querySelector('#toast');
const storage = createStorage();
const narratorStorage = createStorage(undefined, 'kakuseigar:narrator:v1');
let data, presentation, session;
let analytics, publicStats;
let questionPortraits;
let narratorInteraction;
let noticeText = '';
let lockedUntil = 0;
let toastTimer;
let historyReturn = '#/play';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'disabled') node.disabled = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter(c => c !== null && c !== undefined));
  return node;
}

function button(text, onClick, style = 'primary-button', attrs = {}) {
  return el('button', { type: 'button', className: style, onClick, ...attrs }, text);
}

function externalLink(text, href, style = 'primary-button') {
  return el('a', { href, className: style, target: '_blank', rel: 'noopener noreferrer' }, text,
    el('span', { 'aria-hidden': 'true' }, ' ↗'), el('span', { className: 'sr-only' }, '（新しいタブで開きます）'));
}

// Statistics must never delay navigation or interrupt the guide.
function recordMetric(method, ...args) {
  try { analytics?.[method](...args); } catch { /* Measurement is optional. */ }
}

function workLink(work, source, result, style = 'primary-button') {
  const link = externalLink('pixivで読む', work.pixiv_url, style);
  link.addEventListener('click', () => recordMetric('click', work.id, source, result));
  return link;
}

function toast(text) {
  clearTimeout(toastTimer);
  toastElement.textContent = text;
  toastElement.hidden = false;
  toastTimer = setTimeout(() => { toastElement.hidden = true; }, 4500);
}

function persist() {
  storage.write(session.exportState());
  updateNotice();
}

function updateNotice() {
  notice.textContent = noticeText || (!storage.available || !narratorStorage.available ? 'この環境では、再読込すると最初に戻る場合があります。' : '');
  notice.hidden = !notice.textContent;
}

function activeRoute() {
  if (!session?.state.started) return '#/start';
  switch (session.state.phase) {
    case 'result': return '#/result/' + currentResult().resultId;
    case 'ending': return '#/ending';
    case 'favorite': return '#/favorite';
    default: return '#/play';
  }
}

function go(route, replace = false, viewOptions = {}) {
  if (location.hash !== route) history[replace ? 'replaceState' : 'pushState'](null, '', route);
  render(viewOptions);
}

function action(change, token, { route, replace = true } = {}) {
  if (performance.now() < lockedUntil || token !== session.state.activeStepId) return;
  lockedUntil = performance.now() + 320;
  try {
    change(token);
    persist();
    go(route || activeRoute(), replace, { scrollToQuestion: true });
  } catch (error) {
    console.error('Could not apply interaction', error);
    toast('画面を更新しました。もう一度お選びください。');
    go(activeRoute(), true);
  }
}

function robotName() { return presentation.narrator.robot?.name || '芳香ちゃんロボ'; }

function persistNarrator() {
  narratorStorage.write(narratorInteraction.exportState());
  updateNotice();
}

function updateNarrator(aside, mood) {
  const actor = narratorInteraction.actor;
  aside.dataset.actor = actor;
  const name = actor === 'seiga' ? presentation.narrator.name : robotName();
  aside.querySelector('.narrator-name').textContent = name;
  aside.querySelector('.narrator-tag').textContent = actor === 'seiga' ? '本日の案内役' : '本日の代理';
  const portrait = aside.querySelector('.portrait');
  if (portrait.tagName === 'BUTTON') portrait.setAttribute('aria-label', `${name}に声をかける`);
  const imagePath = actor === 'seiga' ? (presentation.narrator.images[mood] || presentation.narrator.images.idle)
    : presentation.narrator.robot?.images?.[actor === 'broken' ? 'broken' : 'idle'];
  if (portrait.dataset.imagePath === (imagePath || '')) return;
  portrait.dataset.imagePath = imagePath || '';
  portrait.classList.remove('has-image');
  portrait.replaceChildren(el('span', { className: 'portrait-mark', 'aria-hidden': 'true' }, actor === 'seiga' ? '青' : actor === 'robot' ? '芳' : '…'),
    el('span', { className: 'portrait-caption', 'aria-hidden': 'true' }, actor === 'broken' ? 'しばらく、お休み' : 'お話のご案内'));
  if (imagePath && /^assets\/[a-zA-Z0-9_./-]+\.(png|webp|svg)$/.test(imagePath) && !imagePath.includes('..')) {
    const image = el('img', { src: new URL('../' + imagePath, import.meta.url), alt: '', className: 'narrator-image',
      width: 1024, height: 1536, decoding: 'async', draggable: 'false' });
    image.addEventListener('load', () => {
      if (portrait.dataset.imagePath !== imagePath) return;
      portrait.replaceChildren(image); portrait.classList.add('has-image');
    });
  }
}

function narrator(mood, line) {
  const broken = narratorInteraction.actor === 'broken';
  const portrait = broken ? el('div', { className: 'portrait', 'aria-hidden': 'true' })
    : button('', () => {
      if (ignoreClick || document.querySelector('dialog[open]')) { ignoreClick = false; return; }
      const reply = narratorInteraction.tap(location.hash || activeRoute());
      persistNarrator();
      if (narratorInteraction.actor === 'broken') { render({ preserveScroll: true }); return; }
      updateNarrator(aside, mood);
      reaction.textContent = narratorInteraction.count === NARRATOR_THRESHOLDS.robot ? `青娥「${reply}」` : reply;
      reaction.hidden = false;
    }, 'portrait portrait-button');
  let pointerStart = null, ignoreClick = false;
  portrait.addEventListener('pointerdown', event => { pointerStart = [event.clientX, event.clientY]; ignoreClick = false; });
  portrait.addEventListener('pointerup', event => {
    if (pointerStart) ignoreClick = Math.hypot(event.clientX - pointerStart[0], event.clientY - pointerStart[1]) > 10;
    pointerStart = null;
  });
  portrait.addEventListener('pointercancel', () => { pointerStart = null; ignoreClick = true; });
  portrait.addEventListener('keydown', event => {
    if (!['Enter', ' '].includes(event.key)) return;
    if (event.repeat) event.preventDefault();
    else ignoreClick = false;
  });
  const reaction = el('p', { className: 'narrator-reaction', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', hidden: '' });
  const aside = el('aside', { className: 'narrator', 'aria-label': '案内役の言葉' },
    el('div', { className: 'portrait-wrap' }, portrait, reaction),
    el('div', { className: 'narrator-dialogue' },
      el('p', { className: 'narrator-tag' }, '本日の案内役'),
      el('p', { className: 'narrator-name' }),
      el('p', { className: 'narrator-line' }, line)));
  updateNarrator(aside, mood);
  return aside;
}

function stage(mood, line, content, screen) {
  return el('div', { className: 'stage', 'data-screen': screen }, narrator(mood, line),
    el('section', { className: 'scene', 'aria-label': presentation.site_title }, ...content));
}

function title(text, className = 'screen-title') {
  return el('h1', { className, tabindex: '-1', 'data-focus': '' }, text);
}

function currentResult() {
  return session.state.pendingResult || session.state.resultHistory.at(-1);
}

function reset() {
  if (session.state.started && !window.confirm('今回の回答と紹介履歴を消して、最初から遊びますか？')) return;
  storage.clear();
  narratorStorage.clear();
  narratorInteraction.reset();
  recordMetric('reset');
  noticeText = '';
  session = new QuizSession(data, presentation);
  questionPortraits.reset();
  persist();
  go('#/start');
}

function welcome() {
  const content = [el('p', { className: 'eyebrow' }, `Kakuseigar · ${presentation.site_title}`),
    title('お探しのお話は、\nどんなお話？', 'intro-title'),
    el('p', { className: 'lede' }, '笑いたい日も、少し考えたい日も。\nあなたの気分に合いそうな一作を、青娥がご案内します。'),
    el('div', { className: 'intro-meta' }, el('span', {}, `まずは${data.rules.first_normal_result_after}問、時々寄り道`), el('span', {}, '気になる答えを選ぶだけ'))];
  if (!data.works.length) content.push(el('p', { className: 'empty-state' }, 'ただいま、お話の案内を準備しています。'));
  else if (session.state.started) {
    content.push(el('div', { className: 'button-row welcome-actions' },
      button('続きからお話しする →', () => go(activeRoute())),
      el('a', { href: '#/stats', className: 'secondary-button' }, 'みんなへのお薦め'),
      button('最初から遊ぶ', reset, 'text-button')));
  } else {
    const token = session.state.activeStepId;
    content.push(el('div', { className: 'button-row welcome-actions' }, button('青娥に聞いてもらう →', () => action(t => {
      session.start(t);
      recordMetric('start', session.state);
    }, token, { replace: false })), el('a', { href: '#/stats', className: 'secondary-button' }, 'みんなへのお薦め')));
  }
  content.push(el('p', { className: 'intro-note' }, 'ご紹介するのは、pixivで読める東方二次創作小説です。'));
  return stage('idle', 'お探しのお話があるのでしょう？\n少し聞かせてくださいな。', content, 'welcome');
}

function question() {
  const q = session.currentQuestion();
  if (!q) return stage('idle', '少々お待ちくださいな。', [title('続きをご案内します。')], 'question');
  const token = session.state.activeStepId;
  const progress = el('div', { className: 'progress-track', role: 'progressbar', 'aria-label': '今回の質問の進み具合', 'aria-valuemin': 0, 'aria-valuemax': q.roundTotal, 'aria-valuenow': q.ordinal - 1 },
    el('span', { className: 'progress-fill', style: `width:${(q.ordinal - 1) / q.roundTotal * 100}%` }));
  const options = el('div', { className: 'options', 'aria-label': '回答をひとつ選ぶ' }, ...q.options.map((o, index) =>
    button('', () => action(t => { session.answer(o.id, t); recordMetric('questionAction', 'answer'); }, token), 'option-button', { 'data-option': o.id })));
  [...options.children].forEach((node, index) => node.append(el('span', { className: 'option-letter', 'aria-hidden': 'true' }, String.fromCharCode(65 + index)), el('span', {}, q.options[index].text)));
  const tools = el('div', { className: 'question-tools' });
  if (q.allowSkip) tools.append(button('今は決められない', () => action(t => { session.answer(null, t); recordMetric('questionAction', 'skip'); }, token), 'text-button'));
  if (q.canUndo) tools.append(button('ひとつ前の回答を直す', () => action(t => { session.undo(t); recordMetric('questionAction', 'undo'); }, token), 'text-button'));
  const content = [el('div', { className: 'progress-row' }, el('p', { className: 'eyebrow' }, session.state.round.number === 1 ? 'まずは、お話を少し' : 'もう少し聞かせてください'),
    el('p', { className: 'question-count' }, `${q.ordinal} / ${q.roundTotal} 問目`)), progress, title(q.text, 'question-title'), options, tools];
  const count = session.state.resultHistory.length;
  const line = count === 0 ? '思いつくままで結構ですよ。\nさて、どちらがお好みかしら。' : count < 3 ? 'では、もう少し伺いましょうか。' : 'ふふ、まだお探しのものが\nありそうですね。';
  const mood = questionPortraits.forQuestion(`question:${session.state.round.number}:${q.id}`);
  return stage(mood, line, content, 'question');
}

function favorite() {
  const id = session.state.favoriteCharacterId;
  const char = data.works.flatMap(w => w.characters).find(c => c.id === id);
  const token = session.state.activeStepId;
  const own = id === presentation.narrator.id;
  const choices = [['yes', 'はい、見たい'], ['no', 'いいえ、質問を続ける'], ['unknown', 'まだわからない']];
  const mood = questionPortraits.forQuestion(`favorite:${session.state.round.number}:${id}`);
  return stage(mood, own ? 'そういえば、\n私のお話はいかがかしら。' : 'そういえば、\nこんな方のお話もありますよ。', [
    el('p', { className: 'eyebrow' }, '少しだけ、寄り道'), title(own ? '私の活躍が\n見たいのかしら？' : `${char?.name || 'この方'}の活躍を\n見てみたい？`),
    el('div', { className: 'options' }, ...choices.map(([answer, label], index) => {
      const choice = button('', () => action(t => { session.answerFavorite(answer, t); recordMetric('questionAction', 'favorite_answer'); }, token), 'option-button', { 'data-favorite-answer': answer });
      choice.append(el('span', { className: 'option-letter', 'aria-hidden': 'true' }, String.fromCharCode(65 + index)), el('span', {}, label));
      return choice;
    }))], 'favorite');
}

function caption(work) {
  if (!work.author_caption) return el('p', { className: 'fine-print' }, '作品の紹介文・本文は、pixivでご覧いただけます。');
  const paragraphs = work.author_caption.split(/\n\s*\n/).filter(Boolean);
  // Preserve supplied captions verbatim, including any notices. No automatic summary.
  return el('div', { className: 'caption' }, el('p', { className: 'caption-label' }, '作者による紹介'), ...paragraphs.map(p => el('p', {}, p)));
}

function openRankedWork(workId, { period, trigger } = {}) {
  const work = data.works.find(item => item.id === workId);
  if (!work || !['recent', 'all_time'].includes(period) || document.querySelector('dialog[open]')) return;
  const dialog = el('dialog', { className: 'dialog ranking-work-dialog', 'aria-labelledby': 'ranking-work-title' });
  const close = button('閉じる ×', () => dialog.close(), 'text-button ranking-work-close', { autofocus: '' });
  const copy = el('div', { className: 'ranking-work-copy' },
    el('h2', { id: 'ranking-work-title' }, work.title),
    caption(work),
    el('div', { className: 'ranking-work-actions' },
      workLink(work, period === 'recent' ? 'ranking_recent' : 'ranking_all_time'),
      el('p', { className: 'fine-print' }, '新しいタブで開きます')),
  );
  const content = el('div', { className: 'ranking-work-content' });
  const art = presentation.work_art_by_work?.[work.id];
  if (typeof art?.preview === 'string' && /^assets\/works\/[0-9]+-preview\.webp$/.test(art.preview)) {
    const image = el('img', { className: 'ranking-work-image', src: new URL('../' + art.preview, import.meta.url),
      alt: art.alt || `『${work.title}』のイメージ画`, width: art.width, height: art.height, decoding: 'async' });
    content.classList.add('has-art');
    image.addEventListener('error', () => { image.remove(); content.classList.remove('has-art'); });
    content.append(image);
  }
  content.append(copy);
  dialog.append(el('div', { className: 'ranking-work-heading' },
    el('p', { className: 'eyebrow' }, '作品のご紹介'), close), content);
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
  const closeOnNavigation = () => dialog.close();
  window.addEventListener('hashchange', closeOnNavigation);
  dialog.addEventListener('close', () => {
    window.removeEventListener('hashchange', closeOnNavigation);
    document.body.classList.remove('has-ranking-dialog');
    dialog.remove();
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  document.body.classList.add('has-ranking-dialog');
}

function workIllustration(work) {
  const art = presentation.work_art_by_work?.[work.id];
  if (!art || ![art.preview, art.full].every(path => typeof path === 'string'
    && /^assets\/[a-zA-Z0-9_./-]+\.(png|webp|jpe?g)$/.test(path) && !path.includes('..'))) return null;
  const image = el('img', { src: new URL('../' + art.preview, import.meta.url),
    alt: art.alt, width: art.width, height: art.height, decoding: 'async' });
  const trigger = button('', () => openWorkArt(work, art, trigger), 'work-art',
    { 'aria-label': `『${work.title}』のイメージ画を大きく見る`, 'aria-haspopup': 'dialog' });
  trigger.append(image, el('span', { className: 'work-art-hint', 'aria-hidden': 'true' }, '絵を大きく見る ＋'));
  image.addEventListener('error', () => {
    trigger.closest('.work-preview')?.classList.remove('has-art');
    trigger.remove();
  });
  return trigger;
}

function openWorkArt(work, art, trigger) {
  const dialog = el('dialog', { className: 'dialog art-dialog', 'aria-labelledby': 'art-dialog-title' });
  const close = button('閉じる ×', () => dialog.close(), 'text-button art-dialog-close', { autofocus: '' });
  const image = el('img', { className: 'art-dialog-image', src: new URL('../' + art.full, import.meta.url),
    alt: art.alt, width: art.width, height: art.height, decoding: 'async' });
  image.addEventListener('error', () => image.replaceWith(el('p', { role: 'status' }, '画像を読み込めませんでした。閉じて、もう一度お試しください。')));
  dialog.append(el('div', { className: 'art-dialog-heading' }, el('h2', { id: 'art-dialog-title' }, work.title), close), image);
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger.isConnected) trigger.focus({ preventScroll: true }); });
  document.body.append(dialog);
  dialog.showModal();
}

function resultView(result, historical) {
  const work = data.works.find(w => w.id === result.workId);
  const token = session.state.activeStepId;
  const castIds = presentation.public_cast_by_work[work.id] || [];
  const cast = work.characters.filter(c => castIds.includes(c.id));
  const art = workIllustration(work);
  const content = [el('div', { className: 'result-heading' }, el('p', { className: 'eyebrow' }, historical ? 'これまでのお薦め' : 'こちらのお話はいかが？'),
    el('span', { className: 'result-index' }, `${String(result.introducedCount).padStart(2, '0')} / ${String(result.totalWorks).padStart(2, '0')}`)),
    el('article', { className: 'work-card' }, el('p', { className: 'work-number' }, 'あなたに差し出す、一編'), title(work.title, 'work-title'),
      el('div', { className: `work-preview${art ? ' has-art' : ''}` }, art,
        el('div', { className: 'work-invitation' }, result.reason ? el('p', { className: 'reason' }, result.reason) : null,
          workLink(work, historical ? 'history' : 'result', result), el('p', { className: 'fine-print' }, '新しいタブで開きます')), caption(work)),
      publicStats?.footprint(work.id),
      cast.length ? el('div', { className: 'chip-list', 'aria-label': '登場人物' }, ...cast.map(c => el('span', { className: 'chip' }, c.name))) : null)];
  if (result.isLast) content.push(el('div', { className: 'completion' },
    el('div', { role: 'status' }, el('strong', {}, '制覇おめでとう！'), el('p', {}, `公開${result.totalWorks}作品をご案内しました。`)),
    button('全作品紹介を共有', event => shareCompletion(result.totalWorks, presentation.site_url, event.currentTarget), 'secondary-button', { 'aria-haspopup': 'dialog' })));
  if (!historical) content.push(button('いいえ、もう少し探す →', () => action(t => session.decline(t), token), 'secondary-button'));
  else content.push(button('今の案内に戻る', () => go(activeRoute()), 'secondary-button'));
  content.push(el('div', { className: 'result-actions' }, button('この結果を共有', event => shareWork(work, presentation.site_url, event.currentTarget), 'text-button', { 'aria-haspopup': 'dialog' }),
    button('これまでのお薦め', () => openHistory(), 'text-button')));
  return { node: stage(result.isLast ? 'celebrate' : 'recommend', result.lead || 'こちらのお話はいかが？', content, 'result'), castIds: cast.map(c => c.id) };
}

function openHistory() {
  historyReturn = activeRoute();
  go('#/history');
}

function historyView() {
  return stage('idle', '気になったお話は、\nいつでもこちらから。', [el('p', { className: 'eyebrow' }, 'BOOKMARKS'), title('これまでのお薦め'),
    el('p', { className: 'lede' }, `この回でご紹介した${session.state.resultHistory.length}作品です。`),
    el('ol', { className: 'history-list' }, ...session.state.resultHistory.map(result => {
      const work = data.works.find(w => w.id === result.workId);
      return el('li', { className: 'history-item' }, el('span', { className: 'work-number', 'aria-hidden': 'true' }, String(result.introducedCount).padStart(2, '0')),
        el('div', {}, button(work.title, () => go('#/review/' + result.resultId), 'history-title'),
          workLink(work, 'history', result, 'text-button')));
    })),
    !session.state.resultHistory.length ? el('p', { className: 'empty-state' }, 'お薦めのお話が、ここに並んでいきます。') : null,
    button('今の案内に戻る', () => go(historyReturn === '#/start' ? '#/start' : activeRoute()), 'secondary-button')], 'history');
}

function ending() {
  return stage('ending', '……手札は、全部出しましたわ。', [el('p', { className: 'eyebrow' }, 'お話の、その先へ'), title('そんなものないから\n読みたい作品を\nDMしなさい'),
    el('p', { className: 'lede' }, 'ここまでお付き合いいただき、ありがとうございます。\nまだ見つからないお話は、作者に聞かせてください。'),
    data.author_x_url ? externalLink('作者のXを開く', data.author_x_url) : el('p', { className: 'fine-print' }, '作者へのリンクは、ただいま準備中です。'),
    button('これまでのお薦めを見返す', openHistory, 'secondary-button'), button('最初から遊ぶ', reset, 'text-button')], 'ending');
}

function about() {
  return stage('idle', 'お話との出会いを、\n少しだけお手伝いいたします。', [el('p', { className: 'eyebrow' }, 'ABOUT'), title('この案内について'),
    el('p', { className: 'lede' }, '質問への答えから、好みに合いそうな東方二次創作小説をご紹介する、小さな遊びです。'),
    el('p', {}, '本アプリは、東方Projectの非公式の二次創作です。原作：東方Project（上海アリス幻樂団／ZUN）。'),
    externalLink('東方Projectの二次創作ガイドライン', 'https://touhou-project.news/guideline/', 'text-button'),
    el('p', {}, 'あなたの人格や、似ているキャラクターを判定するものではありません。読みたい場面や、つい選んでしまう考え方から、お話の入口を探します。'),
    el('p', {}, '作品はpixivでお読みいただけます。「いいえ」で別のお話を探せますし、前に薦められた作品も紹介履歴から見返せます。'),
    el('p', { className: 'fine-print' }, '回答と進行はこのブラウザーのタブ内に保存します。タブを閉じた後の再開は保証されません。外部リンクを開くと各サービスへ移動します。'),
    el('p', { className: 'fine-print' }, '案内の改善と公開集計のため、Google アナリティクスを使用します。訪問情報、案内の開始、紹介した作品と順番、本文リンクの利用、問数やスキップ数などの概要を送信します。選んだ回答の内容や回答履歴一式は送信しません。質問の操作はタブ内で集計し、作品紹介の際に概要をまとめます。'),
    el('p', { className: 'fine-print' }, 'Google アナリティクスはCookieなどを使って訪問を集計します。公開するのは訪問回数と、各回で最初に紹介した作品の集計です。人数・読了数・作品の評価を示すものではなく、計測できた範囲の記録です。'),
    externalLink('Googleによるデータの利用について', 'https://policies.google.com/technologies/partner-sites?hl=ja', 'text-button'),
    button(analytics?.enabled ? 'このブラウザーでのアクセス解析を停止する' : 'このブラウザーでのアクセス解析を有効にする', () => {
      analytics?.setEnabled(!analytics.enabled);
      render({ preserveScroll: true });
    }, 'text-button'),
    el('p', { className: 'fine-print', role: 'status' },
      `アクセス解析は${analytics?.enabled ? '有効' : '停止中'}です。` +
      (analytics?.preferenceScope === 'page' ? '設定を保存できないため、このページを開いている間だけ有効です。' :
        analytics?.preferenceScope === 'tab' ? '設定はこのタブの間だけ保存されます。' : '')),
    el('div', { className: 'button-row' }, button('案内に戻る', () => go(activeRoute()), 'secondary-button'))], 'about');
}

function statistics() {
  return stage('idle', 'これまで、どんなお話を\nお渡ししてきたでしょうね。', [
    el('div', { className: 'stats-screen-heading' }, title('みんなへのお薦め'),
      button('案内に戻る', () => go(activeRoute()), 'text-button')),
    publicStats?.rankings(),
  ], 'statistics');
}

function robotAchievement() {
  return stage('idle', '…………。', [
    el('p', { className: 'eyebrow' }, '思わぬ実績'), title(`${robotName()}を\n爆破してしまった！`),
    el('p', { className: 'lede' }, 'お話を選びに来たはずなのに……。\n少し、寄り道が過ぎたようです。'),
    el('div', { className: 'achievement-actions' },
      button('爆破の実績を共有', event => shareRobot(robotName(), presentation.site_url, event.currentTarget), 'secondary-button', { 'aria-haspopup': 'dialog' }),
      button('青娥を呼び戻して案内を続ける', () => {
        const route = narratorInteraction.resume();
        persistNarrator();
        go(route || activeRoute(), true, { preserveScroll: true });
      })),
    el('p', { className: 'fine-print' }, 'ここまでの回答と、ご紹介した作品はそのままです。')], 'robot-achievement');
}

function render(viewOptions = {}) {
  if (!session) return;
  let route = location.hash || activeRoute();
  const robotFinished = narratorInteraction.actor === 'broken';
  if (robotFinished) {
    route = '#/achievement/robot'; history.replaceState(null, '', route);
  } else if (route === '#/achievement/robot') {
    route = activeRoute(); history.replaceState(null, '', route);
  }
  if (!robotFinished && session.state.phase === 'favorite' && !['#/favorite', '#/history', '#/about', '#/stats'].includes(route) && !route.startsWith('#/review/')) {
    route = activeRoute(); history.replaceState(null, '', route);
  }
  if (['#/play', '#/favorite', '#/characters', '#/ending'].includes(route)) {
    const allowed = route === activeRoute();
    if (!allowed) { route = activeRoute(); history.replaceState(null, '', route); }
  }
  let node, shownResult, castIds = [];
  if (robotFinished) node = robotAchievement();
  else if (route.startsWith('#/result/') || route.startsWith('#/review/')) {
    const id = route.split('/').at(-1);
    const result = [session.state.pendingResult, ...session.state.resultHistory].find(r => r?.resultId === id);
    if (result) {
      const historical = route.startsWith('#/review/') || session.state.phase !== 'result' || currentResult()?.resultId !== id;
      const view = resultView(result, historical); node = view.node; castIds = view.castIds;
      if (!historical && session.state.pendingResult) shownResult = result;
    } else { history.replaceState(null, '', activeRoute()); return render(viewOptions); }
  } else if (route === '#/history') node = historyView();
  else if (route === '#/favorite') node = favorite();
  else if (route === '#/ending') node = ending();
  else if (route === '#/about') node = about();
  else if (route === '#/stats') node = statistics();
  else if (route === '#/play') node = question();
  else node = welcome();
  app.replaceChildren(node);
  // State only records a recommendation after its actual card is attached.
  if (shownResult) {
    session.commitResult(shownResult.resultId, session.state.activeStepId);
    persist();
    recordMetric('recommend', shownResult);
    // Buttons were built with the preceding token; rebuild with the committed step.
    return render(viewOptions);
  }
  if (node.dataset.screen === 'question') {
    recordMetric('questionShown', `ordinary:${session.state.round.number}:${session.currentQuestion()?.id}`, 'ordinary');
  } else if (node.dataset.screen === 'favorite') {
    recordMetric('questionShown', `favorite:${session.state.round.number}:${session.state.favoriteCharacterId}`, 'favorite');
  }
  const introduced = robotFinished ? [] : [presentation.narrator.id, ...castIds,
    ...(route === '#/favorite' && session.state.phase === 'favorite' ? [session.state.favoriteCharacterId] : [])];
  const novelIds = introduced.filter(id => !session.state.introducedCharacterIds.includes(id));
  if (novelIds.length) {
    session.introduceCharacters(novelIds, session.state.activeStepId);
    persist();
    return render(viewOptions);
  }
  document.querySelectorAll('[data-action="history"]').forEach(b => {
    b.disabled = !session.state.resultHistory.length;
    b.setAttribute('aria-label', `これまでのお薦め（${session.state.resultHistory.length}作品）`);
  });
  updateNotice();
  const heading = app.querySelector('[data-focus]');
  heading?.focus({ preventScroll: true });
  if (!viewOptions.preserveScroll && viewOptions.scrollToQuestion && window.matchMedia('(max-width: 820px)').matches
      && ['question', 'favorite'].includes(node.dataset.screen)) {
    // Keep the large portrait available above, but bring the next question into view.
    node.querySelector('.scene').scrollIntoView({
      block: 'start',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
  } else if (!viewOptions.preserveScroll) {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  document.title = `Kakuseigar — ${presentation.site_title}`;
}

async function load() {
  try {
    const responses = await Promise.all(['runtime', 'presentation'].map(name => fetch(new URL(`../data/${name}.json`, import.meta.url), { cache: 'no-cache' })));
    if (responses.some(r => !r.ok)) throw new Error('Data unavailable');
    const texts = await Promise.all(responses.map(r => r.text()));
    data = JSON.parse(texts[0]); presentation = JSON.parse(texts[1]);
    validateRuntime(data);
    questionPortraits = new QuestionPortraits(presentation.narrator.question_moods);
    presentation.dataset_version += ':' + fingerprint(texts.join('\n'));
    const saved = storage.read();
    let restored = Boolean(saved);
    try { session = new QuizSession(data, presentation, { state: saved }); }
    catch {
      restored = false;
      noticeText = '案内内容が更新されたか、前回の記録を読み込めませんでした。新しくお話を始められます。';
      session = new QuizSession(data, presentation);
    }
    if (!restored) narratorStorage.clear();
    narratorInteraction = new NarratorInteraction({ datasetVersion: presentation.dataset_version, saved: restored ? narratorStorage.read() : null });
    persistNarrator();
    analytics ||= createAnalytics({ ...ANALYTICS_CONFIG, datasetVersion: presentation.dataset_version,
      workIds: data.works.map(work => work.id) });
    recordMetric('sync', session.state);
    publicStats ||= createPublicStats({ works: data.works, workArtByWork: presentation.work_art_by_work,
      onWorkSelect: openRankedWork });
    document.querySelector('#visit-counter').replaceChildren(publicStats.counter());
    if (!location.hash || (!['#/about', '#/stats'].includes(location.hash) && !session.state.started)) history.replaceState(null, '', activeRoute());
    render();
    void publicStats.load();
  } catch (error) {
    console.error('Unable to start the guide', error);
    app.replaceChildren(el('section', { className: 'scene empty-state' }, title('案内を読み込めませんでした'),
      el('p', {}, '通信を確かめて、もう一度お試しください。'), button('もう一度読み込む', load)));
  }
}

document.querySelector('.skip-link')?.addEventListener('click', event => { event.preventDefault(); app.focus(); });
document.querySelector('#footer')?.append(el('span', { className: 'footer-brand' }, 'Kakuseigar'),
  el('nav', { className: 'footer-links', 'aria-label': '案内メニュー' },
    button('これまでのお薦め', () => session && openHistory(), 'footer-button', { 'data-action': 'history', disabled: true }),
    el('a', { href: '#/about', className: 'footer-button' }, 'このサイトについて'),
    el('a', { href: '#/stats', className: 'footer-button' }, 'みんなへのお薦め'),
    button('最初から遊ぶ', () => session && reset(), 'footer-button')));
window.addEventListener('hashchange', () => { try { render(); } catch { go(activeRoute(), true); } });
window.addEventListener('popstate', () => { if (session) render(); });
load();
