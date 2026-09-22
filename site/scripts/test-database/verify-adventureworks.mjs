import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { createServer } from "vite";
import { CORE_TABLES, validateOwner, parsePostmasterPid, run as runProcess } from "./adventureworks.mjs";

// Real PostgreSQL + real source application code. No HTTP listener, model API,
// website settings, existing projects, or imported dump processing in this script.
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
assert.equal(args.length, 4, "Use --runtime-dir ABSOLUTE_OWNED_RUNTIME --evidence-dir ABSOLUTE_NEW_DIRECTORY");
assert.equal(args[0], "--runtime-dir");
assert.equal(args[2], "--evidence-dir");
assert.ok(path.isAbsolute(args[1]) && path.isAbsolute(args[3]));
assert.equal(path.resolve(process.cwd()), site, "Run this verification from site/");
const runtimeDir = path.resolve(args[1]);
const evidenceDir = path.resolve(args[3]);
const owner = validateOwner(JSON.parse(await readFile(path.join(runtimeDir, "owner.json"), "utf8")), runtimeDir);
assert.equal(owner.phase, "ready", "Only verify a successfully restored, task-owned database");
const pid = parsePostmasterPid(await readFile(path.join(owner.dataDir, "postmaster.pid"), "utf8"), owner);
const probe = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; @{ executable=$p.ExecutablePath; listeners=@(Get-NetTCPConnection -State Listen -LocalPort ${owner.port} | Select-Object LocalAddress,OwningProcess) } | ConvertTo-Json -Compress`;
const processIdentity = JSON.parse(await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe]));
assert.equal(path.resolve(processIdentity.executable).toLowerCase(), path.join(owner.binDir, "postgres.exe").toLowerCase());
assert.ok(processIdentity.listeners.length > 0);
assert.ok(processIdentity.listeners.every((item) => item.LocalAddress === "127.0.0.1" && item.OwningProcess === pid));
// Deliberately do not use the administrative fields in the private file.
const { ownerId, username, password } = JSON.parse(await readFile(path.join(runtimeDir, "credentials.private.json"), "utf8"));
assert.equal(ownerId, owner.id);
assert.equal(username, owner.readerUser);
assert.match(password, /^[0-9a-f]{64}$/);
const referenceClient = new Client({ host: owner.host, port: owner.port, database: owner.database, user: username,
  password, ssl: false, connectionTimeoutMillis: 5000, query_timeout: 15000, application_name: "AgentCanvas-real-pg-acceptance-reference" });
await referenceClient.connect();
const identity = (await referenceClient.query("SELECT current_database() AS database, current_user AS username, current_setting('cluster_name') AS cluster, host(inet_server_addr()) AS address, inet_server_port() AS port")).rows[0];
assert.deepEqual(identity, { database: owner.database, username, cluster: owner.clusterName, address: owner.host, port: owner.port });

// mkdir must reject an existing directory. All persistence below belongs to this run.
await mkdir(evidenceDir, { mode: 0o700 });
const stateDir = path.join(evidenceDir, "isolated-state");
await mkdir(stateDir, { mode: 0o700 });
process.env.STUDIO_LOCAL_STATE_DIR = stateDir;
delete process.env.STUDIO_SQL_CONNECTIONS;
process.env.AW_ACCEPTANCE_READER_PASSWORD = password;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Network/model HTTP requests are forbidden in this real-database acceptance script"); };
const report = { startedAt: new Date().toISOString(), databaseRuntimeId: owner.id, realPostgres: true, remoteModelCalls: 0,
  scriptedModel: true, noHttpListener: true, checks: [], limits: [], status: "running" };
const save = async (name, value) => {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  assert.ok(!json.includes(password), "Credentials must never enter acceptance evidence");
  await writeFile(path.join(evidenceDir, name), json, { flag: "wx", mode: 0o600 });
};
const vite = await createServer({ root: site, configFile: false, envFile: false, cacheDir: path.join(evidenceDir, ".vite-cache"),
  logLevel: "error", server: { middlewareMode: true, hmr: false, watch: null }, resolve: { alias: { "@": site } } });
try {
  const [connection, config, projects, notebook, notebookRoute, provenance, dashboard, changes, data, clientState] = await Promise.all([
    vite.ssrLoadModule("/core/connections/server/query.ts"), vite.ssrLoadModule("/core/connections/server/config.ts"),
    vite.ssrLoadModule("/core/projects/server/store.ts"), vite.ssrLoadModule("/core/notebook/server/runtime.ts"),
    vite.ssrLoadModule("/app/api/notebook/run/route.ts"), vite.ssrLoadModule("/core/notebook/provenance.ts"),
    vite.ssrLoadModule("/core/notebook/dashboard.ts"), vite.ssrLoadModule("/core/changesets/index.ts"),
    vite.ssrLoadModule("/core/data/index.ts"), vite.ssrLoadModule("/core/notebook/client-state.ts"),
  ]);
  const project = projects.openProject(path.join(evidenceDir, "project"), "AdventureWorks real database acceptance");
  const connectionId = "adventureworks_acceptance";
  const connectionConfig = { id: connectionId, name: "AdventureWorks acceptance reader", kind: "postgresql", host: owner.host,
    port: owner.port, database: owner.database, user: username, passwordEnv: "AW_ACCEPTANCE_READER_PASSWORD", ssl: false,
    projects: [project.handle], allowAi: false };
  const configure = (allowAi) => { connectionConfig.allowAi = allowAi; process.env.STUDIO_SQL_CONNECTIONS = JSON.stringify([connectionConfig]); };
  configure(false);
  const connectionInput = { connectionId, project: project.handle };
  assert.equal(config.listConnections(project.handle).length, 1);
  assert.equal(config.listConnections(project.handle, true).length, 0);
  assert.equal(config.listConnections(randomUUID()).length, 0);
  await assert.rejects(connection.executeConnectionSql({ ...connectionInput, forAi: true, sql: "SELECT 1 AS value" }), /未授权/);
  const connectionRoute = await vite.ssrLoadModule("/app/api/connections/route.ts");
  const publicList = await connectionRoute.GET(new Request("http://127.0.0.1:3001/api/connections", { headers: {
    origin: "http://127.0.0.1:3001", "x-agentcanvas-project": project.handle,
  } }));
  assert.equal(publicList.status, 200);
  assert.deepEqual(await publicList.json(), { connections: [{ id: connectionId, name: connectionConfig.name, kind: "postgresql", allowAi: false }] });
  report.checks.push("Project scoping and default Agent denial are enforced before querying.");

  const schema = await connection.inspectConnectionSchema({ ...connectionInput, refresh: true });
  const discoveredTables = [...new Set(schema.columns.map((column) => `${column.table_schema}.${column.table_name}`))].sort();
  assert.deepEqual(discoveredTables, [...CORE_TABLES].sort());
  assert.equal(schema.truncated, false);
  assert.equal(schema.catalog.complete, true);
  assert.equal(schema.catalog.tableCount, 10);
  report.catalog = { tableCount: discoveredTables.length, columnCount: schema.columns.length, complete: true, reference: schema.catalog };
  report.checks.push("The real reader catalog exposes exactly the ten granted tables and a complete versioned schema.");

  const monthlyBase = "SELECT to_char(date_trunc('month', orderdate), 'YYYY-MM') AS month, COUNT(*)::integer AS order_count, ROUND(SUM(subtotal) * 100)";
  const monthlyTail = " FROM sales.salesorderheader GROUP BY date_trunc('month', orderdate) ORDER BY month";
  const monthlySql = `${monthlyBase}::double precision AS revenue_cents${monthlyTail}`;
  const oracle = (await referenceClient.query(`${monthlyBase}::bigint AS revenue_cents${monthlyTail}`)).rows;
  assert.equal(oracle.length, 38);
  assert.equal(oracle.reduce((sum, row) => sum + row.order_count, 0), 31465);
  const expected = oracle.map((row) => {
    const revenue = Number(row.revenue_cents);
    assert.ok(Number.isSafeInteger(revenue));
    assert.equal(BigInt(revenue).toString(), row.revenue_cents);
    return { ...row, revenue_cents: revenue };
  });
  const monthly = await connection.executeConnectionSql({ ...connectionInput, sql: monthlySql });
  assert.deepEqual(monthly.rows, expected);
  assert.equal(monthly.truncated, false);
  assert.equal(monthly.catalogRef.id, schema.catalog.id);
  const preciseSql = "SELECT salesorderid, subtotal FROM sales.salesorderheader ORDER BY salesorderid LIMIT 5";
  const precise = await connection.executeConnectionSql({ ...connectionInput, sql: preciseSql });
  assert.deepEqual(precise.rows, (await referenceClient.query(preciseSql)).rows);
  assert.ok(precise.rows.every((row) => typeof row.subtotal === "string"));
  const territorySql = "SELECT t.name AS territory, COUNT(*)::integer AS order_count, SUM(h.subtotal) AS subtotal_exact, SUM(h.subtotal)::double precision AS revenue FROM sales.salesorderheader h JOIN sales.salesterritory t ON t.territoryid = h.territoryid GROUP BY t.name ORDER BY t.name";
  const territoryReference = (await referenceClient.query(territorySql)).rows;
  const territoryOutput = await connection.executeConnectionSql({ ...connectionInput, sql: territorySql });
  assert.equal(territoryReference.length, 10);
  assert.equal(territoryReference.reduce((sum, row) => sum + row.order_count, 0), 31465);
  assert.deepEqual(territoryOutput.rows, territoryReference);
  assert.ok(territoryOutput.rows.every((row) => typeof row.subtotal_exact === "string" && typeof row.revenue === "number"));
  const exactSum = await connection.executeConnectionSql({ ...connectionInput, sql: "SELECT SUM(subtotal) AS numeric_sum, SUM(subtotal)::text AS text_sum FROM sales.salesorderheader" });
  assert.equal(typeof exactSum.rows[0].numeric_sum, "string");
  assert.equal(exactSum.rows[0].numeric_sum, exactSum.rows[0].text_sum);
  report.territory = { groups: 10, orderCount: 31465, exactSubtotal: exactSum.rows[0].numeric_sum,
    chartConversion: "Explicit PostgreSQL double precision is compared to an independent database query; not a claim of lossless decimal conversion." };
  report.baseline = { orderCount: 31465, months: 38, firstMonth: expected[0].month, lastMonth: expected.at(-1).month,
    monthlyRoundedRevenueCents: oracle.reduce((sum, row) => sum + BigInt(row.revenue_cents), 0n).toString() };
  report.checks.push("Real driver results match a separate pg-client reference; numeric subtotal remains exact text and chart cents are explicitly safe integers.");

  const document = { name: "AdventureWorks monthly sales", revision: 0, cells: [
    { id: "monthly", kind: "warehouseSql", title: "Monthly sales from PostgreSQL", connectionId, outputName: "monthly_sales", sql: monthlySql },
    { id: "annual", kind: "sql", title: "Annual rollup in DuckDB", inputCellIds: ["monthly"], outputName: "annual_sales",
      sql: "SELECT substr(month, 1, 4) AS sales_year, SUM(order_count)::INTEGER AS order_count, SUM(revenue_cents)::DOUBLE AS revenue_cents FROM monthly_sales GROUP BY sales_year ORDER BY sales_year" },
    { id: "table", kind: "table", title: "Annual sales table", inputCellId: "annual", columns: ["sales_year", "order_count", "revenue_cents"] },
    { id: "chart", kind: "chart", title: "Annual sales chart", inputCellId: "annual", chartType: "bar", categoryField: "sales_year", valueFields: ["revenue_cents"] },
  ] };
  const annualExpected = Object.values(expected.reduce((groups, row) => {
    const year = row.month.slice(0, 4);
    groups[year] ??= { sales_year: year, order_count: 0, revenue_cents: 0 };
    groups[year].order_count += row.order_count;
    groups[year].revenue_cents += row.revenue_cents;
    return groups;
  }, {}));
  const request = (body) => new Request("http://127.0.0.1:3001/api/notebook/run", { method: "POST", headers: {
    origin: "http://127.0.0.1:3001", "content-type": "application/json", "x-agentcanvas-project": project.handle,
  }, body: JSON.stringify({ pageId: "page_acceptance", ...body }) });
  const route = async (body, expectedStatus = 200) => {
    const response = await notebookRoute.POST(request(body));
    const payload = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(payload.error ?? {}));
    return payload;
  };
  const { run } = await route({ document, action: "run" });
  assert.equal(run.status, "success", JSON.stringify(run.cells.map((cell) => ({ id: cell.cellId, error: cell.error }))));
  assert.deepEqual(run.cells.map((cell) => cell.cellId), ["monthly", "annual", "table", "chart"]);
  assert.deepEqual(run.cells[0].table.rows, expected);
  assert.deepEqual(run.cells[1].table.rows, annualExpected);
  assert.deepEqual(run.cells[2].table.rows, annualExpected);
  assert.deepEqual(run.cells[3].table.rows, annualExpected.map(({ sales_year, revenue_cents }) => ({ sales_year, revenue_cents })));
  for (const cell of run.cells) {
    assert.equal(cell.resultRef.runId, run.runId);
    assert.equal(cell.resultRef.accessMode, "user");
    assert.equal(cell.resultRef.complete, true);
  }
  assert.deepEqual(run.cells[1].resultRef.inputResultIds, [run.cells[0].resultRef.resultId]);
  report.checks.push("Actual Notebook API implementation runs PostgreSQL → DuckDB SQL → table/chart with matching values and linked complete result references.");

  // Keep the original eight checks intact; this separate current-run document
  // verifies the controlled narrative path against an independent pg query.
  const narrativeSql = "SELECT COUNT(*)::integer AS order_count, SUM(subtotal) AS subtotal_exact, to_char(MIN(orderdate), 'YYYY-MM-DD') AS first_day FROM sales.salesorderheader";
  const narrativeReference = (await referenceClient.query(narrativeSql)).rows;
  assert.equal(narrativeReference.length, 1);
  assert.equal(narrativeReference[0].order_count, 31465);
  assert.equal(typeof narrativeReference[0].subtotal_exact, "string");
  assert.equal(narrativeReference[0].subtotal_exact, exactSum.rows[0].numeric_sum);
  const narrativeDocument = { name: "AdventureWorks scalar narrative", revision: 3, cells: [
    { id: "narrative", kind: "text", title: "Actual database summary",
      markdown: "Orders {{count}}; exact subtotal {{subtotal}}; first order {{first}}.",
      references: [{ key: "count", cellId: "summary", field: "order_count" },
        { key: "subtotal", cellId: "summary", field: "subtotal_exact" },
        { key: "first", cellId: "summary", field: "first_day" }] },
    { id: "summary", kind: "warehouseSql", title: "Single-row PostgreSQL aggregate", connectionId,
      outputName: "summary_rows", sql: narrativeSql },
  ] };
  const narrativeBefore = structuredClone(narrativeDocument);
  const { run: narrativeRun } = await route({ document: narrativeDocument, targetCellId: "narrative", action: "run" });
  assert.equal(narrativeRun.status, "success", JSON.stringify(narrativeRun.cells.map((cell) => ({ id: cell.cellId, error: cell.error }))));
  assert.notEqual(narrativeRun.runId, run.runId);
  assert.equal(narrativeRun.revision, 3);
  assert.deepEqual(narrativeRun.cells.map((cell) => cell.cellId), ["summary", "narrative"]);
  const [summaryResult, narrativeResult] = narrativeRun.cells;
  assert.deepEqual(summaryResult.table.rows, narrativeReference);
  assert.equal(summaryResult.table.truncated, false);
  assert.equal(summaryResult.resultRef.runId, narrativeRun.runId);
  assert.equal(summaryResult.resultRef.complete, true);
  assert.equal(summaryResult.resultRef.rowCount, 1);
  assert.equal(summaryResult.resultRef.accessMode, "user");
  const expectedNarrative = `Orders ${narrativeReference[0].order_count}; exact subtotal ${narrativeReference[0].subtotal_exact}; first order ${narrativeReference[0].first_day}.`;
  assert.equal(narrativeResult.status, "success");
  assert.equal(narrativeResult.text, expectedNarrative);
  assert.equal(Object.hasOwn(narrativeResult, "table"), false);
  assert.equal(Object.hasOwn(narrativeResult, "resultRef"), false);
  assert.deepEqual(narrativeDocument, narrativeBefore);
  report.narrative = { sourceRowCount: 1, complete: true, text: narrativeResult.text,
    mode: "controlled-text", tableOrResultHandleCreated: false, independentPgReference: true };
  report.checks.push("Real PostgreSQL single-row count/exact decimal/date aggregate feeds controlled text; current-run output matches an independent pg oracle without a table/result handle.");

  // Automatic scheduling is tested in the browser separately. Here exercise its
  // exact closed-subgraph and cache rules with real PostgreSQL and the same API.
  const [recompute, cache] = await Promise.all([
    vite.ssrLoadModule("/core/notebook/parameter-recompute.ts"),
    vite.ssrLoadModule("/core/notebook/result-cache.ts"),
  ]);
  const parameterDocument = { name: "Read-only shared ancestor recompute", revision: 4, cells: [
    { id: "factor", kind: "parameter", title: "Scale", outputName: "factor_value", parameter: { type: "number", value: 2 } },
    { ...narrativeDocument.cells[1] },
    { id: "scaled", kind: "sql", title: "Parameter dependent count", outputName: "scaled_rows", inputCellIds: ["summary", "factor"],
      sql: "SELECT order_count * value AS scaled_count FROM summary_rows CROSS JOIN factor_value" },
    { id: "scaled_note", kind: "text", title: "Parameter dependent narrative", markdown: "Scaled orders {{count}}.",
      references: [{ key: "count", cellId: "scaled", field: "scaled_count" }] },
    { id: "independent", kind: "sql", title: "Unchanged shared-input branch", outputName: "original_rows", inputCellIds: ["summary"],
      sql: "SELECT order_count AS original_count FROM summary_rows" },
  ] };
  const parameterBefore = structuredClone(parameterDocument);
  const parameterRun = (await route({ document: parameterDocument, action: "run" })).run;
  assert.equal(parameterRun.status, "success");
  const parameterCache = cache.cacheNotebookRun(parameterDocument, parameterRun,
    (id) => clientState.notebookFingerprint(parameterDocument, id, [], []));
  const nextParameters = { ...parameterDocument, revision: 5, cells: parameterDocument.cells.map((cell) => cell.id === "factor"
    ? { ...cell, parameter: { type: "number", value: 3 } } : cell) };
  const changedParameters = recompute.parameterValueChanges(parameterDocument, nextParameters);
  assert.deepEqual(changedParameters, ["factor"]);
  const selected = recompute.selectParameterRecompute(nextParameters, changedParameters);
  assert.deepEqual(selected.affectedCellIds, ["factor", "scaled", "scaled_note"]);
  assert.deepEqual(selected.executionCellIds, ["factor", "summary", "scaled", "scaled_note"]);
  assert.equal(selected.document.revision, 5);
  assert.equal(selected.document.cells.some((cell) => cell.id === "independent"), false);
  const recomputed = (await route({ document: selected.document, action: "run" })).run;
  assert.equal(recomputed.status, "success");
  const merged = { ...cache.invalidateNotebookCachedResults(parameterCache, selected.affectedCellIds),
    ...cache.cacheNotebookRun(selected.document, recomputed, (id) => clientState.notebookFingerprint(nextParameters, id, [], [])) };
  assert.equal(merged.scaled_note.result.text, `Scaled orders ${narrativeReference[0].order_count * 3}.`);
  assert.equal(merged.independent, parameterCache.independent);
  assert.notEqual(merged.summary.result.resultRef.resultId, parameterCache.summary.result.resultRef.resultId);
  assert.equal(merged.summary.result.resultRef.dataSignature, parameterCache.summary.result.resultRef.dataSignature);
  for (const id of nextParameters.cells.map((cell) => cell.id)) {
    assert.equal(cache.isNotebookCachedResultFresh(id, merged, { fingerprint: (cellId) => clientState.notebookFingerprint(nextParameters, cellId, [], []) }), true, id);
  }
  assert.deepEqual(parameterDocument, parameterBefore);
  report.parameterRecompute = { affected: selected.affectedCellIds, executed: selected.executionCellIds,
    changedValue: 3, text: merged.scaled_note.result.text, independentRunPreserved: true, sharedInputFullSignatureUnchanged: true };
  report.checks.push("Parameter value change executes only its affected chain plus a required real PostgreSQL ancestor; identical full input content preserves the unexecuted independent branch without reusing preview rows.");
  await save("parameter-recompute-document.json", selected.document);
  await save("parameter-recompute-run.json", recomputed);

  const snapshot = await route({ document, targetCellId: "chart", action: "dataset" });
  const saved = snapshot.snapshot;
  assert.equal(saved.dataset.storageMode, "project");
  assert.equal(saved.dataset.aiAccessPolicy, "pending");
  assert.equal(saved.dataset.expiresAt, undefined);
  assert.deepEqual(saved.rows, run.cells[3].table.rows);
  assert.deepEqual(saved.dataset.provenance, provenance.notebookDatasetProvenance(document, snapshot.run, "chart"));
  assert.deepEqual(saved.dataset.provenance.lineage.steps.map((step) => step.cellId), ["monthly", "annual", "chart"]);
  assert.equal(saved.dataset.provenance.lineage.steps[0].catalogRef.id, schema.catalog.id);
  const reopened = new projects.LocalProjectStore(project.path);
  assert.deepEqual(reopened.getTable(saved.dataset.datasetId), saved);
  report.checks.push("Explicit dataset save persists actual results/provenance; reopening preserves types and lineage, no TTL, and pending AI consent.");

  const page = { id: "page_acceptance", title: "Database acceptance", route: "/acceptance", root: { id: "root_acceptance", type: "PageRoot", props: {}, children: [] } };
  const appSpec = { id: "app_acceptance", siteId: "site_acceptance", schemaVersion: "1.0", dataSources: [saved.dataset.source],
    navigation: [{ id: "nav_acceptance", title: page.title, pageId: page.id }], pages: [page] };
  const changeSet = dashboard.notebookDashboardPreview(page, document.cells.at(-1), saved, "acceptance");
  const original = changes.createExecutionState(appSpec);
  const preview = changes.previewChangeSet(original, changeSet);
  assert.deepEqual(preview.present, original.present);
  assert.equal(original.present.pages[0].root.children.length, 0);
  const applied = changes.applyChangeSet(preview, changeSet);
  const chartNode = applied.present.pages[0].root.children[0];
  const points = data.executeChartBinding(chartNode.props.binding, applied.present.dataSources, { rowsByDataSourceId: { [saved.dataset.datasetId]: saved.rows } });
  assert.deepEqual(points.labels, annualExpected.map((row) => row.sales_year));
  assert.deepEqual(points.values, annualExpected.map((row) => row.revenue_cents));
  assert.deepEqual(changes.undoLastChange(applied).present, original.present);
  const persisted = { version: 6, appSpec: applied.present, dataProduct: { id: "product_acceptance", name: page.title, schemaVersion: "1.0",
    datasets: [{ id: saved.dataset.datasetId, name: saved.dataset.source.name, workspaceId: page.id, shared: true, rowCount: saved.rows.length,
      columnCount: saved.dataset.source.fields.length, qualityScore: saved.dataset.source.qualityScore, aiAccessPolicy: "pending" }],
    recipes: [], notebooks: { [page.id]: document }, appSpec: applied.present }, changeHistory: applied.history,
    appliedChangeSetIds: applied.appliedChangeSetIds, auditRecords: [], queryRecords: [], harnessTasks: [], assistantConversation: [],
    assistantConversationInitialized: true, assistantSessions: null, edsWorkspace: null, savedAt: new Date().toISOString() };
  assert.equal(reopened.saveState(persisted, 0), 1);
  const reopenedAgain = new projects.LocalProjectStore(project.path);
  assert.deepEqual(reopenedAgain.read().state.dataProduct.notebooks[page.id], document);
  // The project format is JSON: absent optional properties and undefined are
  // equivalent at its persistence boundary, unlike a JavaScript object clone.
  assert.deepEqual(reopenedAgain.read().state.appSpec, JSON.parse(JSON.stringify(applied.present)));
  report.checks.push("Dashboard snapshot preview leaves the canvas unchanged; explicit apply produces matching chart bindings, undo restores it, and project state reopens intact.");

  const largeDocument = { name: "Truncation boundary", revision: 0, cells: [
    { ...document.cells[0], sql: "SELECT salesorderid, subtotal FROM sales.salesorderheader ORDER BY salesorderid" },
    { ...document.cells[1], sql: "SELECT COUNT(*) AS n FROM monthly_sales" },
    { ...document.cells[2], columns: ["n"] },
  ] };
  const boundary = await route({ document: largeDocument, action: "run" });
  assert.equal(boundary.run.status, "failure");
  assert.equal(boundary.run.cells[0].table.rows.length, 1000);
  assert.equal(boundary.run.cells[0].table.truncated, true);
  assert.equal(boundary.run.cells[0].resultRef.complete, false);
  assert.equal(boundary.run.cells[1].status, "failure");
  assert.equal(boundary.run.cells[2].status, "blocked");
  const truncatedSave = await route({ document: largeDocument, targetCellId: "monthly", action: "dataset" }, 400);
  assert.match(truncatedSave.error.message, /截断/);
  await assert.rejects(connection.executeConnectionSql({ ...connectionInput, sql: "SELECT * FROM person.password" }), /42501/);
  const cancellation = new AbortController();
  const cancelTimer = setTimeout(() => cancellation.abort(), 150);
  try { await assert.rejects(connection.executeConnectionSql({ ...connectionInput, sql: "SELECT pg_sleep(5) AS wait", signal: cancellation.signal }), /取消或超时/); }
  finally { clearTimeout(cancelTimer); }
  assert.deepEqual((await connection.executeConnectionSql({ ...connectionInput, sql: "SELECT COUNT(*)::integer AS count FROM sales.salesorderheader" })).rows, [{ count: 31465 }]);
  report.checks.push("Real >1000-row results are marked incomplete, downstream calculation/save is refused, denied tables stay denied, and cancelled queries can be retried.");

  // Test double chooses actions only; all tool execution, SQL, data and validation remain real.
  configure(true);
  const { HarnessRuntime } = await vite.ssrLoadModule("/core/harness/runtime.ts");
  const initialBook = { name: document.name, revision: 0, cells: [{ id: "note", kind: "text", title: "Preserve this cell", markdown: "Real PostgreSQL acceptance; generated actions use a deterministic test double." }] };
  const harnessRequest = { idempotencyKey: `aw_acceptance_${randomUUID().replaceAll("-", "")}`, instruction: "在当前 Notebook 添加数据库 SQL 汇总、表格和图表单元，运行验证后提交待确认草稿。",
    role: "editor", pageId: page.id, appSpec: { ...appSpec, dataSources: [] }, recipes: [],
    notebookContext: { document: initialBook, sourceIds: [], connections: config.listConnections(project.handle, true) } };
  const untouched = structuredClone(harnessRequest);
  const calls = [["cellSearch", {}], ["editNotebookCells", { editVersion: 0, cells: document.cells }], ["runNotebookCells", { editVersion: 1 }], ["submitNotebookDraft", { editVersion: 1 }]];
  const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
  let scriptCalls = 0;
  const task = await new HarnessRuntime().run(harnessRequest, { dataRuntime: { rowsByDataSourceId: {} },
    allowFailureExplanation: false,
    modelClient: {
      classifyIntent: async () => ({ model: "explicit-scripted-router", inputChars: 100, usage,
        decision: { mode: "readOnlyTask", wantsNotebook: true, wantsData: true, wantsEdsAnalysis: false, wantsRawWorkbook: false,
          wantsFields: false, wantsRecipe: false, wantsAppInspection: false, wantsExcel: false, changeAction: "none", changeTarget: "none",
          componentKind: "none", chartType: "auto", skillIds: [], confidence: 1, rationale: "Deterministic wiring acceptance only" } }),
      plan: async ({ fallbackPlan }) => ({ plan: fallbackPlan, model: "explicit-scripted-planner", inputChars: 100, usage }),
      next: async (input) => {
        const call = calls[scriptCalls++];
        assert.ok(call, "Unexpected retry in deterministic acceptance");
        const [name, arguments_] = call;
        assert.ok(input.tools.some((tool) => tool.name === name), `Expected ${name} to be authorized`);
        return { model: "explicit-scripted-actions", usage, turn: { type: "callTool", name, arguments: arguments_, toolCallId: `aw_tool_${scriptCalls}`, message: "Execute real database acceptance step" } };
      },
    },
    connectionInspector: (id, signal) => connection.inspectConnectionSchema({ connectionId: id, project: project.handle, forAi: true, signal }),
    notebookRunner: (artifact, context) => notebook.runNotebook({ document: { name: artifact.name, revision: 0, cells: artifact.cells }, sources: [], forAi: true,
      signal: context.signal, taskId: "aw_scripted_harness", userId: "aw_acceptance", connectionQuery: (id, sql, signal) =>
        connection.executeConnectionSql({ connectionId: id, sql, signal, project: project.handle, forAi: true }) }),
  });
  await save("harness-receipt.json", task);
  assert.equal(task.state, "awaitingConfirmation", task.error ?? "Harness did not produce a verified pending draft");
  assert.equal(task.verification.status, "passed");
  assert.equal(task.counters.toolCallCount, 4);
  assert.deepEqual(harnessRequest, untouched);
  assert.equal(task.notebookArtifact.executionEvidence.status, "success");
  const adopted = clientState.adoptNotebookDraft(initialBook, task.notebookArtifact);
  assert.equal(adopted.cells[0].id, "note");
  assert.equal(adopted.cells.length, 5);
  assert.throws(() => clientState.adoptNotebookDraft({ ...initialBook, revision: 1 }, task.notebookArtifact), /修改/);
  report.harness = { state: task.state, verification: task.verification.status, realToolCalls: task.counters.toolCallCount, scriptedActionCalls: scriptCalls, remoteModelCalls: 0 };
  report.checks.push("Scripted-model Harness performs real cell search/edit/PG+DuckDB execution/verified submission without auto-adoption; stale revisions are rejected.");

  const queryLog = JSON.parse(await readFile(path.join(stateDir, "notebook-query-log.json"), "utf8"));
  assert.ok(queryLog.queries.some((entry) => entry.connectionId === connectionId && entry.status === "success" && entry.catalogRef));
  assert.ok(queryLog.queries.some((entry) => entry.connectionId === "local-duckdb" && entry.status === "success"));
  assert.ok(queryLog.queries.every((entry) => entry.bytesScanned === null));
  report.queryReceipts = queryLog.queries.length;
  report.limits = [
    "Uses a real local PostgreSQL 16 database and real application modules, but no HTTP transport or browser rendering (covered separately).",
    "The model is an explicit scripted test double; this does not evaluate real LLM SQL generation or reasoning quality.",
    "Money is grouped at month level and rounded to integer cents before explicit float8 conversion; exact source numeric values remain strings.",
    "Catalog versions describe schema discovery, not database data versions; result references are execution evidence, not reusable full-result storage.",
    "Saved datasets/dashboard outputs are explicit snapshots, not live database bindings. Scan-byte counters remain unknown/null.",
  ];
  await save("notebook-document.json", document);
  await save("notebook-run.json", run);
  await save("narrative-document.json", narrativeDocument);
  await save("narrative-run.json", narrativeRun);
  await save("narrative-reference.json", narrativeReference);
  await save("monthly-reference.json", oracle);
  await save("territory-output.json", territoryOutput);
  await save("annual-output.json", annualExpected);
  await save("dataset-provenance.json", saved.dataset.provenance);
  await save("dashboard-changeset.json", changeSet);
  await save("boundary-run.json", boundary.run);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = { message: error.message, code: error.code ?? null };
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await save("report.json", report);
  await referenceClient.end();
  await vite.close();
  globalThis.fetch = originalFetch;
}
console.log(JSON.stringify({ status: report.status, passedChecks: report.checks.length, remoteModelCalls: 0, evidenceDirectory: evidenceDir,
  ...(report.failure ? { error: report.failure.message } : {}) }, null, 2));
