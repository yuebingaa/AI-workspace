import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';

export const AGENT_CONTINUITY_FILE_NAME = 'm7-agent-continuity-sales.csv';
export const AGENT_CONTINUITY_CSV = 'region,amount\nEast,100\nEast,50\nSouth,80\n';
export const AGENT_CONTINUITY_TITLES = Object.freeze({
  firstSql: 'Agent 地区汇总', firstTable: 'Agent 地区结果表', firstChart: 'Agent 地区收入图',
  followupSql: 'Agent 两倍收入', followupTable: 'Agent 两倍结果表', followupChart: 'Agent 两倍收入图',
});
export const AGENT_CONTINUITY_EXPECTED = [{ region: 'East', revenue: 150 }, { region: 'South', revenue: 80 }];
export const AGENT_CONTINUITY_DOUBLED = [{ region: 'East', revenue: 300 }, { region: 'South', revenue: 160 }];
const sourceRows = [{ region: 'East', amount: 100 }, { region: 'East', amount: 50 }, { region: 'South', amount: 80 }];
const toolOrder = ['cellSearch', 'editNotebookCells', 'runNotebookCells', 'submitNotebookDraft'];
let ownsProcessState = false;

function cellsFor(phase, dataCell) {
  const first = phase === 'first', prefix = `m7_agent_${phase}`;
  return [
    { id: `${prefix}_sql`, kind: 'sql', title: AGENT_CONTINUITY_TITLES[first ? 'firstSql' : 'followupSql'],
      inputCellIds: [first ? dataCell.id : 'm7_agent_first_sql'], outputName: `${prefix}_totals`,
      sql: first ? `SELECT region, SUM(amount)::DOUBLE AS revenue FROM ${dataCell.outputName} GROUP BY region ORDER BY region`
        : 'SELECT region, (revenue * 2)::DOUBLE AS revenue FROM m7_agent_first_totals ORDER BY region' },
    { id: `${prefix}_table`, kind: 'table', title: AGENT_CONTINUITY_TITLES[first ? 'firstTable' : 'followupTable'],
      inputCellId: `${prefix}_sql`, columns: ['region', 'revenue'] },
    { id: `${prefix}_chart`, kind: 'chart', title: AGENT_CONTINUITY_TITLES[first ? 'firstChart' : 'followupChart'],
      inputCellId: `${prefix}_sql`, chartType: 'bar', categoryField: 'region', valueFields: ['revenue'] },
  ];
}

/**
 * Acceptance-only: receives the actual intercepted browser request. Only model
 * choices are scripted. Tools, local SQL, receipts and SSE encoding are real.
 * Its in-memory conversation/cache are not the managed site's server stores.
 */
