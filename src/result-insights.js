import { Recommender } from './engine.js?v=20261025-1';

// These are presentation lines for the seven public taste features, not scores.
export const REMARK_DRAFTS = Object.freeze([
  { pair: ['banter', 'schemes'], text: '言葉の裏は気になるのに、黙って睨み合われると退屈してしまう。腹を探るついでに、気の利いた一言まで求めるのですから、相手も大変ですわね。' },
  { pair: ['banter', 'craft'], text: '難しいことは鮮やかに片づけて、会話はくだらなくあってほしい。……なかなか注文の多いお客さまですこと。' },
  { pair: ['banter', 'action'], text: '危ない場面でも、誰かが余計な口を挟むのを待っているのでしょう？　命の懸かった場面にまで笑いどころをお求めとは、読む側は気楽なものですわ。' },
  { pair: ['banter', 'warmth'], text: '仲のよさは、甘い言葉より遠慮のない軽口で確かめたいのね。ふふ、よそよそしく褒め合われるより、少しくらい雑に扱っている方が安心なさる。' },
  { pair: ['banter', 'reflection'], text: '笑って読み終えるつもりが、何気ない一言だけ後まで残ってしまう。……きっとお好きでしょう、あとから笑い方に困らせてくるお話は。' },
  { pair: ['banter', 'values'], text: '意見の違いは見たいけれど、お説教が始まると困ってしまうのね。譲れないことほど軽口に紛らせてほしいなんて、ずいぶん難しい注文ですこと。' },
  { pair: ['schemes', 'craft'], text: '勝ち負けだけでは満足せず、どこで何を仕込んだのかまで確かめたい。種明かしを待つそのお顔、見事に騙されたことを少し喜んでいませんこと？' },
  { pair: ['schemes', 'action'], text: '追い詰められた人を見ると、まだ隠している手があるはずだと期待なさる。逃げ道が塞がるほど身を乗り出すのですから、見物人は残酷ですわね。' },
  { pair: ['schemes', 'warmth'], text: '仲がよい二人にも、少しくらい腹の探り合いをしていてほしい。……人の団らんに、余計な期待をなさるのね。' },
  { pair: ['schemes', 'reflection'], text: '誰の思惑が通ったかは知りたいのに、それだけで片がつくと物足りない。上手くやった人にも、何か一つは持て余していてほしいのでしょうね。' },
  { pair: ['schemes', 'values'], text: '相手を丸め込む手際には感心するくせに、譲ってはいけない線も守ってほしい。ふふ、勝ち方にまで口を出したくなる、贅沢な観客ですこと。' },
  { pair: ['craft', 'action'], text: '立派な技を見せられると、もっと厄介な場面で試してみたくなるのでしょう？　使い手が苦労するほど腕前がよく見えるとは、困った楽しみ方ですわ。' },
  { pair: ['craft', 'warmth'], text: '見事な腕前も、誰か一人のために使われると余計に気になるのね。せっかくの大技より、その小さな一手間の方を覚えて帰るつもりでしょう。' },
  { pair: ['craft', 'reflection'], text: '仕組みが分かればすっきりする、とは限らないところがお好きなのね。見事な工夫のあとに残った小さな引っかかりまで、わざわざ拾って帰るのでしょう。' },
  { pair: ['craft', 'values'], text: '巧いやり方があれば、それでよいとは言ってくださらないのね。その腕前で何を選び、何をしなかったかまでご覧になるとは、名人にも気の抜けない客ですこと。' },
  { pair: ['action', 'warmth'], text: '窮地を切り抜けたら、誰と顔を見合わせるのかまで気になってしまう。ふふ、派手な大立ち回りも、その一瞬を待つための前置きにしてしまうのでしょう？' },
  { pair: ['action', 'reflection'], text: '窮地は切り抜けてほしいけれど、無事に終わるだけでは物足りない。……助かったあとまで、登場人物を休ませたくないのでしょう？' },
  { pair: ['action', 'values'], text: '勝てるなら何でもよい、とは思っていないのでしょう？　逃げ道より先に、何を曲げずに済むかを気にするなんて、登場人物には難儀なお客さまですわ。' },
  { pair: ['warmth', 'reflection'], text: '近づいた二人には喜びたいけれど、言えないことまで消えてしまうと物足りない。仲よくなった後にも、胸につかえるものを一つ残しておきたいのね。' },
  { pair: ['warmth', 'values'], text: '仲よくするなら、何でも頷けばよいわけではないのでしょう？　違うところは違うまま、それでも隣にいてほしいなんて、簡単には満足なさらないのね。' },
  { pair: ['reflection', 'values'], text: '選んだ道には筋を通してほしいのに、選ばなかった方も忘れずにいてほしい。……どちらか一つで済ませてあげないところ、なかなかお優しいことですわ。' },
].map(({ pair, text }) => Object.freeze({ pair: Object.freeze(pair), text })));

