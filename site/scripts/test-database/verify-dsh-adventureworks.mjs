import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { createServer } from 'vite';
import { CORE_TABLES, validateOwner, parsePostmasterPid, run as runProcess } from './adventureworks.mjs';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

/** Acceptance diagnostics never retain argument values, exception messages or unknown field names. */
export function summarizeDshAcceptanceToolError(tool, error) {
  const allowedNames = new Set(['cellSearch', 'editNotebookCells', 'runNotebookCells', 'submitNotebookDraft',
    'inspectConnectionSchema', 'getKernelPackagesInfo', 'inspectEdsRawWorkbook', 'readEdsRawRows']);
  const name = allowedNames.has(tool.name) ? tool.name : 'unknown';
  if (error?.name === 'HarnessToolArgumentsError' && Array.isArray(error.issueSummary)) {
    const fields = new Set(Object.keys(tool.parameters?.properties ?? {}));
    const codes = new Set(['invalid_type', 'invalid_format', 'too_big', 'too_small', 'invalid_value',
      'unrecognized_keys', 'custom', 'invalid_union', 'invalid_key', 'invalid_element', 'not_multiple_of']);
    const issues = error.issueSummary.slice(0, 6).map(issue => {
      const parsed = typeof issue === 'string' ? /^([^:]+):([a-z_]+)/u.exec(issue) : undefined;
      const first = parsed?.[1].split('.', 1)[0];
      return { field: first === '$' || fields.has(first) ? first : '[redacted]',
        code: codes.has(parsed?.[2]) ? parsed[2] : 'unknown' };
    });
    return { tool: name, errorCode: 'INVALID_TOOL_ARGUMENTS', issues };
  }
  return { tool: name, errorCode: error?.name === 'StudioValidationError' ? 'BUSINESS_VALIDATION'
    : error?.name === 'AbortError' ? 'ABORTED' : 'TOOL_EXECUTION_FAILED' };
}

