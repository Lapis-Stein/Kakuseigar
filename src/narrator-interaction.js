const STATE_VERSION = 1;

export const NARRATOR_THRESHOLDS = Object.freeze({ robot: 40, broken: 100 });

export const NARRATOR_DIALOGUE_POOLS = Object.freeze({
  1: Object.freeze([
    'あら、何か御用かしら？',
    'はいはい、聞いておりますよ。',
    'そんなに気になります？',
  ]),
  2: Object.freeze([
    '私より、お話の方をご覧になって？',
    'お話も、あなたをお待ちですよ。',
    'さて、どんなお話にいたしましょう。',
  ]),
  3: Object.freeze([
    '……お話を選びにいらしたのよね？',
    'ご挨拶は、もう十分いただきましたよ。',
    'そちらの選択肢も押せるのですけれど。',
  ]),
  4: Object.freeze([
    'ずいぶん、お暇なのねえ。',
    'あらあら、まだ続けますの？',
    '私にも、ひと休みさせてくださる？',
  ]),
  robot: Object.freeze([
    'ゴヨウヲ、オウカガイ、イタシマス。',
    'オハナシヲ、ゴアンナイシマス。',
    'ゴユックリ、オエラビクダサイ。',
  ]),
});

export const NARRATOR_HANDOFF_LINE = 'では、ごゆっくり。後はよろしくね。';
export const NARRATOR_BROKEN_LINE = '……あら。お話を選ぶまで持ちませんでしたか。';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeRoute = (route) => typeof route === 'string'
  && route === route.trim()
  && /^#\/(?:start|play|favorite|history|about|ending|(?:result|review)\/result-[1-9]\d*(?:\/(?:answers|work))?)$/.test(route)
  ? route : null;

/** Independent of recommendation progress, browser storage and rendering. */
export class NarratorInteraction {
  constructor({ datasetVersion, saved = null, random = Math.random } = {}) {
    if (typeof datasetVersion !== 'string' || datasetVersion.length === 0) {
      throw new Error('A dataset version is required.');
    }
    this.datasetVersion = datasetVersion;
    this.random = random;
    this.reset();
    if (isObject(saved)
      && saved.version === STATE_VERSION
      && saved.datasetVersion === datasetVersion
      && Number.isSafeInteger(saved.count)
      && saved.count >= 0 && saved.count <= NARRATOR_THRESHOLDS.broken
      && (saved.returnRoute === null || safeRoute(saved.returnRoute) !== null)
      && (saved.count === NARRATOR_THRESHOLDS.broken || saved.returnRoute === null)) {
      this.count = saved.count;
      this.returnRoute = saved.returnRoute;
    }
  }

  get actor() {
    if (this.count >= NARRATOR_THRESHOLDS.broken) return 'broken';
    return this.count >= NARRATOR_THRESHOLDS.robot ? 'robot' : 'seiga';
  }

  get level() {
    return this.count > 0 && this.actor === 'seiga' ? Math.floor(this.count / 10) + 1 : 0;
  }

  _pick(poolId) {
    const pool = NARRATOR_DIALOGUE_POOLS[poolId];
    const choices = pool.filter((line) => line !== this.lastLines.get(poolId));
    const value = this.random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new Error('Random values must be in [0, 1).');
    }
    const line = choices[Math.floor(value * choices.length)];
    this.lastLines.set(poolId, line);
    return line;
  }

  tap(route) {
    if (this.count === NARRATOR_THRESHOLDS.broken) return NARRATOR_BROKEN_LINE;
    this.count += 1;
    if (this.count === NARRATOR_THRESHOLDS.broken) {
      this.returnRoute = safeRoute(route);
      return NARRATOR_BROKEN_LINE;
    }
    if (this.count === NARRATOR_THRESHOLDS.robot) return NARRATOR_HANDOFF_LINE;
    return this._pick(this.actor === 'robot' ? 'robot' : this.level);
  }

  resume() {
    const route = this.returnRoute;
    this.reset();
    return route;
  }

  reset() {
    this.count = 0;
    this.returnRoute = null;
    this.lastLines = new Map();
  }

  exportState() {
    return {
      version: STATE_VERSION,
      datasetVersion: this.datasetVersion,
      count: this.count,
      returnRoute: this.returnRoute,
    };
  }
}