const pairKey = pair => [...pair].sort().join('|');
const remarksByPair = new Map(REMARK_DRAFTS.map(remark => [pairKey(remark.pair), remark]));
const undecidedRemark = () => ({ pair: [], text: 'あら、あちらにもこちらにも目が向いていらっしゃる。ひとことで見立てるには、少し欲張りなお客さまですこと。' });

function remarkFor(fields, values) {
  const ranked = fields.map(([key]) => ({ key, value: values?.[key] ?? 0 }))
    .filter(item => item.value > 0).sort((a, b) => b.value - a.value);
  if (ranked.length === 0) return { pair: [], text: 'まだ少し、お返事が足りませんわね。勝手なことを申すにも、もう少し材料をいただかなくては。' };
  if (ranked.length === 1) return { pair: [ranked[0].key], text: '今は、こちらにばかり目が向いていらっしゃるのね。ふふ、ほかのお話が割って入る隙もなさそうですこと。' };
  // Do not invent a second feature when several share the selection boundary.
  if (ranked[2] && Math.abs(ranked[1].value - ranked[2].value) < 1e-8) return undecidedRemark();
  const selected = remarksByPair.get(pairKey(ranked.slice(0, 2).map(item => item.key)));
  return selected ? { pair: [...selected.pair], text: selected.text } : undecidedRemark();
}

function percentages(values) {
  const sum = values.reduce((total, value) => total + value, 0);
  const rows = values.map((value, index) => {
    const exact = value / sum * 100;
    const whole = Math.floor(exact);
    return { index, whole, remainder: exact - whole };
  });
  const remaining = 100 - rows.reduce((total, row) => total + row.whole, 0);
  const ordered = [...rows].sort((a, b) => Math.abs(a.remainder - b.remainder) < 1e-10
    ? a.index - b.index : b.remainder - a.remainder);
  for (let index = 0; index < remaining; index++) ordered[index].whole += 1;
  return rows.map(row => row.whole);
}

function scaleFor(values) {
  const peak = Math.max(0, ...values);
  const step = [5, 10, 15, 20, 25].find(value => value * 4 >= peak) ?? 25;
  return { maximum: step * 4, ticks: Array.from({ length: 5 }, (_, index) => index * step) };
}

/** Read-only presentation of the answers available when this result was issued. */
export function createResultInsights({ data, answers, result } = {}) {
  if (!Array.isArray(answers) || !Number.isSafeInteger(result?.answerCount)
      || result.answerCount < 0 || result.answerCount > answers.length) {
    throw new RangeError('Invalid result answer boundary');
  }
  const work = data?.works?.find(item => item.id === result.workId);
  if (!work) throw new RangeError('Unknown result work');
  const fields = Object.entries(data.features.taste);
  const values = new Recommender(data).evidence(answers.slice(0, result.answerCount)).taste;
  const hasInterests = values !== null;
  const raw = fields.map(([key]) => values?.[key] ?? 0);
  const rounded = hasInterests ? percentages(raw) : fields.map(() => null);
  const features = fields.map(([key, label], index) => ({ key, label,
    interest: rounded[index], hasSignal: raw[index] > 0, value: work.taste[key] }));
  const relatedWorks = data.works.filter(item => item.id !== work.id)
    .map(item => ({ work: item, distance: fields.reduce((sum, [key]) => sum + Math.abs(item.taste[key] - work.taste[key]), 0) }))
    .sort((a, b) => a.distance - b.distance || (a.work.id < b.work.id ? -1 : a.work.id > b.work.id ? 1 : 0))
    .slice(0, 2).map(item => item.work);
  return { features, hasInterests, scale: scaleFor(rounded), remark: remarkFor(fields, values), relatedWorks };
}
