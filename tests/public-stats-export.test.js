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
  report(true, [['work_01', 6], ['work_02', 2]]), report(true, [['work_01', 1]]), report(true, [['work_01', 9], ['work_02', 4]]),
  report(true, [['work_01', 12], ['work_02', 3]]), report(true, [['work_01', 28], ['work_02', 17]])] }; }
const response = payload => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
function fetchBatches(payload = batch()) {
  let offset = 0;
  return async (_url, init) => {
    const length = JSON.parse(init.body).requests.length;
    const reports = payload.reports.slice(offset, offset + length);
    offset += length;
    return response({ reports });
  };
}

test('calendar periods are JST and the calendar month is clamped to collection start', () => {
  assert.equal(jstDate(now), '2026-11-01');
  const request = buildReports(options);
  assert.equal(request.requests.length, 7);
  assert.equal(request.recentStartedOn, '2026-10-26');
  assert.deepEqual(request.requests.map(row => row.dateRanges[0]), [
    { startDate: '2026-11-01', endDate: '2026-11-01' },
    { startDate: '2026-10-26', endDate: '2026-11-01' },
    { startDate: '2026-10-26', endDate: '2026-11-01' },
    { startDate: '2026-11-01', endDate: '2026-11-01' },
    { startDate: '2026-10-26', endDate: '2026-11-01' },
    { startDate: '2026-10-26', endDate: '2026-11-01' },
    { startDate: '2026-10-26', endDate: '2026-11-01' },
  ]);
  assert.equal(buildReports({ ...options, now: new Date('2026-10-30T00:00Z') }).requests[3].dateRanges[0].startDate, '2026-10-26');
  assert.equal(buildReports({ ...options, now: new Date('2026-10-26T00:00Z') }).recentStartedOn, '2026-10-26');
  assert.equal(buildReports({ ...options, now: new Date('2027-01-02T00:00Z') }).recentStartedOn, '2026-12-27');
  for (const date of ['2026-02-30', '2026-11-02', '2026-1-01', undefined]) {
    assert.throws(() => buildReports({ ...options, collectionStartedOn: date }));
  }
});

