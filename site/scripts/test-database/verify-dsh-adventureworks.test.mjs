import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { summarizeDshAcceptanceToolError } from './verify-dsh-adventureworks.mjs';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let vite, bridgeModule, contracts, fixtures, engineModule, modelFetches = 0;
const originalFetch = globalThis.fetch;

before(async () => {
  globalThis.fetch = async () => { modelFetches++; throw new Error('No model or external network in this offline diagnostic'); };
  vite = await createServer({ root: site, configFile: false, envFile: false, logLevel: 'error',
    server: { middlewareMode: true, hmr: false, watch: null }, resolve: { alias: { '@': site } } });
  [bridgeModule, contracts, fixtures, engineModule] = await Promise.all([
    vite.ssrLoadModule('/core/harness/server/notebook-tool-bridge.ts'),
    vite.ssrLoadModule('/core/harness/contracts.ts'), vite.ssrLoadModule('/fixtures/demo-product.ts'),
    vite.ssrLoadModule('/core/agent-engines/server/dsh-engine.ts'),
  ]);
});
after(async () => { try { await vite?.close(); } finally { globalThis.fetch = originalFetch; } assert.equal(modelFetches, 0); });

function fixture(connectionInspector = async () => { throw new Error('No database queries in this diagnostic'); }) {
  assert.equal(fixtures.demoFixtureResult.success, true);
  const request = contracts.harnessRequestSchema.parse({ idempotencyKey: 'dsh_cell_search_offline', instruction: 'Inspect empty notebook',
    role: 'editor', pageId: 'page_home', appSpec: { ...structuredClone(fixtures.demoFixtureResult.data.dataProduct.appSpec), dataSources: [] }, recipes: [],
    notebookContext: { sourceIds: [], connections: [{ id: 'synthetic_db', name: 'Synthetic catalog', kind: 'postgresql', allowAi: true }],
      document: { name: 'Empty offline notebook', revision: 3, cells: [] } } });
  const bridge = bridgeModule.createNotebookToolBridge({ request, profile: 'notebook', dataRuntime: { rowsByDataSourceId: {} },
    authorizeCurrentAccess() {}, connectionInspector,
    notebookRunner: async () => { throw new Error('No notebook execution in this diagnostic'); } });
  return bridge;
}

test('empty DB-backed notebook supports omitted/default and explicit summary arguments without SQL or model calls', async () => {
  const bridge = fixture();
  try {
    for (const args of [{}, { query: '', view: 'summary' }, { query: 'sales', direction: 'self', editVersion: 0 }]) {
      const result = await bridge.execute('cellSearch', args);
      assert.equal(result.data.totalCells, 0); assert.equal(result.data.editVersion, 0);
      assert.deepEqual(result.data.cells, []);
    }
    const schema = bridge.catalog().find(tool => tool.name === 'cellSearch').parameters;
    assert.equal(schema.additionalProperties, false); assert.ok(!schema.required?.length);
    assert.equal(schema.properties.query.type, 'string'); assert.equal(schema.properties.view.default, 'source');
  } finally { bridge.close(); }
});

for (const [label, args, field, code] of [
  ['null optional query', { query: null }, 'query', 'invalid_type'],
  ['empty cell ID', { cellId: '' }, 'cellId', 'too_small'],
  ['unknown kind', { kind: 'all' }, 'kind', 'invalid_value'],
  ['undefined property', { private_user_payload: 'DO_NOT_RECORD_SECRET' }, '$', 'unrecognized_keys'],
  ['two mutually exclusive anchors', { cellId: 'one', variable: 'two' }, '$', 'custom'],
]) {
  test(`canonical schema rejects ${label} and acceptance diagnostics retain only safe schema facts`, async () => {
    const bridge = fixture(), tool = bridge.catalog().find(item => item.name === 'cellSearch');
    try {
      await assert.rejects(bridge.execute('cellSearch', args), error => {
        assert.equal(error.name, 'HarnessToolArgumentsError');
        assert.deepEqual(summarizeDshAcceptanceToolError(tool, error), { tool: 'cellSearch',
          errorCode: 'INVALID_TOOL_ARGUMENTS', issues: [{ field, code }] });
        assert.ok(!JSON.stringify(summarizeDshAcceptanceToolError(tool, error)).includes('DO_NOT_RECORD_SECRET'));
        return true;
      });
      assert.equal((await bridge.execute('cellSearch', {})).data.totalCells, 0);
    } finally { bridge.close(); }
  });
}

test('schema-valid traversal without anchor fails as a business precondition, not a schema defect', async () => {
  const bridge = fixture(), tool = bridge.catalog().find(item => item.name === 'cellSearch');
  try {
    await assert.rejects(bridge.execute('cellSearch', { direction: 'both' }), error => {
      assert.match(error.message, /需要指定 cellId 或 variable/u);
      assert.deepEqual(summarizeDshAcceptanceToolError(tool, error), { tool: 'cellSearch', errorCode: 'TOOL_EXECUTION_FAILED' });
      return true;
    });
  } finally { bridge.close(); }
});

test('busy bridge rejects concurrent discovery but a later sequential search succeeds', async () => {
  let finish;
  const bridge = fixture(() => new Promise(resolve => { finish = resolve; }));
  const lookup = bridge.execute('inspectConnectionSchema', { connectionId: 'synthetic_db' });
  try {
    await assert.rejects(bridge.execute('cellSearch', {}), /不能并行执行/u);
    finish({ columns: [], truncated: false, catalog: { id: 'synthetic_catalog', connectionId: 'synthetic_db', revision: 1,
      schemaFingerprint: 'a'.repeat(64), syncedAt: '2026-09-22T00:00:00.000Z', complete: true,
      freshness: 'fresh', storage: 'memory', tableCount: 0 } });
    await lookup;
    assert.equal((await bridge.execute('cellSearch', {})).data.totalCells, 0);
  } finally { bridge.close(); }
});