export async function createAgentContinuityRunner({ directory, scope, loadSyntheticDataset }) {
  assert.equal(ownsProcessState, false, 'Only one isolated fixture may own this process environment');
  assert.equal(typeof loadSyntheticDataset, 'function');
  ownsProcessState = true;
  const previousState = process.env.STUDIO_LOCAL_STATE_DIR;
  const fixtureScope = structuredClone(scope);
  const shutdown = new AbortController();
  const stats = { executions: 0, trials: 0, modelActions: 0, networkAttempts: 0 };
  let server, active, closed = false, firstReceipt, adoptedDocument, firstConversation;
  const cache = new Map();
  async function withoutNetwork(work) {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      stats.networkAttempts++;
      throw new Error('External HTTP/model requests are prohibited in the agent continuity fixture');
    };
    try { return await work(); } finally { globalThis.fetch = previousFetch; }
  }
  const restoreEnvironment = () => {
    if (previousState === undefined) delete process.env.STUDIO_LOCAL_STATE_DIR;
    else process.env.STUDIO_LOCAL_STATE_DIR = previousState;
    ownsProcessState = false;
  };
  try {
    const root = resolve(directory);
    await mkdir(root, { recursive: true });
    const stateDir = resolve(root, 'agent-continuity-state');
    await mkdir(stateDir); // Exclusive fixture state: never reuse a managed or previous run's state.
    process.env.STUDIO_LOCAL_STATE_DIR = stateDir;
    server = await createServer({ root: process.cwd(), configFile: false, envFile: false,
      cacheDir: resolve(root, 'agent-continuity-vite-cache'), logLevel: 'error',
      server: { middlewareMode: true, hmr: false, watch: null }, resolve: { alias: { '@': process.cwd() } } });
    const modules = await withoutNetwork(async () => Promise.all([
      server.ssrLoadModule('/core/harness/runtime.ts'), server.ssrLoadModule('/core/harness/contracts.ts'),
      server.ssrLoadModule('/core/harness/server/conversation-store.ts'), server.ssrLoadModule('/core/harness/stream.ts'),
      server.ssrLoadModule('/core/notebook/server/runtime.ts'), server.ssrLoadModule('/core/notebook/client-state.ts'),
      server.ssrLoadModule('/core/datasets/contracts.ts'), server.ssrLoadModule('/core/projects/contracts.ts'),
    ]));
    const [{ HarnessRuntime }, { harnessPublicRequestSchema, harnessRequestSchema, harnessTaskSummarySchema },
      { HarnessConversationStore }, { createHarnessStreamResponse, readHarnessStream }, { runNotebook },
      { adoptNotebookDraft }, { datasetUploadResponseSchema }, { projectHandleSchema }] = modules;
    projectHandleSchema.parse(fixtureScope.projectHandle);
    assert.equal(typeof fixtureScope.pageId, 'string'); assert.equal(typeof fixtureScope.datasetId, 'string');
    const conversations = new HarnessConversationStore();
    const namespace = `synthetic-agent-continuity:${fixtureScope.projectHandle}`;

    function validatePayload(payload, projectHandle, phase) {
      assert.ok(phase === 'first' || phase === 'followup', 'Unknown fixture phase');
      assert.equal(projectHandle, fixtureScope.projectHandle, 'Project scope mismatch');
      const request = harnessPublicRequestSchema.parse(payload);
      assert.equal(request.pageId, fixtureScope.pageId, 'Page scope mismatch');
      assert.equal(request.dataSourceId, fixtureScope.datasetId, 'Dataset scope mismatch');
      assert.ok(request.conversation_id, 'The browser must send a conversation_id');
      assert.ok(request.notebookContext, 'The browser must send its current Notebook');
      assert.deepEqual(request.notebookContext.sourceIds, [fixtureScope.datasetId], 'Selected source scope mismatch');
      assert.deepEqual(request.notebookContext.connections ?? [], [], 'External connections are outside this fixture');
      assert.ok(request.notebookContext.document.cells.every((cell) => ['data', 'sql', 'table', 'chart'].includes(cell.kind)),
        'Only the synthetic local chain is allowed');
      assert.ok(request.notebookContext.document.cells.filter((cell) => cell.kind === 'data')
        .every((cell) => cell.sourceDataSourceId === fixtureScope.datasetId), 'Data cell source mismatch');
      return request;
    }

    async function execute(request, phase, signal) {
      signal.throwIfAborted();
      if (phase === 'first') {
        assert.equal(firstReceipt, undefined, 'First phase already completed');
        assert.deepEqual(request.notebookContext.document.cells.map((cell) => cell.kind), ['data'], 'First phase needs exactly one manual Data cell');
        assert.ok(!request.conversationContext?.recentMessages?.length && !request.conversationContext?.previousInstruction,
          'First phase must not bootstrap historic messages from a different conversation');
      } else {
        assert.ok(firstReceipt && adoptedDocument, 'First phase has not completed');
        assert.equal(request.conversation_id, firstConversation, 'Follow-up conversation mismatch');
        assert.deepEqual(request.notebookContext.document, adoptedDocument, 'Follow-up requires the actually adopted current revision and cells');
      }
      const sourceInput = await loadSyntheticDataset({ ...fixtureScope });
      const source = datasetUploadResponseSchema.parse({ dataset: sourceInput.descriptor, rows: sourceInput.rows });
      assert.equal(source.dataset.datasetId, fixtureScope.datasetId, 'Loaded dataset scope mismatch');
      assert.equal(source.dataset.originalFileName, AGENT_CONTINUITY_FILE_NAME, 'Only the named synthetic CSV is allowed');
      assert.equal(source.dataset.aiAccessPolicy, 'not-required');
      assert.equal(source.dataset.source.rowCount, 3); assert.equal(source.dataset.source.columnCount, 2);
      assert.deepEqual(source.rows, sourceRows, 'Full synthetic rows must match, not a partial preview');
      assert.deepEqual(request.appSpec.dataSources.find((item) => item.id === fixtureScope.datasetId), source.dataset.source,
        'The browser source descriptor must match the trusted synthetic source');
      const before = structuredClone(request), trials = [], modelContexts = [];
      // The public schema rejects a caller-supplied role. This acceptance-only
      // actor is fixed here; it does not exercise the real handler's identity boundary.
      const internal = harnessRequestSchema.parse({ ...request, role: 'editor' });
      const lease = conversations.begin(internal, namespace);
      const effective = harnessRequestSchema.parse({ ...internal, conversationContext: lease.context });
      const cells = cellsFor(phase, request.notebookContext.document.cells[0]);
      const actions = [['cellSearch', {}], ['editNotebookCells', { editVersion: 0, cells }],
        ['runNotebookCells', { editVersion: 1 }], ['submitNotebookDraft', { editVersion: 1 }]];
      const usage = { promptTokens: 30, completionTokens: 30, totalTokens: 60 };
      let task;
      stats.executions++;
      try {
        const response = createHarnessStreamResponse(signal, async (executionSignal, emit) => {
          task = await new HarnessRuntime().run(effective, {
            signal: executionSignal, onEvent: emit, dataRuntime: { rowsByDataSourceId: { [fixtureScope.datasetId]: source.rows } },
            allowFailureExplanation: false,
            modelClient: {
              classifyIntent: async () => ({ model: 'explicit-scripted-continuity-router', inputChars: 300, usage,
                decision: { mode: 'readOnlyTask', wantsNotebook: true, wantsData: true, wantsEdsAnalysis: false,
                  wantsRawWorkbook: false, wantsFields: false, wantsRecipe: false, wantsAppInspection: false, wantsExcel: false,
                  changeAction: 'none', changeTarget: 'none', componentKind: 'none', chartType: 'auto', skillIds: [],
                  confidence: 1, rationale: 'Offline synthetic browser acceptance; not model quality evidence' } }),
              plan: async ({ fallbackPlan }) => ({ plan: fallbackPlan, model: 'explicit-scripted-continuity-plan', inputChars: 300, usage }),
              next: async (input) => {
                const action = actions[input.iteration - 1];
                assert.ok(action, 'Unexpected extra model action');
                modelContexts.push(structuredClone(input.context)); stats.modelActions++;
                const [name, args] = action;
                assert.ok(input.tools.some((tool) => tool.name === name), 'Expected real tool is not available');
                return { model: 'explicit-scripted-continuity-actions', usage, turn: { type: 'callTool', name, arguments: args,
                  toolCallId: `${request.idempotencyKey}_${input.iteration}`, message: '执行合成 CSV 单元分析' } };
              },
            },
            notebookRunner: async (artifact, context) => {
              assert.deepEqual(artifact.sourceDataSourceIds, [fixtureScope.datasetId]);
              const run = await runNotebook({ document: { name: artifact.name, revision: artifact.baseRevision, cells: artifact.cells },
                sources: [{ source: source.dataset.source, rows: source.rows }], forAi: true, signal: context.signal, log: () => {} });
              trials.push(structuredClone(run)); stats.trials++;
              return run;
            },
          });
          assert.equal(task.state, 'awaitingConfirmation', task.error);
          assert.equal(task.verification?.status, 'passed');
          assert.deepEqual(task.events.flatMap((event) => event.type === 'toolCall' ? [event.toolCall.name] : []), toolOrder);
          assert.equal(trials.length, 1); assert.equal(trials[0].status, 'success');
          assert.equal(task.notebookArtifact.executionEvidence.runId, trials[0].runId);
          assert.deepEqual(task.notebookArtifact.cells.slice(0, before.notebookContext.document.cells.length),
            before.notebookContext.document.cells, 'Existing Data and adopted steps must remain unchanged');
          assert.deepEqual(trials[0].cells.map((cell) => cell.cellId), task.notebookArtifact.cells.map((cell) => cell.id));
          assert.ok(trials[0].cells.every((cell) => !cell.resultRef || cell.resultRef.runId === trials[0].runId),
            'Every output reference must belong to this new execution');
          for (const suffix of ['sql', 'table', 'chart']) assert.deepEqual(
            trials[0].cells.find((cell) => cell.cellId === `m7_agent_${phase}_${suffix}`).table.rows,
            phase === 'first' ? AGENT_CONTINUITY_EXPECTED : AGENT_CONTINUITY_DOUBLED);
          assert.deepEqual(request, before); assert.deepEqual(effective.appSpec, before.appSpec);
          assert.equal(task.pendingChangeSet, undefined);
          lease.commit(task);
          return harnessTaskSummarySchema.parse(task);
        });
        const body = await response.text(), headers = Object.fromEntries(response.headers.entries());
        const frames = [];
        const decoded = await readHarnessStream(new Response(body, { headers }), signal, (event) => frames.push(event));
        // Optional undefined object properties have no JSON wire representation.
        assert.deepEqual(decoded.task, harnessTaskSummarySchema.parse(JSON.parse(JSON.stringify(task))),
          'The formal SSE decoder must reconstruct the actual serialized task');
        assert.equal(frames.filter((event) => event.type === 'completed').length, 1);
        assert.equal(modelContexts[0].latestObservation, undefined);
        assert.deepEqual(modelContexts[0].workingMemory.verifiedFacts, []);
        if (phase === 'followup') {
          assert.equal(modelContexts[0].recentConversation.trust, 'untrustedConversationContinuityOnly');
          assert.equal(modelContexts[0].recentConversation.previousInstruction, firstReceipt.request.instruction);
          assert.deepEqual(modelContexts[0].recentConversation.recentMessages, [{
            instruction: firstReceipt.request.instruction, response: firstReceipt.task.resultMessage,
          }]);
          assert.equal(modelContexts[0].continuityMemory.trust, 'conversationContinuityOnly');
          assert.notEqual(trials[0].runId, firstReceipt.trials[0].runId);
          assert.ok(!JSON.stringify(modelContexts[0]).includes(firstReceipt.trials[0].runId),
            'Conversation continuity cannot provide previous execution evidence');
        }
        const receipt = { phase, request: before, task: decoded.task, body, headers, modelContexts, trials,
          transport: 'actual-request buffered SSE replay', realModel: false };
        if (phase === 'first') {
          firstReceipt = structuredClone(receipt);
          firstConversation = request.conversation_id;
          adoptedDocument = adoptNotebookDraft(request.notebookContext.document, task.notebookArtifact); // Expected shape only; no workspace is changed.
        }
        return receipt;
      } finally { lease.release(); }
    }

    return {
      /** @param {{ payload: unknown, projectHandle: string, phase: string, signal?: AbortSignal }} input */
      async run({ payload, projectHandle, phase, signal }) {
        assert.equal(closed, false, 'Fixture is closed');
        const request = validatePayload(payload, projectHandle, phase);
        const combined = signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal;
        combined.throwIfAborted();
        const fingerprint = JSON.stringify({ phase, request }), prior = cache.get(request.idempotencyKey);
        if (prior) {
          assert.equal(prior.fingerprint, fingerprint, 'Idempotency key was reused for a different request');
          const receipt = await prior.promise; combined.throwIfAborted(); return structuredClone(receipt);
        }
        assert.equal(active, undefined, 'Concurrent different requests are outside this acceptance fixture');
        assert.ok(cache.size < 8, 'Acceptance request bound exceeded');
        const promise = withoutNetwork(() => execute(request, phase, combined));
        cache.set(request.idempotencyKey, { fingerprint, promise }); active = promise;
        try { return structuredClone(await promise); } finally { active = undefined; }
      },
      getStats: () => ({ ...stats }),
      async close() {
        if (closed) return;
        closed = true; shutdown.abort(new Error('Acceptance fixture closed'));
        try { await active?.catch(() => undefined); await server.close(); } finally { restoreEnvironment(); }
      },
    };
  } catch (error) {
    try { await server?.close(); } finally { restoreEnvironment(); }
    throw error;
  }
}
