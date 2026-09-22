import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';

// Only the model's choices are scripted. The Harness, tools, Python runtime and
// Notebook executor are the actual application implementations, not fixtures.
export async function createDiagnosticReceipts({ directory, document, appSpec, pageId }) {
  const stateDir = resolve(directory, 'harness-state');
  await mkdir(stateDir);
  const previousState = process.env.STUDIO_LOCAL_STATE_DIR;
  process.env.STUDIO_LOCAL_STATE_DIR = stateDir;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Real model/HTTP requests are forbidden in this acceptance'); };
  const server = await createServer({ root: process.cwd(), configFile: false, envFile: false,
    cacheDir: resolve(directory, 'vite-cache'), logLevel: 'error',
    server: { middlewareMode: true, hmr: false, watch: null }, resolve: { alias: { '@': process.cwd() } } });
  try {
    const { HarnessRuntime } = await server.ssrLoadModule('/core/harness/runtime.ts');
    const { runNotebook } = await server.ssrLoadModule('/core/notebook/server/runtime.ts');
    const { harnessTaskSummarySchema } = await server.ssrLoadModule('/core/harness/contracts.ts');
    const cells = [
      { id: 'diagnostic_py', kind: 'python', title: '脚本模型的失败 Python', inputCellIds: [], fileNames: [], outputName: 'diagnostic_rows',
        code: '# <img src=x onerror="window.__diagnosticXss=true">\nprint("synthetic diagnostic execution")\nraise ValueError("synthetic diagnostic failure")' },
      { id: 'diagnostic_sql', kind: 'sql', title: '失败后的阻断 SQL', inputCellIds: ['diagnostic_py'], outputName: 'diagnostic_totals', sql: 'SELECT COUNT(*) AS n FROM diagnostic_rows' },
      ...Array.from({ length: 6 }, (_, index) => ({ id: `diagnostic_note_${index}`, kind: 'text', title: `截断边界说明 ${index + 1}`,
        markdown: `Synthetic context ${index + 1}: ${'read-only bounded source; '.repeat(150)}` })),
    ];
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    const make = async (cancel) => {
      const request = { idempotencyKey: `diagnostic_${randomUUID().replaceAll('-', '')}`, role: 'editor', pageId, appSpec,
        instruction: '在当前 Notebook 添加 Python 单元和 SQL，运行验证本次失败草稿，不修改正式文档。', recipes: [],
        notebookContext: { document, sourceIds: [], connections: [] } };
      const before = structuredClone(request);
      // The Harness checks tool budget after the model chooses its next action.
      // The fourth call is deliberately refused before any second execution.
      const calls = [['cellSearch', {}], ['editNotebookCells', { editVersion: 0, cells }],
        ['runNotebookCells', { editVersion: 1 }], ['runNotebookCells', { editVersion: 1 }]];
      let next = 0;
      const controller = new AbortController();
      const executions = [];
      const task = await new HarnessRuntime().run(request, { dataRuntime: { rowsByDataSourceId: {} },
        bounds: { maxToolCalls: 3 }, allowFailureExplanation: false, signal: controller.signal,
        modelClient: {
          classifyIntent: async () => ({ model: 'explicit-scripted-diagnostic-router', inputChars: 100, usage,
            decision: { mode: 'readOnlyTask', wantsNotebook: true, wantsData: true, wantsEdsAnalysis: false, wantsRawWorkbook: false,
              wantsFields: false, wantsRecipe: false, wantsAppInspection: false, wantsExcel: false, changeAction: 'none', changeTarget: 'none',
              componentKind: 'none', chartType: 'auto', skillIds: [], confidence: 1, rationale: 'Synthetic failure acceptance only' } }),
          plan: async ({ fallbackPlan }) => ({ plan: fallbackPlan, model: 'explicit-scripted-diagnostic-plan', inputChars: 100, usage }),
          next: async (input) => {
            const call = calls[next++];
            assert.ok(call, 'The deterministic acceptance must not unexpectedly retry');
            const [name, args] = call;
            assert.ok(input.tools.some((tool) => tool.name === name), `Tool ${name} must be authorized`);
            return { model: 'explicit-scripted-diagnostic-actions', usage,
              turn: { type: 'callTool', name, arguments: args, toolCallId: `diagnostic_${next}`, message: 'Execute synthetic diagnostic acceptance' } };
          },
        },
        notebookRunner: async (artifact, context) => {
          const run = await runNotebook({ document: { name: artifact.name, revision: document.revision, cells: artifact.cells },
            sources: [], forAi: true, signal: context.signal, taskId: 'diagnostic_acceptance', userId: 'synthetic' });
          executions.push(run);
          if (cancel) controller.abort(new Error('Explicit test cancellation after real execution'));
          return run;
        },
      });
      assert.deepEqual(request, before, 'Harness must not mutate the formal Notebook request');
      assert.equal(next, cancel ? 3 : 4);
      assert.equal(task.counters.toolCallCount, 3);
      assert.equal(executions.length, 1);
      assert.equal(executions[0].status, 'failure');
      assert.equal(executions[0].cells.find((cell) => cell.cellId === 'diagnostic_py').status, 'failure');
      assert.equal(executions[0].cells.find((cell) => cell.cellId === 'diagnostic_sql').status, 'blocked');
      const validated = harnessTaskSummarySchema.parse(task);
      assert.equal(validated.notebookArtifact, undefined, 'Failed or cancelled definitions cannot be adopted');
      if (cancel) {
        assert.equal(task.state, 'cancelled');
        assert.equal(task.notebookDiagnostics, undefined);
      } else {
        assert.equal(task.state, 'failed');
        assert.equal(task.notebookDiagnostics.status, 'failure');
        assert.ok(task.notebookDiagnostics.cells.some((cell) => cell.timing?.failurePhase === 'execution'));
        assert.ok(task.notebookDiagnostics.omittedCellCount > 0 || task.notebookDiagnostics.cells.some((cell) => cell.sourceTruncated));
      }
      const label = cancel ? 'cancelled' : 'failed';
      await writeFile(resolve(directory, `harness-${label}-task.json`), JSON.stringify(validated, null, 2), { flag: 'wx' });
      await writeFile(resolve(directory, `harness-${label}-execution.json`), JSON.stringify(executions, null, 2), { flag: 'wx' });
      return validated;
    };
    return { failed: await make(false), cancelled: await make(true) };
  } finally {
    await server.close();
    globalThis.fetch = originalFetch;
    if (previousState === undefined) delete process.env.STUDIO_LOCAL_STATE_DIR;
    else process.env.STUDIO_LOCAL_STATE_DIR = previousState;
  }
}