test('seven reports use two bounded batches with distinct recommendation and pixiv-click filters', async () => {
  const sizes = [], allRequests = [], fetcher = fetchBatches();
  await fetchPublicStats({ ...options, fetcher: async (url, init) => {
    assert.equal(url, 'https://analyticsdata.googleapis.com/v1beta/properties/560779823:batchRunReports');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${options.accessToken}`);
    const { requests } = JSON.parse(init.body);
    sizes.push(requests.length);
    allRequests.push(...requests);
    assert.ok(requests.every(req => req.dimensionFilter.andGroup.expressions.some(e => e.filter.fieldName === 'pageLocation' && e.filter.stringFilter.value === 'https://lapis-stein.github.io/Kakuseigar/')));
    return fetcher(url, init);
  } });
  assert.deepEqual(sizes, [5, 2]);
  for (const req of allRequests.slice(2, 5)) {
    assert.ok(req.dimensionFilter.andGroup.expressions.some(e => e.filter.fieldName === 'customEvent:first_recommendation' && e.filter.stringFilter.value === 'yes'));
    assert.ok(req.dimensionFilter.andGroup.expressions.some(e => e.filter.fieldName === 'eventName' && e.filter.stringFilter.value === 'work_recommended'));
  }
  for (const req of allRequests.slice(5)) {
    const expressions = req.dimensionFilter.andGroup.expressions;
    assert.ok(expressions.some(e => e.filter.fieldName === 'eventName' && e.filter.stringFilter.value === 'work_opened'));
    assert.ok(expressions.every(e => !['customEvent:first_recommendation', 'customEvent:link_source', 'customEvent:recommendation_context'].includes(e.filter.fieldName)));
  }
});

test('snapshot projects only approved counts and fills known zero counts', () => {
  const payload = batch();
  payload.reports[4].rows.push({ dimensionValues: [{ value: 'unknown-work' }], metricValues: [{ value: '17' }], private: 'never publish' });
  payload.reports[4].rowCount++;
  payload.reports[6].rows.push({ dimensionValues: [{ value: 'unknown-work' }], metricValues: [{ value: '17' }], private: 'never publish' });
  payload.reports[6].rowCount++;
  payload.reports[0].private = 'never publish';
  const snapshot = snapshotFromReports({ ...options, reports: payload.reports });
  assert.deepEqual(snapshot.visits, { today: 3, all_time: 40 });
  assert.equal(snapshot.day, '2026-11-01');
  assert.equal(snapshot.month, '2026-11');
  assert.equal(snapshot.schema_version, 2);
  assert.equal(snapshot.recent_started_on, '2026-10-26');
  assert.deepEqual(snapshot.first_recommendations.month, [{ work_id: '01', count: 1 }, { work_id: '02', count: 0 }]);
  assert.deepEqual(snapshot.first_recommendations.recent, [{ work_id: '01', count: 6 }, { work_id: '02', count: 2 }]);
  assert.deepEqual(snapshot.work_opens.recent, [{ work_id: '01', count: 12 }, { work_id: '02', count: 3 }]);
  assert.deepEqual(Object.keys(snapshot), ['schema_version', 'status', 'generated_at', 'time_zone', 'collection_started_on', 'day', 'month', 'recent_started_on', 'visits', 'first_recommendations', 'work_opens']);
  assert.doesNotMatch(JSON.stringify(snapshot), /unknown-work|never publish|test-token/);
});

test('prefixed Analytics IDs preserve leading zeroes and exclude unapproved aliases', () => {
  const entries = [['work_01', 2], ['work_1', 3], ['work_10', 4],
    ['01', 90], ['1', 90], ['work_001', 90], ['work_99', 90], ['Work_01', 90]];
  const reports = [report(false, [3]), report(false, [40]),
    ...Array.from({ length: 5 }, () => report(true, entries))];
  const snapshot = snapshotFromReports({ ...options, workIds: ['01', '1', '10'], reports });
  const expected = [{ work_id: '01', count: 2 }, { work_id: '1', count: 3 }, { work_id: '10', count: 4 }];
  for (const period of ['recent', 'month', 'all_time']) {
    assert.deepEqual(snapshot.first_recommendations[period], expected);
  }
  assert.deepEqual(snapshot.work_opens.recent, expected);
  assert.deepEqual(snapshot.work_opens.all_time, expected);
  assert.doesNotMatch(JSON.stringify(snapshot), /work_01|work_001|work_99|Work_01/);
});

test('complete empty reports are zero, missing headers or results are failures', () => {
  const reports = [report(false), report(false), ...Array.from({ length: 5 }, () => report(true))];
  delete reports[0].rows;
  delete reports[0].rowCount;
  assert.equal(snapshotFromReports({ ...options, reports }).visits.today, 0);
  assert.throws(() => snapshotFromReports({ ...options, reports: [] }));
  delete reports[0].metricHeaders;
  assert.throws(() => snapshotFromReports({ ...options, reports }));
});

test('a new property may omit all headers and rows only in a valid unrestricted empty report', () => {
  const reports = Array.from({ length: 7 }, () => ({
    kind: 'analyticsData#runReport', metadata: { timeZone: 'Asia/Tokyo' },
  }));
  const snapshot = snapshotFromReports({ ...options, reports });
  assert.equal(snapshot.visits.today, 0);
  assert.equal(snapshot.visits.all_time, 0);
  assert.ok(Object.values(snapshot.first_recommendations).flat().every(row => row.count === 0));
  assert.ok(Object.values(snapshot.work_opens).flat().every(row => row.count === 0));
  for (const change of [
    report => delete report.kind,
    report => report.metricHeaders = null,
    report => report.rowCount = 1,
    report => report.rows = [{ metricValues: [{ value: '1' }] }],
    report => report.metadata.subjectToThresholding = true,
    report => report.metadata.emptyReason = 'restricted',
    report => report.metadata.timeZone = 'UTC',
  ]) {
    const invalid = structuredClone(reports);
    change(invalid[0]);
    assert.throws(() => snapshotFromReports({ ...options, reports: invalid }));
  }
});

test('metric diagnostics expose only bounded fixed schema labels and report kind', () => {
  for (const [index, type, kind, name] of [
    [0, 'TYPE_FLOAT', 'visits', 'sessions'],
    [2, 'TYPE_UNSPECIFIED', 'first_recommendations', 'eventCount'],
    [5, 'TYPE_UNSPECIFIED', 'work_opens', 'eventCount'],
  ]) {
    const payload = batch();
    payload.reports[index].metricHeaders[0].type = type;
    assert.throws(() => snapshotFromReports({ ...options, reports: payload.reports }), error => {
      assert.ok(error.message.startsWith(`Unexpected report metrics (${kind}): [{"name":"${name}","type":"${type}"}]. Shape: `));
      assert.ok(Object.values(JSON.parse(error.message.split(' Shape: ')[1])).every(value => typeof value === 'boolean'));
      return true;
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
    assert.ok(error.message.length < 500);
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
  for (const index of [2, 5]) {
    for (const change of changes) {
      const payload = batch(); change(payload.reports[index]);
      assert.throws(() => snapshotFromReports({ ...options, reports: payload.reports }));
    }
  }
});

test('recent can cross the month boundary while each series remains within its own cumulative total', () => {
  const snapshot = snapshotFromReports({ ...options, reports: batch().reports });
  assert.ok(snapshot.first_recommendations.recent[0].count > snapshot.first_recommendations.month[0].count);
  assert.ok(snapshot.work_opens.recent[0].count > snapshot.first_recommendations.all_time[0].count);
  for (const index of [2, 3, 5]) {
    const payload = batch();
    payload.reports[index].rows[0].metricValues[0].value = '999';
    assert.throws(() => snapshotFromReports({ ...options, reports: payload.reports }), /Inconsistent/);
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
    await assert.rejects(exportPublicStats({ ...options, outputPath, fetcher: fetchBatches(partial) }));
    assert.equal(await readFile(outputPath, 'utf8'), 'last-good');
    const firstBatchFetcher = fetchBatches();
    let calls = 0;
    await assert.rejects(exportPublicStats({ ...options, outputPath, fetcher: async (url, init) => {
      calls++;
      if (calls === 2) throw new Error('second-batch-failed');
      return firstBatchFetcher(url, init);
    } }));
    assert.equal(calls, 2);
    assert.equal(await readFile(outputPath, 'utf8'), 'last-good');
    await exportPublicStats({ ...options, outputPath, fetcher: fetchBatches() });
    assert.equal(JSON.parse(await readFile(outputPath, 'utf8')).status, 'ready');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
