import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { openOwnedAdventureworksReader } from './verify-dsh-adventureworks.mjs';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// This one-off replay accepts only the reviewed public AdventureWorks SELECT,
// never an arbitrary query copied into an identically shaped local log.
const RECORDED_ACCEPTANCE_SQL_SHA256 = '2cabe34abc577c400308f165bd0ff614bf3f2a1ddf02ede26ce7bbf829bed74b';

/** Reproduce a saved acceptance SQL result, not an unavailable historical chart definition. */
export async function verifyDshNumericChart({ runtimeDir, evidenceDir, sourceLog }) {
  assert.equal(path.resolve(process.cwd()), site);
  assert.ok([runtimeDir, evidenceDir, sourceLog].every(value => path.isAbsolute(value)));
  const runtimeRoot = path.join(site, '.runtime');
  assert.ok(samePath(await realpath(path.dirname(evidenceDir)), runtimeRoot));
  const sourcePath = await realpath(sourceLog), sourceRelative = path.relative(await realpath(runtimeRoot), sourcePath);
  assert.ok(sourceRelative && !sourceRelative.startsWith('..') && !path.isAbsolute(sourceRelative));
  assert.equal(path.basename(sourcePath), 'notebook-query-log.json');
  assert.ok((await stat(sourcePath)).size <= 64 * 1024);
  const sourceBytes = await readFile(sourcePath);
  const source = JSON.parse(sourceBytes.toString('utf8'));
  assert.equal(source.version, 1); assert.equal(source.queries.length, 1);
  const recorded = source.queries[0];
  assert.equal(recorded.status, 'success'); assert.equal(recorded.returnedRows, 38); assert.equal(recorded.truncated, false);
  assert.equal(recorded.cellId, 'wsql_monthly_sales'); assert.equal(typeof recorded.sql, 'string');
  const exactSql = recorded.sql;
  assert.equal(sha256(exactSql), RECORDED_ACCEPTANCE_SQL_SHA256, 'Only the reviewed public fixture SQL may be replayed');
  await mkdir(evidenceDir, { mode: 0o700 });
  const report = { passed: false, realPostgres: true, paidModelCalls: 0, officialSdk: false,
    historicalChartDefinitionAvailable: false, reconstructedChartNotHistorical: true,
    websiteConfigurationChanged: false, databaseWrites: false, productionMappingChanged: false,
    sourceLog: sourceRelative.replaceAll('\\', '/'), sourceSqlHash: sha256(exactSql), sourceSqlAllowlistVerified: true,
    startedAt: new Date().toISOString(), stage: 'owned-reader', checks: [] };
  const savedEnvironment = process.env, originalFetch = globalThis.fetch;
  let owned, vite, networkAttempts = 0;
  try {
    owned = await openOwnedAdventureworksReader(runtimeDir);
    const allowed = new Set(['systemroot', 'windir', 'path', 'temp', 'tmp', 'comspec', 'pathext', 'number_of_processors']);
    process.env = Object.fromEntries(Object.entries(savedEnvironment).filter(([key]) => allowed.has(key.toLowerCase())));
    const stateDir = path.join(evidenceDir, 'isolated-state'); await mkdir(stateDir, { mode: 0o700 });
    process.env.STUDIO_LOCAL_STATE_DIR = stateDir; process.env.DSH_CHART_READER_PASSWORD = owned.reader.password;
    globalThis.fetch = async () => { networkAttempts++; throw new Error('External HTTP/model calls prohibited'); };
    vite = await createServer({ root: site, configFile: false, envFile: false, cacheDir: path.join(evidenceDir, 'vite-cache'),
      logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, resolve: { alias: { '@': site } } });
    const [connections, projects, notebook] = await Promise.all([
      vite.ssrLoadModule('/core/connections/server/query.ts'), vite.ssrLoadModule('/core/projects/server/store.ts'),
      vite.ssrLoadModule('/core/notebook/server/runtime.ts'),
    ]);
    const project = projects.openProject(path.join(evidenceDir, 'project'), 'Offline numeric chart diagnosis');
    const connectionId = 'dsh_numeric_chart_reader';
    process.env.STUDIO_SQL_CONNECTIONS = JSON.stringify([{ id: connectionId, name: 'Isolated reader', kind: 'postgresql',
      projects: [project.handle], host: owned.owner.host, port: owned.owner.port, database: owned.owner.database,
      user: owned.reader.username, passwordEnv: 'DSH_CHART_READER_PASSWORD', ssl: false, allowAi: true }]);
    const scope = { connectionId, project: project.handle, forAi: true };
    const schema = await connections.inspectConnectionSchema({ ...scope, refresh: true });
    assert.equal(schema.catalog.complete, true); assert.equal(schema.catalog.tableCount, 10);

    report.stage = 'exact-recorded-sql-types';
    const direct = await owned.client.query(exactSql);
    assert.deepEqual(direct.fields.map(field => [field.name, field.dataTypeID]), [['month', 25], ['order_count', 20], ['revenue_cents', 20]]);
    const original = await connections.executeConnectionSql({ ...scope, sql: exactSql });
    assert.deepEqual(original.fields.map(field => [field.name, field.type]), [['month', 'string'], ['order_count', 'string'], ['revenue_cents', 'string']]);
    assert.equal(original.rows.length, 38); assert.equal(original.truncated, false);
    assert.deepEqual(original.rows, direct.rows);
    const reference = (await owned.client.query("SELECT to_char(date_trunc('month', orderdate), 'YYYY-MM') AS month, COUNT(*) AS order_count, ROUND(SUM(subtotal) * 100)::bigint AS revenue_cents FROM sales.salesorderheader GROUP BY date_trunc('month', orderdate) ORDER BY month")).rows;
    assert.deepEqual(original.rows, reference); // Independent aggregate formulation; never use the model's answer.
    assert.equal(reference.reduce((sum, row) => sum + Number(row.order_count), 0), 31465);
    report.originalQuery = { exactRecordedSql: true, sqlSuccess: true, rowCount: 38,
      postgresOids: direct.fields.map(field => ({ field: field.name, oid: field.dataTypeID })),
      fieldTypes: original.fields.map(field => ({ field: field.name, type: field.type })),
      valueTypes: Object.fromEntries(Object.keys(original.rows[0]).map(key => [key, typeof original.rows[0][key]])),
      matchesIndependentReference: true };
    report.checks.push('The exact recorded SELECT succeeds with 38 rows; both bigint measures are preserved as strings.');

    const remote = sql => ({ id: 'remote', kind: 'warehouseSql', title: 'Recorded monthly SQL', connectionId, sql, outputName: 'monthly_sales' });
    const chart = { id: 'orders_chart', kind: 'chart', title: 'Reconstructed requested order-count line chart', inputCellId: 'remote',
      chartType: 'line', categoryField: 'month', valueFields: ['order_count'] };
    const query = (id, sql, signal) => connections.executeConnectionSql({ ...scope, connectionId: id, sql, signal });
    const run = document => notebook.runNotebook({ document, sources: [], forAi: true, userId: 'offline_chart_diagnosis',
      taskId: 'offline_chart_diagnosis', connectionQuery: query });
    report.stage = 'reconstructed-chart-failure';
    const originalDocument = { name: 'Independent chart reproduction', revision: 0, cells: [remote(exactSql), chart] };
    const before = structuredClone(originalDocument);
    const failed = await run(originalDocument);
    assert.equal(failed.status, 'failure'); assert.equal(failed.cells[0].status, 'success');
    assert.equal(failed.cells[1].status, 'failure');
    assert.equal(failed.cells[1].error, '图表数值列必须为数字；高精度字符串请在 SQL 中显式转换后使用');
    assert.deepEqual(originalDocument, before);
    report.reproduction = { constructedChart: 'month/order_count line', sqlStatus: 'success', chartStatus: 'failure',
      failureCategory: 'chart_measure_requires_number', numericPrecisionPolicyPreserved: true };
    report.checks.push('A newly constructed requested order-count line chart fails on the exact SQL output because its value field is a string. This is not the saved historical chart.');

    report.stage = 'checked-conversion-and-chart';
    const numericReference = reference.map(row => {
      assert.match(row.order_count, /^\d+$/u); assert.match(row.revenue_cents, /^\d+$/u);
      assert.ok(BigInt(row.order_count) <= 2147483647n);
      assert.ok(BigInt(row.revenue_cents) <= BigInt(Number.MAX_SAFE_INTEGER));
      const orders = Number(row.order_count), cents = Number(row.revenue_cents);
      assert.ok(Number.isSafeInteger(orders) && Number.isSafeInteger(cents));
      assert.equal(BigInt(orders).toString(), row.order_count); assert.equal(BigInt(cents).toString(), row.revenue_cents);
      return { month: row.month, order_count: orders, revenue_cents: cents };
    });
    const convertedSql = `SELECT month, order_count::integer AS order_count, revenue_cents::double precision AS revenue_cents FROM (\n${exactSql}\n) AS exact_monthly ORDER BY month`;
    const converted = { name: 'Checked safe numeric chart', revision: 0, cells: [remote(convertedSql),
      { id: 'monthly_table', kind: 'table', title: 'Monthly totals', inputCellId: 'remote', columns: ['month', 'order_count', 'revenue_cents'] }, chart] };
    const convertedBefore = structuredClone(converted), success = await run(converted);
    assert.equal(success.status, 'success'); assert.ok(success.cells.every(cell => cell.status === 'success'));
    assert.deepEqual(success.cells[0].table.rows, numericReference); assert.deepEqual(success.cells[1].table.rows, numericReference);
    assert.deepEqual(success.cells[2].table.rows, numericReference.map(({ month, order_count }) => ({ month, order_count })));
    assert.equal(success.cells[0].resultRef.connectionId, connectionId);
    assert.equal(success.cells[0].resultRef.catalogRef?.id, schema.catalog.id);
    assert.equal(success.cells[0].resultRef.catalogRef?.complete, true);
    for (const result of success.cells.slice(1)) assert.deepEqual(result.resultRef.inputResultIds, [success.cells[0].resultRef.resultId]);
    assert.ok(success.cells.every(cell => cell.resultRef.accessMode === 'ai' && cell.resultRef.complete));
    assert.deepEqual(converted, convertedBefore); assert.deepEqual(await readFile(sourcePath), sourceBytes);
    report.correctedPath = { explicitSqlConversion: true, safeIntegerBoundsCheckedBeforeConversion: true,
      sqlStatus: 'success', tableStatus: 'success', chartStatus: 'success', rowCount: 38, orderCount: 31465,
      allMonthlyValuesMatchIndependentReference: true, numericRowsHash: sha256(numericReference),
      lineageVerified: true, sourceEvidenceUnchanged: true, adopted: false, formalDocumentsUnchanged: true };
    report.checks.push('After checking every aggregate against int4/safe-integer bounds, explicit SQL conversion produces a real table and chart exactly matching an independent reader reference.');
    report.stage = 'completed'; report.passed = true;
  } catch (error) {
    const line = error instanceof Error ? error.stack?.match(/verify-dsh-numeric-chart\.mjs:(\d+):\d+/u)?.[1] : undefined;
    report.failure = { name: error instanceof Error ? error.name : 'UnknownError', stage: report.stage,
      ...(line ? { acceptanceLine: Number(line) } : {}) }; process.exitCode = 1;
  } finally {
    try { await vite?.close(); }
    finally { try { await owned?.client.end(); } finally {
      globalThis.fetch = originalFetch; process.env = savedEnvironment;
      report.finishedAt = new Date().toISOString(); report.networkAttempts = networkAttempts;
      report.limits = ['No original live chart definition or complete live run receipt was recorded; this cannot prove its historical failure reason.',
        'The original SQL is replayed exactly; the chart is newly constructed from the stated requirement, not recovered from provider output.',
        'No paid model, SDK loop, browser rendering, user-project adoption or production type-mapping change.',
        'Conversions are verified only for these public fixture aggregates; arbitrary bigint/numeric values must keep precision-safe handling.'];
      const json = `${JSON.stringify(report, null, 2)}\n`;
      assert.ok(!owned || !json.includes(owned.reader.password));
      await writeFile(path.join(evidenceDir, 'report.json'), json, { flag: 'wx', mode: 0o600 });
    } }
  }
  return report;
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  try {
    assert.equal(args.length, 6); assert.equal(args[0], '--runtime-dir'); assert.equal(args[2], '--evidence-dir'); assert.equal(args[4], '--source-log');
    const report = await verifyDshNumericChart({ runtimeDir: args[1], evidenceDir: args[3], sourceLog: args[5] });
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, stage: report.stage,
      report: path.relative(site, path.join(args[3], 'report.json')).replaceAll('\\', '/') }));
  } catch { console.error('Numeric chart diagnosis could not initialize; existing files/services were preserved.'); process.exitCode = 1; }
}