/** Trusted acceptance scripts only. Never log/serialize the returned reader credential. */
export async function openOwnedAdventureworksReader(runtimeDir) {
  assert.ok(path.isAbsolute(runtimeDir), 'An explicit owned runtime is required');
  const owner = validateOwner(JSON.parse(await readFile(path.join(runtimeDir, 'owner.json'), 'utf8')), path.resolve(runtimeDir));
  assert.equal(owner.phase, 'ready', 'Only an existing successfully restored fixture may be used');
  assert.ok(samePath(await realpath(runtimeDir), runtimeDir));
  assert.ok(samePath(await realpath(owner.dataDir), owner.dataDir));
  assert.ok(samePath(await realpath(owner.binDir), owner.binDir));
  const pid = parsePostmasterPid(await readFile(path.join(owner.dataDir, 'postmaster.pid'), 'utf8'), owner);
  const probe = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; @{ executable=$p.ExecutablePath; listeners=@(Get-NetTCPConnection -State Listen -LocalPort ${owner.port} | Select-Object LocalAddress,OwningProcess) } | ConvertTo-Json -Compress`;
  const processIdentity = JSON.parse(await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probe]));
  assert.ok(samePath(processIdentity.executable, path.join(owner.binDir, 'postgres.exe')));
  assert.ok(processIdentity.listeners.length > 0);
  assert.ok(processIdentity.listeners.every(item => item.LocalAddress === '127.0.0.1' && item.OwningProcess === pid));
  // Deliberately extract only reader fields; never use administrator credentials.
  const { ownerId, username, password } = JSON.parse(await readFile(path.join(runtimeDir, 'credentials.private.json'), 'utf8'));
  assert.equal(ownerId, owner.id); assert.equal(username, owner.readerUser); assert.match(password, /^[0-9a-f]{64}$/);
  const client = new Client({ host: owner.host, port: owner.port, database: owner.database, user: username, password,
    ssl: false, connectionTimeoutMillis: 5_000, query_timeout: 15_000, application_name: 'AgentCanvas-DSH-readonly-reference' });
  client.on('error', () => {});
  try {
    await client.connect();
    const identity = (await client.query("SELECT current_database() AS database, current_user AS username, current_setting('cluster_name') AS cluster, host(inet_server_addr()) AS address, inet_server_port() AS port")).rows[0];
    assert.deepEqual(identity, { database: owner.database, username, cluster: owner.clusterName, address: owner.host, port: owner.port });
    const permissions = (await client.query("SELECT current_setting('statement_timeout') AS timeout, current_setting('default_transaction_read_only') AS readonly, has_database_privilege(current_database(),'TEMP') AS temp, has_schema_privilege('public','CREATE') AS public_create, has_table_privilege('sales.salesorderheader','INSERT,UPDATE,DELETE,TRUNCATE') AS writes, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
    assert.deepEqual(permissions, { timeout: '12s', readonly: 'on', temp: false, public_create: false, writes: false,
      rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false });
    return { owner, pid, reader: { username, password }, client, permissions };
  } catch (error) { await client.end().catch(() => {}); throw error; }
}

/** Real reader-only PostgreSQL. Live mode accepts only a caller-owned bounded loopback model gateway. */
export async function verifyDshAdventureWorks({ runtimeDir, evidenceDir, modelConfig, instruction }) {
  const live = modelConfig !== undefined;
  if (live) {
    assert.equal(modelConfig.mode, 'deepseek');
    const gateway = new URL(modelConfig.baseURL);
    assert.equal(gateway.protocol, 'http:'); assert.equal(gateway.hostname, '127.0.0.1');
    assert.ok(gateway.port && !gateway.username && !gateway.password);
    assert.equal(typeof modelConfig.apiKey, 'string'); assert.ok(modelConfig.apiKey.length >= 16);
    assert.ok(modelConfig.maxTokens > 0 && modelConfig.maxTokens <= 4096);
  }
  assert.equal(path.resolve(process.cwd()), site, 'Run this acceptance from site/');
  assert.ok(path.isAbsolute(runtimeDir) && path.isAbsolute(evidenceDir));
  const relativeEvidence = path.relative(path.join(site, '.runtime'), evidenceDir);
  assert.ok(relativeEvidence && !relativeEvidence.startsWith('..') && !path.isAbsolute(relativeEvidence), 'Evidence must use a new site/.runtime child');
  assert.ok(samePath(await realpath(path.dirname(evidenceDir)), path.join(site, '.runtime')), 'Evidence parent must be the actual .runtime directory');
  await mkdir(evidenceDir, { mode: 0o700 }); // Never overwrite an existing acceptance directory.
  const report = { passed: false, officialSdk: true, realPostgres: true, scriptedModel: !live, realPaidModel: live,
    databaseWrites: false, websiteConfigurationChanged: false, browserVerified: false,
    startedAt: new Date().toISOString(), stage: 'ownership-and-reader', checks: [] };
  const savedEnvironment = process.env, originalFetch = globalThis.fetch;
  let owned, vite, rejectedParentFetches = 0, sdkStarted = 0;
  const toolFailures = [];
  const save = async (name, value) => {
    const json = `${JSON.stringify(value, null, 2)}\n`;
    assert.ok(!owned || !json.includes(owned.reader.password), 'Credentials must not enter evidence');
    assert.ok(!live || !json.includes(modelConfig.apiKey), 'Gateway credentials must not enter evidence');
    await writeFile(path.join(evidenceDir, name), json, { flag: 'wx', mode: 0o600 });
  };
  try {
    owned = await openOwnedAdventureworksReader(runtimeDir);
    report.ownership = { verified: true, runtimeId: owned.owner.id, loopbackPort: owned.owner.port, readerVerified: true, permissions: owned.permissions };
    report.checks.push('Existing owned cluster, executable/listener and reader identity verified; no setup, restore or database write.');
    const allowedEnvironment = new Set(['systemroot', 'windir', 'path', 'temp', 'tmp', 'comspec', 'pathext', 'number_of_processors']);
    process.env = Object.fromEntries(Object.entries(savedEnvironment).filter(([key]) => allowedEnvironment.has(key.toLowerCase())));
    const stateDir = path.join(evidenceDir, 'isolated-state'); await mkdir(stateDir, { mode: 0o700 });
    process.env.STUDIO_LOCAL_STATE_DIR = stateDir;
    process.env.DSH_AW_ACCEPTANCE_PASSWORD = owned.reader.password;
    globalThis.fetch = async () => { rejectedParentFetches++; throw new Error('HTTP/model fetch prohibited in this read-only acceptance'); };
    vite = await createServer({ root: site, configFile: false, envFile: false, cacheDir: path.join(evidenceDir, 'vite-cache'),
      logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, resolve: { alias: { '@': site } } });
    const [connections, config, projects, notebook, contracts, streams, executorModule, driverModule, fixtures, dshPolicy] = await Promise.all([
      vite.ssrLoadModule('/core/connections/server/query.ts'), vite.ssrLoadModule('/core/connections/server/config.ts'),
      vite.ssrLoadModule('/core/projects/server/store.ts'), vite.ssrLoadModule('/core/notebook/server/runtime.ts'),
      vite.ssrLoadModule('/core/harness/contracts.ts'), vite.ssrLoadModule('/core/harness/stream.ts'),
      vite.ssrLoadModule('/core/agent-engines/server/executor.ts'), vite.ssrLoadModule('/core/agent-engines/server/dsh-driver.ts'),
      vite.ssrLoadModule('/fixtures/demo-product.ts'),
      vite.ssrLoadModule('/core/agent-engines/server/execution-policy.ts'),
    ]);
    assert.equal((await driverModule.inspectOfficialDshRuntime()).available, true, 'Install the isolated official SDK before this acceptance');
    assert.equal(fixtures.demoFixtureResult.success, true);
    const project = projects.openProject(path.join(evidenceDir, 'project'), 'DSH AdventureWorks isolated acceptance');
    const connectionId = 'dsh_adventureworks_reader';
    const connection = { id: connectionId, name: 'AdventureWorks acceptance reader', kind: 'postgresql', projects: [project.handle],
      host: owned.owner.host, port: owned.owner.port, database: owned.owner.database, user: owned.reader.username,
      passwordEnv: 'DSH_AW_ACCEPTANCE_PASSWORD', ssl: false, allowAi: false };
    const configure = allowAi => { connection.allowAi = allowAi; process.env.STUDIO_SQL_CONNECTIONS = JSON.stringify([connection]); };
    configure(false);
    const scope = { connectionId, project: project.handle, forAi: true };
    assert.deepEqual(config.listConnections(project.handle, true), []);
    await assert.rejects(connections.executeConnectionSql({ ...scope, sql: 'SELECT 1 AS value' }), /未授权/);
    configure(true); // This isolated process only; never changes website config or database role grants.
    assert.deepEqual(config.listConnections(null, true), []);
    const expectedConnections = config.listConnections(project.handle, true);
    let authorizationChecks = 0;
    const authorize = () => { authorizationChecks++; assert.deepEqual(config.listConnections(project.handle, true), expectedConnections); };
    const schema = await connections.inspectConnectionSchema({ ...scope, refresh: true });
    assert.deepEqual([...new Set(schema.columns.map(column => `${column.table_schema}.${column.table_name}`))].sort(), [...CORE_TABLES].sort());
    assert.equal(schema.truncated, false);
    report.catalog = { tables: schema.catalog.tableCount, columns: schema.columns.length, complete: schema.catalog.complete };
    report.checks.push('Real reader catalog exposes exactly ten granted tables; wrong project/default AI access are denied.');

    report.stage = 'independent-readonly-reference';
    const sqlHead = "SELECT to_char(date_trunc('month', orderdate), 'YYYY-MM') AS month, COUNT(*)::integer AS order_count, ROUND(SUM(subtotal) * 100)";
    const sqlTail = " FROM sales.salesorderheader GROUP BY date_trunc('month', orderdate) ORDER BY month";
    const sql = `${sqlHead}::double precision AS revenue_cents${sqlTail}`;
    const referenceRows = (await owned.client.query(`${sqlHead}::bigint AS revenue_cents${sqlTail}`)).rows;
    assert.equal(referenceRows.length, 38);
    assert.equal(referenceRows.reduce((count, row) => count + row.order_count, 0), 31465);
    const monthlyRows = referenceRows.map(row => {
      const cents = Number(row.revenue_cents);
      assert.ok(Number.isSafeInteger(cents)); assert.equal(BigInt(cents).toString(), row.revenue_cents);
      return { ...row, revenue_cents: cents };
    });
    const annualRows = Object.values(monthlyRows.reduce((groups, row) => {
      const year = row.month.slice(0, 4); groups[year] ??= { sales_year: year, order_count: 0, revenue_cents: 0 };
      groups[year].order_count += row.order_count; groups[year].revenue_cents += row.revenue_cents; return groups;
    }, {}));
    const precise = await connections.executeConnectionSql({ ...scope, sql: 'SELECT SUM(subtotal) AS numeric_sum, SUM(subtotal)::text AS text_sum FROM sales.salesorderheader' });
    assert.equal(typeof precise.rows[0].numeric_sum, 'string'); assert.equal(precise.rows[0].numeric_sum, precise.rows[0].text_sum);
    const cells = [
      { id: 'monthly', kind: 'warehouseSql', title: 'Monthly PostgreSQL sales', connectionId, outputName: 'monthly_sales', sql },
      { id: 'annual', kind: 'sql', title: 'Annual DuckDB rollup', inputCellIds: ['monthly'], outputName: 'annual_sales',
        sql: "SELECT substr(month, 1, 4) AS sales_year, SUM(order_count)::INTEGER AS order_count, SUM(revenue_cents)::DOUBLE AS revenue_cents FROM monthly_sales GROUP BY sales_year ORDER BY sales_year" },
      { id: 'table', kind: 'table', title: 'Annual table', inputCellId: 'annual', columns: ['sales_year', 'order_count', 'revenue_cents'] },
      { id: 'chart', kind: 'chart', title: 'Annual chart', inputCellId: 'annual', chartType: 'bar', categoryField: 'sales_year', valueFields: ['revenue_cents'] },
    ];
    const liveInstruction = '请分析当前已授权的 AdventureWorks 销售数据库。先查看 Notebook 和 salesorderheader 表结构，再自行编写只读 SQL，按自然月汇总全部订单数量和 SubTotal 收入。输出字段为 month（YYYY-MM）、order_count（订单数）、revenue_cents（当月 SubTotal 合计乘 100 后四舍五入的整数分）。生成完整月份的明细汇总表和以 month 为横轴、order_count 为纵轴的趋势图。无需再按年汇总。请创建 Notebook 草稿，实际运行所有单元并提交验证成功的草稿供审阅，不要采用或修改正式 Notebook。不要询问确认，不要只给文字说明。';
    const request = contracts.harnessRequestSchema.parse({ idempotencyKey: `dsh_aw_${crypto.randomUUID().replaceAll('-', '')}`, instruction: live ? instruction ?? liveInstruction : '检查授权销售数据库结构，创建每月订单及收入查询，再按年汇总并生成表格和图表，试运行后交付待采用草稿。',
      role: 'editor', pageId: 'page_home', appSpec: { ...structuredClone(fixtures.demoFixtureResult.data.dataProduct.appSpec), dataSources: [] }, recipes: [],
      notebookContext: { sourceIds: [], connections: expectedConnections, document: { name: 'AdventureWorks readonly DSH', revision: 3, cells: [] } } });
    const before = structuredClone(request);
    const actions = [
      { name: 'cellSearch', args: {} },
      { name: 'inspectConnectionSchema', args: { connectionId, search: 'salesorderheader', offset: 0 } },
      { name: 'inspectConnectionSchema', args: { connectionId, search: 'salesorderheader', offset: 15 } },
      { name: 'editNotebookCells', args: { editVersion: 0, cells } },
      { name: 'runNotebookCells', args: { editVersion: 1 } }, { name: 'submitNotebookDraft', args: { editVersion: 1 } },
    ];
    let observedRun;
    const runReceipts = [];
    const officialDriver = driverModule.createOfficialDshDriver(() => live ? modelConfig : { mode: 'fixture', actions, finalText: 'UNTRUSTED_CLAIM' });
    const execute = executorModule.createAgentExecutor(async input => {
      sdkStarted++; assert.ok(!JSON.stringify(input.context).includes(owned.reader.password));
      assert.ok(!JSON.stringify(input.context).includes('DSH_AW_ACCEPTANCE_PASSWORD'));
      return officialDriver({ ...input, tools: input.tools.map(tool => ({ ...tool,
        async execute(args, signal) {
          try { return await tool.execute(args, signal); }
          catch (error) {
            toolFailures.push(summarizeDshAcceptanceToolError(tool, error));
            throw error;
          }
        },
      })) });
    });
    const options = { dataRuntime: { rowsByDataSourceId: {} }, authorizeModelCall: authorize,
      modelClient: { next() { throw new Error('Old Harness execution forbidden in DSH verification'); } },
      connectionInspector: (id, signal) => connections.inspectConnectionSchema({ ...scope, connectionId: id, signal }),
      notebookRunner: async (artifact, context) => {
        observedRun = await notebook.runNotebook({ document: { name: artifact.name, revision: artifact.baseRevision, cells: artifact.cells }, sources: [],
          forAi: true, signal: context.signal, userId: 'dsh_acceptance', taskId: `harness_${context.request.idempotencyKey}`,
          connectionQuery: (id, query, signal) => connections.executeConnectionSql({ ...scope, connectionId: id, sql: query, signal }) });
        // This verifier uses only public fixture data. Retain generated definitions
        // and typed receipt metadata, never raw dataset rows or provider messages.
        runReceipts.push({ definition: { name: artifact.name, cells: artifact.cells }, status: observedRun.status,
          cells: observedRun.cells.map(cell => ({ cellId: cell.cellId, status: cell.status,
            ...(cell.table ? { fields: cell.table.fields, rowCount: cell.table.rows.length } : {}),
            ...(cell.error ? { failed: true } : {}) })) });
        await save(`run-receipt-${runReceipts.length}.json`, runReceipts.at(-1));
        return observedRun;
      },
    };
    report.stage = 'official-sdk-real-database';
    const controller = new AbortController(), events = [];
    const response = streams.createHarnessStreamResponse(controller.signal, (signal, onEvent) => execute('dsh', request, { ...options, signal, onEvent }));
    const { task } = await streams.readHarnessStream(response, controller.signal, event => events.push(event));
    report.execution = { taskState: task.state, terminationCode: task.terminationCode, toolCalls: task.counters.toolCallCount,
      modelCalls: task.counters.modelCallCount, successfulTools: events.filter(event => event.type === 'tool_completed').map(event => event.toolCall.name),
      failedTools: events.filter(event => event.type === 'tool_failed').map(event => event.toolCall.name) };
    assert.equal(task.state, 'awaitingConfirmation', task.error);
    assert.ok(task.counters.toolCallCount <= dshPolicy.resolveDshExecutionPolicy().maxToolCalls);
    assert.ok(task.counters.modelCallCount <= 26);
    assert.equal(task.verification.status, 'passed'); assert.equal(task.notebookArtifact.executionEvidence.status, 'success');
    assert.deepEqual(task.notebookArtifact.connectionIds, [connectionId]); assert.deepEqual(task.notebookArtifact.sourceDataSourceIds, []);
    assert.equal(events.filter(event => event.type === 'completed').length, 1);
    assert.equal(task.pendingChangeSet, undefined); assert.deepEqual(request, before);
    assert.ok(!JSON.stringify(task).includes('UNTRUSTED_CLAIM'));
    assert.equal(observedRun.status, 'success');
    assert.ok(observedRun.cells.every(cell => cell.resultRef.accessMode === 'ai' && cell.resultRef.complete));
    if (live) {
      // Recovery is allowed; only the final verified artifact may pass the oracle.
      report.execution.recoveredToolFailures = report.execution.failedTools.length;
      const definitions = task.notebookArtifact.cells, results = new Map(observedRun.cells.map(cell => [cell.cellId, cell]));
      const warehouses = definitions.filter(cell => cell.kind === 'warehouseSql');
      const tables = definitions.filter(cell => cell.kind === 'table'), charts = definitions.filter(cell => cell.kind === 'chart');
      assert.equal(warehouses.length, 1); assert.equal(tables.length, 1); assert.equal(charts.length, 1);
      assert.ok(definitions.every(cell => ['warehouseSql', 'sql', 'table', 'chart'].includes(cell.kind)));
      const sourceResult = results.get(warehouses[0].id), tableResult = results.get(tables[0].id), chartResult = results.get(charts[0].id);
      const normalized = rows => rows.map(row => {
        assert.match(row.month, /^\d{4}-\d{2}$/u);
        assert.ok(Number.isSafeInteger(Number(row.order_count))); assert.ok(Number.isSafeInteger(Number(row.revenue_cents)));
        return { month: row.month, order_count: Number(row.order_count), revenue_cents: Number(row.revenue_cents) };
      }).sort((a, b) => a.month.localeCompare(b.month));
      assert.deepEqual(normalized(sourceResult.table.rows), monthlyRows);
      assert.deepEqual(normalized(tableResult.table.rows), monthlyRows);
      assert.equal(charts[0].categoryField, 'month'); assert.ok(charts[0].valueFields.includes('order_count'));
      const chartRows = chartResult.table.rows.map(row => ({ month: row.month, order_count: Number(row.order_count) })).sort((a, b) => a.month.localeCompare(b.month));
      assert.deepEqual(chartRows, monthlyRows.map(({ month, order_count }) => ({ month, order_count })));
      assert.equal(sourceResult.resultRef.connectionId, connectionId); assert.equal(sourceResult.resultRef.catalogRef.id, schema.catalog.id);
      const dependenciesReachWarehouse = (id, visited = new Set()) => {
        assert.ok(!visited.has(id), 'Result lineage must be acyclic'); visited.add(id);
        const result = results.get(id); assert.ok(result);
        if (id === warehouses[0].id) return;
        assert.ok(result.resultRef.inputResultIds.length > 0);
        for (const input of result.resultRef.inputResultIds) {
          const parent = observedRun.cells.find(cell => cell.resultRef.resultId === input); assert.ok(parent);
          dependenciesReachWarehouse(parent.cellId, new Set(visited));
        }
      };
      for (const definition of definitions) dependenciesReachWarehouse(definition.id);
      assert.deepEqual([...task.notebookArtifact.executionEvidence.completedCellIds].sort(), definitions.map(cell => cell.id).sort());
    } else {
      assert.equal(task.counters.toolCallCount, 6); assert.equal(task.counters.modelCallCount, 7);
      assert.deepEqual(task.notebookArtifact.executionEvidence.completedCellIds, ['monthly', 'annual', 'table', 'chart']);
      assert.deepEqual(report.execution.successfulTools, actions.map(action => action.name));
      assert.deepEqual(observedRun.cells[0].table.rows, monthlyRows);
      assert.deepEqual(observedRun.cells[1].table.rows, annualRows); assert.deepEqual(observedRun.cells[2].table.rows, annualRows);
      assert.deepEqual(observedRun.cells[3].table.rows, annualRows.map(({ sales_year, revenue_cents }) => ({ sales_year, revenue_cents })));
      assert.deepEqual(observedRun.cells[1].resultRef.inputResultIds, [observedRun.cells[0].resultRef.resultId]);
      assert.equal(observedRun.cells[0].resultRef.connectionId, connectionId); assert.equal(observedRun.cells[0].resultRef.catalogRef.id, schema.catalog.id);
    }
    report.success = { taskState: task.state, toolCalls: task.counters.toolCallCount, modelCalls: task.counters.modelCallCount, monthlyRows: 38, orderCount: 31465,
      ...(!live ? { annualRows } : {}), exactNumericPreserved: true, lineageVerified: true, completedFrames: 1, formalDocumentUnchanged: true,
      adopted: false, persistedToUserProject: false };
    report.checks.push(live ? 'Official SDK + real model authored SQL/table/chart; actual real PostgreSQL results and lineage match an independent reader query.'
      : 'Official SDK→six business tools→real PostgreSQL→DuckDB→table/chart→verified submission matches an independent reader query.');

    report.stage = 'readonly-table-access';
    await assert.rejects(connections.executeConnectionSql({ ...scope, sql: 'SELECT * FROM person.password' }), /42501/);
    report.ungrantedTableDenied = true;
    if (!live) {
    report.stage = 'readonly-cancellation';
    const cancelController = new AbortController();
    const cancelledRequest = structuredClone(request); cancelledRequest.idempotencyKey = `dsh_aw_cancel_${crypto.randomUUID().replaceAll('-', '')}`;
    const slow = { ...cells[0], sql: 'SELECT pg_sleep(5) AS wait' };
    const cancelDriver = driverModule.createOfficialDshDriver(() => ({ mode: 'fixture', actions: [
      { name: 'editNotebookCells', args: { editVersion: 0, cells: [slow] } }, { name: 'runNotebookCells', args: { editVersion: 1 } },
    ] }));
    let driverSettled = false, queryAttempted = false, querySignal, cancelTimer;
    const cancelExecute = executorModule.createAgentExecutor(async input => {
      sdkStarted++; try { return await cancelDriver(input); } finally { driverSettled = true; }
    });
    try {
      const cancelled = await cancelExecute('dsh', cancelledRequest, { ...options, signal: cancelController.signal,
        notebookRunner: (artifact, context) => notebook.runNotebook({ document: { name: artifact.name, revision: artifact.baseRevision, cells: artifact.cells }, sources: [],
          forAi: true, signal: context.signal, log() {}, connectionQuery: (id, query, signal) => {
            queryAttempted = true; querySignal = signal; cancelTimer = setTimeout(() => cancelController.abort(), 150);
            return connections.executeConnectionSql({ ...scope, connectionId: id, sql: query, signal });
          } }),
      });
      assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.notebookArtifact, undefined);
      assert.equal(queryAttempted, true); assert.equal(querySignal.aborted, true); assert.equal(driverSettled, true);
      assert.deepEqual(cancelledRequest.notebookContext.document, request.notebookContext.document);
    } finally { clearTimeout(cancelTimer); }
    const retry = await connections.executeConnectionSql({ ...scope, sql: 'SELECT COUNT(*)::integer AS orders FROM sales.salesorderheader' });
    assert.deepEqual(retry.rows, [{ orders: 31465 }]);
    report.cancellation = { queryAttempted, querySignalAborted: querySignal.aborted, driverSettledAtTaskReturn: driverSettled,
      draftWithheld: true, retryOrderCount: retry.rows[0].orders, ungrantedTableDenied: true };
    report.checks.push('Ungranted table denied; SDK task cancellation reaches the real PostgreSQL query, withholds draft, reaps SDK and allows retry.');
    }
    report.authorizations = authorizationChecks; report.sdkTasks = sdkStarted;
    report.passed = true; report.stage = 'completed';
  } catch (error) {
    // Do not serialize raw provider errors, assertions with private arguments, or machine paths.
    const line = error instanceof Error ? error.stack?.match(/verify-dsh-adventureworks\.mjs:(\d+):\d+/u)?.[1] : undefined;
    report.failure = { name: error instanceof Error ? error.name : 'UnknownError', stage: report.stage,
      ...(line ? { acceptanceLine: Number(line) } : {}) };
    process.exitCode = 1;
  } finally {
    try { await vite?.close(); }
    finally {
      try { await owned?.client.end(); }
      finally {
        globalThis.fetch = originalFetch; process.env = savedEnvironment;
        report.finishedAt = new Date().toISOString(); report.rejectedParentFetches = rejectedParentFetches;
        report.toolFailures = toolFailures;
        report.limits = [live ? 'One bounded live model task; no repeat/cancellation paid task. The caller-owned gateway enforces the cost budget.' : 'Fixed actions test real execution, not real model SQL generation.', 'No browser or public HTTP handler exercised here; SSE uses the production adapter in process.',
          'No database setup/restore/write, user project adoption, website config change or production deployment.',
          live ? 'SDK model traffic uses only a caller-owned loopback gateway; upstream model access and billing evidence belong to that caller.' : 'Parent HTTP fetch is forbidden; the official SDK fixture child accesses only its authenticated loopback tool broker.',
          'Chart monetary cents are explicitly checked as safe integers; general decimal-to-float conversion is not claimed lossless.'];
        await save('report.json', report);
      }
    }
  }
  return report;
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--runtime-dir' || args[2] !== '--evidence-dir') {
    console.error('Use --runtime-dir ABSOLUTE_OWNED_RUNTIME --evidence-dir ABSOLUTE_NEW_SITE_RUNTIME_CHILD'); process.exitCode = 1;
  } else {
    try {
      const evidenceDir = path.resolve(args[3]);
      const report = await verifyDshAdventureWorks({ runtimeDir: args[1], evidenceDir });
      console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, stage: report.stage,
        report: path.relative(site, path.join(evidenceDir, 'report.json')).replaceAll('\\', '/') }));
    } catch {
      console.error('Read-only DSH database acceptance could not initialize; existing files and services were preserved.'); process.exitCode = 1;
    }
  }
}
