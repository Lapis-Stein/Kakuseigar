import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REPORT_LIMIT = 10000;
const TIME_ZONE = 'Asia/Tokyo';

export class StatsExportError extends Error {}
const requireValue = (condition, message) => { if (!condition) throw new StatsExportError(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function jstDate(now = new Date()) {
  requireValue(now instanceof Date && Number.isFinite(now.getTime()), 'Invalid export time.');
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function exact(fieldName, value) {
  return { filter: { fieldName, stringFilter: { matchType: 'EXACT', value, caseSensitive: true } } };
}

export function buildReports({ collectionStartedOn, now = new Date() }) {
  const day = jstDate(now);
  requireValue(validDate(collectionStartedOn) && collectionStartedOn <= day,
    'GA4_COLLECTION_STARTED_ON must be a valid past or current date (YYYY-MM-DD).');
  const month = day.slice(0, 7);
  const monthStart = `${month}-01` < collectionStartedOn ? collectionStartedOn : `${month}-01`;
  const siteFilters = [exact('pageLocation', 'https://lapis-stein.github.io/Kakuseigar/')];
  const report = (startDate, recommendations) => ({
    dateRanges: [{ startDate, endDate: day }],
    ...(recommendations ? { dimensions: [{ name: 'customEvent:work_id' }] } : {}),
    metrics: [{ name: recommendations ? 'eventCount' : 'sessions' }],
    dimensionFilter: { andGroup: { expressions: recommendations ? [...siteFilters,
      exact('eventName', 'work_recommended'), exact('customEvent:first_recommendation', 'yes')] : siteFilters } },
    limit: String(REPORT_LIMIT),
    keepEmptyRows: false,
  });
  return { day, month, requests: [report(day, false), report(collectionStartedOn, false),
    report(day, true), report(monthStart, true), report(collectionStartedOn, true)] };
}

function count(value) {
  requireValue(typeof value === 'string' && /^\d+$/.test(value), 'Invalid report count.');
  const result = Number(value);
  requireValue(Number.isSafeInteger(result) && result >= 0, 'Invalid report count.');
  return result;
}

function reportRows(report, recommendations) {
  requireValue(object(report) && object(report.metadata), 'Missing report metadata.');
  const meta = report.metadata;
  requireValue(meta.timeZone === TIME_ZONE, 'The GA4 property time zone must be Asia/Tokyo.');
  requireValue(!meta.subjectToThresholding && !meta.dataLossFromOtherRow
    && !(meta.samplingMetadatas?.length) && !(meta.dataTruncationReasons?.length)
    && !(meta.schemaRestrictionResponse?.activeMetricRestrictions?.length) && !meta.emptyReason,
  'The report is incomplete or restricted; the previous snapshot has been preserved.');
  const dimensions = report.dimensionHeaders ?? [];
  requireValue(Array.isArray(dimensions) && dimensions.length === (recommendations ? 1 : 0)
    && (!recommendations || dimensions[0]?.name === 'customEvent:work_id'), 'Unexpected report dimensions.');
  requireValue(Array.isArray(report.metricHeaders) && report.metricHeaders.length === 1
    && report.metricHeaders[0]?.name === (recommendations ? 'eventCount' : 'sessions')
    && report.metricHeaders[0]?.type === 'TYPE_INTEGER', 'Unexpected report metrics.');
  const rows = report.rows ?? [];
  requireValue(Array.isArray(rows) && rows.length <= REPORT_LIMIT, 'Invalid report rows.');
  // Protocol buffers may omit a zero rowCount, but never a nonzero one.
  const rowCount = report.rowCount ?? 0;
  requireValue(Number.isSafeInteger(rowCount) && rowCount >= 0 && rowCount === rows.length,
    'The report was truncated; the previous snapshot has been preserved.');
  requireValue(recommendations || rows.length <= 1, 'Unexpected visit report rows.');
  return rows.map(row => {
    requireValue(object(row) && Array.isArray(row.metricValues) && row.metricValues.length === 1,
      'Invalid report metric value.');
    const value = count(row.metricValues[0]?.value);
    const values = row.dimensionValues ?? [];
    requireValue(Array.isArray(values) && values.length === (recommendations ? 1 : 0),
      'Invalid report dimension value.');
    if (!recommendations) return value;
    const id = values[0]?.value;
    requireValue(typeof id === 'string' && id.length > 0 && id.length <= 200
      && !['(not set)', '(other)'].includes(id), 'Unresolved work identifiers in report.');
    return { work_id: id, count: value };
  });
}

export function snapshotFromReports({ reports, workIds, collectionStartedOn, now = new Date() }) {
  const { day, month } = buildReports({ collectionStartedOn, now });
  requireValue(Array.isArray(workIds) && workIds.length > 0 && workIds.length <= 1000
    && workIds.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id))
    && new Set(workIds).size === workIds.length, 'Invalid public work identifiers.');
  requireValue(Array.isArray(reports) && reports.length === 5, 'Incomplete report batch.');
  // GA parses numeric-looking custom dimensions. Match the exact prefixed
  // transport values to approved runtime IDs, preserving leading zeroes.
  const publicWorkIds = new Map(workIds.map(id => [`work_${id}`, id]));
  const todayVisits = reportRows(reports[0], false)[0] ?? 0;
  const allVisits = reportRows(reports[1], false)[0] ?? 0;
  const recommendationRows = reports.slice(2).map(report => {
    const counts = new Map(), seen = new Set();
    for (const row of reportRows(report, true)) {
      requireValue(!seen.has(row.work_id), 'Duplicate work rows in report.');
      seen.add(row.work_id);
      const publicId = publicWorkIds.get(row.work_id);
      if (publicId !== undefined) counts.set(publicId, row.count);
    }
    // This is the sole public-data projection: never copy arbitrary GA fields.
    return workIds.map(work_id => ({ work_id, count: counts.get(work_id) ?? 0 }));
  });
  requireValue(todayVisits <= allVisits, 'Inconsistent visit periods.');
  for (let index = 0; index < workIds.length; index++) {
    requireValue(recommendationRows[0][index].count <= recommendationRows[1][index].count
      && recommendationRows[1][index].count <= recommendationRows[2][index].count,
    'Inconsistent recommendation periods.');
  }
  return {
    schema_version: 1,
    status: 'ready',
    generated_at: now.toISOString(),
    time_zone: TIME_ZONE,
    collection_started_on: collectionStartedOn,
    day,
    month,
    visits: { today: todayVisits, all_time: allVisits },
    first_recommendations: { today: recommendationRows[0], month: recommendationRows[1], all_time: recommendationRows[2] },
  };
}

async function readJsonBounded(response) {
  requireValue(response.body && typeof response.body.getReader === 'function', 'Invalid API response.');
  const declared = Number(response.headers.get('content-length'));
  requireValue(!Number.isFinite(declared) || declared <= MAX_RESPONSE_BYTES, 'API response is too large.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      requireValue(total <= MAX_RESPONSE_BYTES, 'API response is too large.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new StatsExportError('The API response was not valid JSON.'); }
  } finally { await reader.cancel().catch(() => {}); }
}

