import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkShareText, buildCompletionShareText, buildRobotShareText } from '../src/sharing.js';

const siteUrl = 'https://lapis-stein.github.io/Kakuseigar/';

test('work sharing preserves the title and uses the public entrance without session details', () => {
  const work = { title: 'ある日、ある場所で。', resultId: 'result-7', reason: 'このタブだけの推薦理由' };
  const text = buildWorkShareText(work, siteUrl);
  assert.equal(text, '青娥に薦められたお話は\n『ある日、ある場所で。』でした。\n\nあなたにはどんなお話が出るでしょう？\n#青娥のお話案内 #東方Project\nhttps://lapis-stein.github.io/Kakuseigar/');
  assert.ok(!text.includes(work.resultId));
  assert.ok(!text.includes(work.reason));
});

test('completion sharing follows the current catalogue size and claims introductions, not reading', () => {
  for (const total of [1, 10, 37]) {
    const text = buildCompletionShareText(total, siteUrl);
    assert.ok(text.startsWith(`青娥のお話案内を制覇！\n全${total}作品を紹介してもらいました。`));
    assert.ok(!/読了|読破|読み終|読みました/.test(text));
    assert.ok(text.endsWith(`#青娥のお話案内 #東方Project\n${siteUrl}`));
  }
});

test('zero, missing and fractional work counts cannot produce a completion claim', () => {
  for (const total of [0, -1, 1.5, NaN, Infinity, undefined, null, '10', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildCompletionShareText(total, siteUrl), RangeError);
  }
});

test('robot sharing uses the configured name and remains separate from work completion', () => {
  for (const robotName of ['青娥ロボ', '芳香ちゃんロボ']) {
    const text = buildRobotShareText(robotName, siteUrl);
    assert.equal(text, `青娥のお話案内で、${robotName}を爆破してしまいました。\nお話を選びに来たはずなのに……。\n\n#青娥のお話案内 #東方Project\n${siteUrl}`);
    assert.ok(!text.includes('制覇'));
    assert.ok(!text.includes('全10作品'));
  }
});

test('builders reject missing public text rather than sharing undefined or empty labels', () => {
  for (const invalid of [undefined, null, '', '  ']) {
    assert.throws(() => buildWorkShareText({ title: invalid }, siteUrl), TypeError);
    assert.throws(() => buildRobotShareText(invalid, siteUrl), TypeError);
    assert.throws(() => buildWorkShareText({ title: '作品' }, invalid), TypeError);
    assert.throws(() => buildCompletionShareText(10, invalid), TypeError);
    assert.throws(() => buildRobotShareText('ロボ', invalid), TypeError);
  }
});
