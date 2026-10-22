// Presentation state only: answers and recommendation scores never enter this helper.
export class QuestionPortraits {
  constructor(pool, { random = Math.random } = {}) {
    if (!Array.isArray(pool) || pool.length < 2 ||
        pool.some(id => typeof id !== 'string' || !id) || new Set(pool).size !== pool.length) {
      throw new TypeError('Question portraits need at least two distinct image IDs.');
    }
    this.pool = [...pool];
    this.random = random;
    this.reset();
  }

  forQuestion(screenKey) {
    if (typeof screenKey !== 'string' || !screenKey) throw new TypeError('A question screen key is required.');
    if (screenKey === this.lastKey) return this.lastPortrait;

    let portrait = this.assignments.get(screenKey);
    // Returning from history keeps the assignment. Revisiting a different question
    // keeps it too, except when that would repeat the immediately preceding image.
    if (!portrait || portrait === this.lastPortrait) {
      const candidates = this.pool.filter(id => id !== this.lastPortrait);
      const draw = this.random();
      if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new RangeError('Random draw must be in [0, 1).');
      portrait = candidates[Math.floor(draw * candidates.length)];
      this.assignments.set(screenKey, portrait);
    }
    this.lastKey = screenKey;
    this.lastPortrait = portrait;
    return portrait;
  }

  reset() {
    this.assignments = new Map();
    this.lastKey = null;
    this.lastPortrait = null;
  }
}