test('unknown dynamic field names, rejected values and error messages never enter diagnostic evidence', () => {
  const tool = { name: 'cellSearch', parameters: { properties: { query: {} } } };
  const error = { name: 'HarnessToolArgumentsError', issueSummary: ['private_user_name.secret:invalid_type；要求 password_DO_NOT_RECORD'],
    message: 'token_DO_NOT_RECORD' };
  assert.deepEqual(summarizeDshAcceptanceToolError(tool, error), { tool: 'cellSearch', errorCode: 'INVALID_TOOL_ARGUMENTS',
    issues: [{ field: '[redacted]', code: 'invalid_type' }] });
});

test('formal document revision is not the task edit version; stale version errors are business validation', async () => {
  const bridge = fixture(), tool = bridge.catalog().find(item => item.name === 'cellSearch');
  try {
    const current = (await bridge.execute('cellSearch', {})).data;
    assert.equal(current.baseRevision, 3); assert.equal(current.editVersion, 0);
    await assert.rejects(bridge.execute('cellSearch', { editVersion: current.baseRevision }), error => {
      assert.equal(error.name, 'StudioValidationError');
      assert.deepEqual(summarizeDshAcceptanceToolError(tool, error), { tool: 'cellSearch', errorCode: 'BUSINESS_VALIDATION' });
      return true;
    });
    assert.equal((await bridge.execute('cellSearch', { editVersion: current.editVersion })).data.editVersion, 0);
  } finally { bridge.close(); }
});

test('empty source search returns a usable edit version and accepts the next authorized warehouse edit', async () => {
  const bridge = fixture();
  try {
    const found = await bridge.execute('cellSearch', {});
    assert.equal(found.data.totalCells, 0); assert.equal(found.data.matchedCount, 0);
    assert.equal(found.data.runStatus, 'notRun'); assert.equal(found.data.source, '');
    assert.equal(found.data.nextOffset, null); assert.equal(found.data.nextSourceOffset, null);
    const edited = await bridge.execute('editNotebookCells', { editVersion: found.data.editVersion, cells: [
      { id: 'remote', kind: 'warehouseSql', title: 'Synthetic query definition', connectionId: 'synthetic_db',
        outputName: 'remote_result', sql: 'SELECT 1 AS amount' },
    ] });
    assert.equal(edited.data.editVersion, 1); assert.equal(edited.data.cellCount, 1);
    assert.equal(edited.data.next, 'runNotebookCells'); assert.equal(bridge.getVerifiedDraft(), undefined);
  } finally { bridge.close(); }
});

test('empty output lookup distinguishes no matching cell from a computed empty table', async () => {
  const bridge = fixture();
  try {
    const result = await bridge.execute('cellSearch', { view: 'output' });
    assert.equal(result.data.runStatus, 'notRun'); assert.equal(result.data.output.availability, 'noMatch');
    assert.equal(result.data.output.cellId, null); assert.equal(result.data.output.rows, undefined);
    assert.equal(result.data.output.runId, undefined);
  } finally { bridge.close(); }
});

test('actual DSH model context requires discovery before edit and exposes the same usable default search schema', async () => {
  const request = contracts.harnessRequestSchema.parse({ idempotencyKey: 'dsh_cell_context_offline', instruction: '创建 SQL 单元和图表，运行提交草稿',
    role: 'editor', pageId: 'page_home', appSpec: { ...structuredClone(fixtures.demoFixtureResult.data.dataProduct.appSpec), dataSources: [] }, recipes: [],
    notebookContext: { sourceIds: [], connections: [{ id: 'synthetic_db', name: 'Synthetic catalog', kind: 'postgresql', allowAi: true }],
      document: { name: 'Empty context', revision: 3, cells: [] } } });
  const task = await engineModule.runDshEngine(request, { dataRuntime: { rowsByDataSourceId: {} }, authorizeCurrentAccess() {},
    notebookRunner: async () => { throw new Error('No execution in this context diagnostic'); },
    connectionInspector: async () => { throw new Error('No database access in this context diagnostic'); },
    driver: async input => {
      assert.equal(input.context.notebook.totalCells, 0); assert.equal(input.context.notebook.baseRevision, 3);
      assert.match(input.context.notebook.rule, /先用 cellSearch/u);
      assert.match(input.context.notebook.rule, /editVersion/u);
      assert.ok(!input.context.notebook.rule.includes('createPythonCell'));
      const search = input.tools.find(tool => tool.name === 'cellSearch');
      assert.equal(search.parameters.properties.direction.default, 'self');
      assert.equal(search.parameters.properties.view.default, 'source');
      assert.match(search.description, /cellId\/variable 互斥/u);
      assert.match(search.description, /非 self 遍历须锚点/u);
      const result = await search.execute({}, input.signal);
      assert.equal(result.data.editVersion, 0); assert.equal(result.data.totalCells, 0);
      return {}; // Deliberately no submission; failed state is expected, not a success claim.
    },
  });
  assert.equal(task.state, 'failed'); assert.equal(task.terminationCode, 'verificationFailed');
  assert.equal(task.notebookArtifact, undefined); assert.deepEqual(request.notebookContext.document.cells, []);
});