export async function fetchPublicStats({ accessToken, propertyId, collectionStartedOn, workIds,
  now = new Date(), fetcher = fetch, timeoutMs = 15000 }) {
  requireValue(typeof accessToken === 'string' && accessToken.length > 0 && accessToken.length <= 8192
    && !/[\r\n\s]/.test(accessToken), 'A valid GOOGLE_OAUTH_ACCESS_TOKEN is required.');
  requireValue(typeof propertyId === 'string' && /^[1-9]\d{0,19}$/.test(propertyId), 'A numeric GA4_PROPERTY_ID is required.');
  const { requests } = buildReports({ collectionStartedOn, now });
  let response;
  try {
    response = await fetcher(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:batchRunReports`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });
  } catch { throw new StatsExportError('Could not retrieve analytics; the previous snapshot has been preserved.'); }
  requireValue(response.ok, 'The analytics request failed; check authorization, custom dimensions and quota.');
  let payload;
  try { payload = await readJsonBounded(response); }
  catch (error) {
    if (error instanceof StatsExportError) throw error;
    throw new StatsExportError('Could not finish reading analytics; the previous snapshot has been preserved.');
  }
  requireValue(object(payload), 'Invalid API response.');
  return snapshotFromReports({ reports: payload.reports, workIds, collectionStartedOn, now });
}

export async function exportPublicStats({ outputPath, ...options }) {
  const snapshot = await fetchPublicStats(options);
  const destination = path.resolve(outputPath);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, destination);
  } catch {
    await unlink(temporary).catch(() => {});
    throw new StatsExportError('Could not replace the public snapshot.');
  }
  return snapshot;
}

async function main() {
  const runtime = JSON.parse(await readFile(path.join(ROOT, 'data/runtime.json'), 'utf8'));
  await exportPublicStats({
    accessToken: process.env.GOOGLE_OAUTH_ACCESS_TOKEN,
    propertyId: process.env.GA4_PROPERTY_ID,
    collectionStartedOn: process.env.GA4_COLLECTION_STARTED_ON,
    workIds: runtime.works.map(work => work.id),
    outputPath: path.join(ROOT, 'data/public-stats.json'),
  });
  console.log('Public aggregate snapshot updated.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof StatsExportError ? error.message : 'Public statistics export failed.');
    process.exitCode = 1;
  });
}
