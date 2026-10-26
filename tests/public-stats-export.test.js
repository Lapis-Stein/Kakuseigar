import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildReports, snapshotFromReports, fetchPublicStats, exportPublicStats, jstDate } from '../scripts/export-public-stats.mjs';

const now = new Date('2026-10-31T15:05:00Z');
const options = { accessToken: 'test-token-not-for-network', propertyId: '560779823',
  collectionStartedOn: '2026-10-26', workIds: ['01', '02'], now };
function report(recommendations, entries = []) {
  return {
    dimensionHeaders: recommendations ? [{ name: 'customEvent:work_id' }] : [],
    metricHeaders: [{ name: recommendations ? 'eventCount' : 'sessions', type: 'TYPE_INTEGER' }],
    rows: entries.map(item => recommendations ? { dimensionValues: [{ value: item[0] }], metricValues: [{ value: String(item[1]) }] }
      : { metricValues: [{ value: String(item) }] }),
    rowCount: entries.length, metadata: { timeZone: 'Asia/Tokyo' },
  };
}
function batch() { return { reports: [report(false, [3]), report(false, [40]),
  report(true, [['work_01', 1]]), report(true, [['work_01', 1]]), report(true, [['work_01', 9], ['work_02', 4]])] }; }
const response = payload => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('calendar periods are JST and the calendar month is clamped to collection start', () => {
  assert.equal(jstDate(now), '2026-11-01');
  const request = buildReports(options);
  assert.equal(request.requests.length, 5);
  assert.deepEqual(request.requests.map(row => row.dateRanges[0]), [
    { startDate: '2026-11-01', endDate: '2026-11-01' },
    { startDate: '2026-10-26', endDate: '2026-11-01' },
    { startDate: '2026-11-01', endDate: '2026-11-01' },
    { startDate: '2026-11-01', endDate: '2026-11-01' },
    { startDate: '2026-10-26', endDate: '2026-11-01' },
  ]);
  assert.equal(buildReports({ ...options, now: new Date('2026-10-30T00:00Z') }).requests[3].dateRanges[0].startDate, '2026-10-26');
  for (const date of ['2026-02-30', '2026-11-02', '2026-1-01', undefined]) {
    assert.throws(() => buildReports({ ...options, collectionStartedOn: date }));
  }
});

