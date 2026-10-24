const hashtags = '#青娥の小説案内 #東方Project';
let dialogSequence = 0;

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required.`);
  return value;
}

// Shared links always lead to the public entrance, not this tab's result IDs.
export function buildWorkShareText(work, siteUrl) {
  const title = requireText(work?.title, 'A work title');
  return `青娥に薦められたお話は\n『${title}』でした。\n\nあなたにはどんなお話が出るでしょう？\n${hashtags}\n${requireText(siteUrl, 'The site URL')}`;
}

export function buildCompletionShareText(totalWorks, siteUrl) {
  if (!Number.isSafeInteger(totalWorks) || totalWorks <= 0) throw new RangeError('The total work count must be a positive integer.');
  return `青娥の小説案内を制覇！\n全${totalWorks}作品を紹介してもらいました。\n\nあなたにはどんなお話が出るでしょう？\n${hashtags}\n${requireText(siteUrl, 'The site URL')}`;
}

export function buildRobotShareText(robotName, siteUrl) {
  const name = requireText(robotName, 'A robot name');
  return `青娥の小説案内で、${name}を爆破してしまいました。\nお話を選びに来たはずなのに……。\n\n${hashtags}\n${requireText(siteUrl, 'The site URL')}`;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function button(text, className, onClick, attrs = {}) {
  const node = el('button', { type: 'button', className, ...attrs }, text);
  node.addEventListener('click', onClick);
  return node;
}

function shareDialog(text, heading, description, trigger) {
  const xUrl = new URL('https://x.com/intent/tweet');
  xUrl.searchParams.set('text', text);
  const titleId = `share-dialog-title-${++dialogSequence}`;
  const dialog = el('dialog', { className: 'dialog share-dialog', 'aria-labelledby': titleId });
  const field = el('textarea', { className: 'share-text', rows: 7, readonly: '', 'aria-label': '共有文', spellcheck: 'false' }, text);
  const status = el('p', { className: 'share-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const copy = button('共有文をコピー', 'secondary-button', async () => {
    copy.disabled = true;
    status.textContent = '';
    try {
      await navigator.clipboard.writeText(text);
      if (dialog.isConnected && dialog.open) status.textContent = '共有文とリンクをコピーしました。';
    } catch {
      if (!dialog.isConnected || !dialog.open) return;
      field.focus();
      field.select();
      field.setSelectionRange(0, field.value.length);
      status.textContent = '共有文を選択しました。端末のコピー操作でコピーしてください。';
    } finally {
      if (dialog.isConnected && dialog.open) copy.disabled = false;
    }
  });
  const xLink = el('a', { href: xUrl.href, className: 'primary-button', target: '_blank', rel: 'noopener noreferrer' }, 'Xで共有',
    el('span', { 'aria-hidden': 'true' }, ' ↗'), el('span', { className: 'sr-only' }, '（新しいタブで開きます）'));
  dialog.append(
    el('div', { className: 'share-heading' }, el('h2', { id: titleId }, heading),
      button('閉じる ×', 'text-button share-close', () => dialog.close(), { autofocus: '' })),
    el('p', { className: 'share-description' }, description), field,
    el('div', { className: 'button-row share-actions' }, xLink, copy), status);
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

export function shareWork(work, siteUrl, trigger) {
  return shareDialog(buildWorkShareText(work, siteUrl), 'この一編をおすそわけ', '作品名と、「青娥の小説案内」へのリンクを共有します。', trigger);
}

export function shareCompletion(totalWorks, siteUrl, trigger) {
  return shareDialog(buildCompletionShareText(totalWorks, siteUrl), '全作品紹介の実績を共有', '全作品を紹介してもらった実績と、「青娥の小説案内」へのリンクを共有します。', trigger);
}

export function shareRobot(robotName, siteUrl, trigger) {
  return shareDialog(buildRobotShareText(robotName, siteUrl), '爆破の実績を共有', 'ロボを爆破した実績と、「青娥の小説案内」へのリンクを共有します。', trigger);
}
