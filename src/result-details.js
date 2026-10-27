/** Presentation only: opening details never advances or changes the diagnosis. */
export function createResultDetails({ data, presentation, result, insights, page, baseRoute,
  onRelatedWork = () => {}, documentRef = globalThis.document }) {
  const work = data.works.find(item => item.id === result.workId);
  if (!work || !['answers', 'work'].includes(page)) throw new RangeError('Unknown result details');
  const workMaximum = data.rules.profile_maxima?.taste ?? 4;

  function el(tag, attrs = {}, ...children) {
    const node = documentRef.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null) continue;
      if (key === 'className') node.className = value;
      else node.setAttribute(key, value);
    }
    node.append(...children.filter(child => child !== null && child !== undefined));
    return node;
  }

  function preview(item, { className = '', decorative = false, lazy = false } = {}) {
    const art = presentation.work_art_by_work?.[item.id];
    if (typeof art?.preview !== 'string' || !/^assets\/works\/[0-9]+-preview\.webp$/.test(art.preview)) return null;
    return el('img', { className, src: new URL('../' + art.preview, import.meta.url).href,
      alt: decorative ? '' : art.alt || `『${item.title}』のイメージ画`,
      width: art.width || 480, height: art.height || 720, decoding: 'async',
      loading: lazy ? 'lazy' : null });
  }

  function context() {
    const image = preview(work, { decorative: true });
    image?.addEventListener('error', () => image.remove(), { once: true });
    return el('div', { className: 'detail-context-row' }, image,
      el('div', { className: 'detail-context-copy' }, el('span', {}, 'この一作について'), el('p', {}, work.title)),
      el('a', { className: 'text-button detail-context-back', href: baseRoute }, '作品紹介に戻る'));
  }

  function nav(pane) {
    return el('nav', { className: 'detail-nav', 'aria-label': '詳細ページ' },
      ...[['answers', '01', '今回の関心'], ['work', '02', '作品の特徴']].map(([key, number, name]) =>
        el('a', { href: `${baseRoute}/${key}`, 'aria-current': pane === key ? 'page' : null },
          el('span', { className: 'number', 'aria-hidden': 'true' }, number), name)));
  }

  function chart(answers) {
    const maximum = answers ? insights.scale.maximum : workMaximum;
    const ticks = answers ? insights.scale.ticks : Array.from({ length: 5 }, (_, index) => maximum * index / 4);
    const label = answers ? (insights.hasInterests ? `関心の配分、目盛りは0から${maximum}パーセント` : '関心の配分、お返事待ち')
      : `作品の持ち味、0から${maximum}の目安`;
    return el('section', { className: 'profile-chart', 'aria-label': label },
      el('div', { className: 'chart-axis', 'aria-hidden': 'true' },
        el('span', { className: 'axis-label' }, '同じ7つの項目'),
        el('span', { className: 'ticks' }, ...ticks.map((value, index) =>
          el('span', {}, `${value}${answers && index === ticks.length - 1 ? '%' : ''}`))),
        el('span', { className: 'axis-label value-label' }, answers ? '配分' : '目安')),
      el('ul', { className: 'feature-list' }, ...insights.features.map(feature => {
        const value = answers ? feature.interest : feature.value;
        const noSignal = answers && (!insights.hasInterests || !feature.hasSignal);
        const spoken = answers ? (!insights.hasInterests ? 'お話の好みに関するお返事待ち'
          : noSignal ? '今回の回答では表れず' : `関心の配分 ${value}パーセント`)
          : `作品の持ち味の目安 ${value}、最大${maximum}`;
        const fill = el('span', { className: 'feature-fill' });
        fill.style.width = `${Math.max(0, Math.min(100, (value ?? 0) / maximum * 100))}%`;
        return el('li', { className: `feature-row${noSignal ? ' no-signal' : ''}`, 'aria-label': `${feature.label}：${spoken}` },
          el('span', { className: 'feature-name', 'aria-hidden': 'true' }, feature.label),
          el('span', { className: 'feature-meter', 'aria-hidden': 'true' }, fill),
          el('span', { className: 'feature-value', 'aria-hidden': 'true' }, noSignal ? '—' : String(value),
            noSignal ? null : el('small', {}, answers ? '%' : `/ ${maximum}`)));
      })));
  }

  function remark() {
    const labels = insights.remark.pair.flatMap((key, index) => [
      index ? el('span', { className: 'pair-cross', 'aria-hidden': 'true' }, '×') : null,
      el('span', {}, data.features.taste[key]),
    ]);
    return el('section', { className: 'detail-extra seiga-remark', 'aria-labelledby': 'result-remark-heading' },
      el('h2', { id: 'result-remark-heading' }, '青娥の勝手な見立て'),
      el('div', { className: 'remark-sheet' },
        labels.length ? el('div', { className: 'remark-pair' }, ...labels) : null,
        el('p', { className: 'remark-quote' }, insights.remark.text)));
  }

  function nearby() {
    const list = el('ul', { className: 'nearby-list' }, ...insights.relatedWorks.map(item => {
      const fallback = () => el('span', { className: 'nearby-placeholder', 'aria-hidden': 'true' }, 'お話');
      const image = preview(item, { decorative: true, lazy: true });
      const trigger = el('button', { type: 'button', className: 'nearby-book', 'data-related-work': item.id,
        'aria-haspopup': 'dialog', 'aria-label': `『${item.title}』の紹介を見る` },
      image || fallback(), el('span', { className: 'nearby-title' }, item.title),
      el('span', { className: 'nearby-arrow', 'aria-hidden': 'true' }, '›'));
      image?.addEventListener('error', () => image.replaceWith(fallback()), { once: true });
      trigger.addEventListener('click', () => onRelatedWork(item.id, { trigger }));
      return el('li', {}, trigger);
    }));
    return el('section', { className: 'detail-extra nearby-books', 'aria-labelledby': 'result-nearby-heading' },
      el('h2', { id: 'result-nearby-heading' }, '近い味わいのお話'),
      insights.relatedWorks.length ? list : el('p', { className: 'detail-description' }, 'ほかのお話が増えるまで、少しお待ちくださいな。'));
  }

  function pane(paneName) {
    const answers = paneName === 'answers';
    const description = answers ? (insights.hasInterests ? 'お返事の中で、どんなお話に心が向いたかを見てみます。'
      : 'お話の好みに関するお返事がまだないため、関心の配分はお休みです。')
      : 'この案内で捉えた、作品の持ち味を7つの項目でご紹介します。';
    return el('section', { className: 'scene detail-scene', 'data-detail-page': paneName,
      inert: page === paneName ? null : '', 'aria-hidden': page === paneName ? null : 'true' },
    context(), nav(paneName),
    el('div', { className: 'detail-heading' },
      el('h1', { tabindex: '-1', 'data-focus': '' }, answers ? '今回の関心' : 'この作品の特徴'),
      el('span', { className: 'detail-page-number', 'aria-hidden': 'true' }, answers ? '01 / 02' : '02 / 02')),
    el('p', { className: 'detail-description' }, description),
    el('div', { className: 'scale-explanation' },
      el('strong', {}, answers ? '関心の配分' : '作品の持ち味'),
      el('span', {}, answers ? (insights.hasInterests ? '7項目の合計で100%' : 'まだ表示できません') : `0〜${workMaximum}の目安`)),
    chart(answers), answers ? remark() : nearby(),
    el('div', { className: 'detail-bottom' },
      el('a', { className: 'text-button', href: baseRoute }, '← 作品紹介に戻る'),
      el('a', { className: 'detail-next', href: `${baseRoute}/${answers ? 'work' : 'answers'}` },
        answers ? '作品の特徴を見る' : '今回の関心を見る')));
  }

  return el('div', { className: 'detail-deck' }, pane('answers'), pane('work'));
}