test('request is a single batch restricted to this site and initial recommendations', async () => {
  let calls = 0;
  await fetchPublicStats({ ...options, fetcher: async (url, init) => {
    calls++;
    assert.equal(url, 'https://analyticsdata.googleapis.com/v1beta/properties/560779823:batchRunReports');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${options.accessToken}`);
    const { requests } = JSON.parse(init.body);
    assert.equal(requests.length, 5);
    assert.ok(requests.every(req => req.dimensionFilter.andGroup.expressions.some(e => e.filter.fieldName === 'pageLocation' && e.filter.stringFilter.value === 'https://lapis-stein.github.io/Kakuseigar/')));
    for (const req of requests.slice(2)) {
      assert.ok(req.dimensionFilter.andGroup.expressions.some(e => e.filter.fieldName === 'customEvent:first_recommendation' && e.filter.stringFilter.value === 'yes'));
      assert.ok(req.dimensionFilter.andGroup.expressions.some(e => e.filter.fieldName === 'eventName' && e.filter.stringFilter.value === 'work_recommended'));
    }
    return response(batch());
  } });
  assert.equal(calls, 1);
});

test('snapshot projects only approved counts and fills known zero counts', () => {
  const payload = batch();
  payload.reports[4].rows.push({ dimensionValues: [{ value: 'unknown-work' }], metricValues: [{ value: '17' }], private: 'never publish' });
  payload.reports[4].rowCount++;
  payload.reports[0].private = 'never publish';
  const snapshot = snapshotFromReports({ ...options, reports: payload.reports });
  assert.deepEqual(snapshot.visits, { today: 3, all_time: 40 });
  assert.equal(snapshot.day, '2026-11-01');
  assert.equal(snapshot.month, '2026-11');
  assert.deepEqual(snapshot.first_recommendations.today, [{ work_id: '01', count: 1 }, { work_id: '02', count: 0 }]);
  assert.deepEqual(Object.keys(snapshot), ['schema_version', 'status', 'generated_at', 'time_zone', 'collection_started_on', 'day', 'month', 'visits', 'first_recommendations']);
  assert.doesNotMatch(JSON.stringify(snapshot), /unknown-work|never publish|test-token/);
});

test('prefixed Analytics IDs preserve leading zeroes and exclude unapproved aliases', () => {
  const entries = [['work_01', 2], ['work_1', 3], ['work_10', 4],
    ['01', 90], ['1', 90], ['work_001', 90], ['work_99', 90], ['Work_01', 90]];
  const reports = [report(false, [3]), report(false, [40]),
    report(true, entries), report(true, entries), report(true, entries)];
  const snapshot = snapshotFromReports({ ...options, workIds: ['01', '1', '10'], reports });
  const expected = [{ work_id: '01', count: 2 }, { work_id: '1', count: 3 }, { work_id: '10', count: 4 }];
  for (const period of ['today', 'month', 'all_time']) {
    assert.deepEqual(snapshot.first_recommendations[period], expected);
  }
  assert.doesNotMatch(JSON.stringify(snapshot), /work_01|work_001|work_99|Work_01/);
});

test('complete empty reports are zero, missing headers or results are failures', () => {
  const reports = [report(false), report(false), report(true), report(true), report(true)];
  delete reports[0].rows;
  delete reports[0].rowCount;
  assert.equal(snapshotFromReports({ ...options, reports }).visits.today, 0);
  assert.throws(() => snapshotFromReports({ ...options, reports: [] }));
  delete reports[0].metricHeaders;
  assert.throws(() => snapshotFromReports({ ...options, reports }));
});

test('metric diagnostics expose only bounded fixed schema labels and report kind', () => {
  for (const [index, type, kind, name] of [
    [0, 'TYPE_FLOAT', 'visits', 'sessions'],
    [2, 'TYPE_UNSPECIFIED', 'first_recommendations', 'eventCount'],
  ]) {
    const payload = batch();
    payload.reports[index].metricHeaders[0].type = type;
    assert.throws(() => snapshotFromReports({ ...options, reports: payload.reports }), {
      message: `Unexpected report metrics (${kind}): [{"name":"${name}","type":"${type}"}].`,
    });
  }
  const payload = batch();
  payload.reports[0].metricHeaders = Array.from({ length: 20 }, () => ({
    name: 'private-metric-identifier', type: options.accessToken,
    value: '987654321', arbitrary: 'private-response-value',
  }));
  assert.throws(() => snapshotFromReports({ ...options, reports: payload.reports }), error => {
    assert.match(error.message, /visits.*redacted.*additional headers omitted/);
    assert.doesNotMatch(error.message, /private|test-token|987654321/);
    assert.ok(error.message.length < 250);
    return true;
  });
});

test('restricted, sampled, truncated and wrong-timezone reports cannot replace counts', () => {
  const changes = [
    r => r.metadata.subjectToThresholding = true,
    r => r.metadata.dataLossFromOtherRow = true,
    r => r.metadata.samplingMetadatas = [{ samplesReadCount: '1', samplingSpaceSize: '2' }],
    r => r.metadata.dataTruncationReasons = [{}],
    r => r.metadata.schemaRestrictionResponse = { activeMetricRestrictions: [{}] },
    r => r.metadata.emptyReason = 'restricted',
    r => r.metadata.timeZone = 'America/Los_Angeles',
    r => r.rowCount++,
    r => r.dimensionHeaders[0].name = 'eventName',
    r => r.rows[0].dimensionValues[0].value = '(not set)',
    r => r.rows[0].metricValues[0].value = 'NaN',
    r => r.rows[0].metricValues[0].value = '-1',
    r => r.rows[0].metricValues[0].value = '9007199254740992',
    r => r.rows[0].metricValues = [],
    r => { r.rows.push(structuredClone(r.rows[0])); r.rowCount++; },
  ];
  for (const change of changes) {
    const payload = batch(); change(payload.reports[2]);
    assert.throws(() => snapshotFromReports({ ...options, reports: payload.reports }));
  }
});

test('API failures and malformed responses never reveal credentials or raw response text', async () => {
  const secret = 'raw-private-response';
  for (const fetcher of [
    async () => new Response(secret, { status: 403 }),
    async () => new Response(`{"reports":${secret}`),
    async () => { throw new Error(`${options.accessToken} ${secret}`); },
    async () => new Response('x'.repeat(1024 * 1024 + 1)),
  ]) {
    await assert.rejects(fetchPublicStats({ ...options, fetcher }), error => {
      assert.doesNotMatch(error.message, /test-token|raw-private-response/); return true;
    });
  }
});

test('missing configuration fails before any request', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return response(batch()); };
  for (const change of [{ accessToken: '' }, { propertyId: 'bad' }, { collectionStartedOn: 'tomorrow' }]) {
    await assert.rejects(fetchPublicStats({ ...options, ...change, fetcher }));
  }
  assert.equal(calls, 0);
});

test('atomic export preserves last good snapshot on partial batch failure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kakuseigar-stats-'));
  const outputPath = path.join(directory, 'public-stats.json');
  try {
    await writeFile(outputPath, 'last-good');
    const partial = batch(); partial.reports.pop();
    await assert.rejects(exportPublicStats({ ...options, outputPath, fetcher: async () => response(partial) }));
    assert.equal(await readFile(outputPath, 'utf8'), 'last-good');
    await exportPublicStats({ ...options, outputPath, fetcher: async () => response(batch()) });
    assert.equal(JSON.parse(await readFile(outputPath, 'utf8')).status, 'ready');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
