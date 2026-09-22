import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';

// Explicit synthetic acceptance only: deterministic model, real Harness and
// CellSearch, with all network and execution calls prohibited. Not a live reply.
export async function createNotebookContextSelectionReceipt({ directory, document, appSpec, pageId, selectedCellIds }) {
  await mkdir(directory, { recursive: true });
  const stateDir = resolve(directory, 'harness-state'); await mkdir(stateDir);
  const previousState = process.env.STUDIO_LOCAL_STATE_DIR;
  process.env.STUDIO_LOCAL_STATE_DIR = stateDir;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('External HTTP/model requests prohibited during context selection acceptance'); };
  const server = await createServer({ root: process.cwd(), configFile: false, envFile: false,
    cacheDir: resolve(directory, 'vite-cache'), logLevel: 'error',
    server: { middlewareMode: true, hmr: false, watch: null }, resolve: { alias: { '@': process.cwd() } } });
  try {
    const { HarnessRuntime } = await server.ssrLoadModule('/core/harness/runtime.ts');
    const { harnessRequestSchema, harnessTaskSummarySchema } = await server.ssrLoadModule('/core/harness/contracts.ts');
    const { notebookContextSelectionMetadata } = await server.ssrLoadModule('/core/notebook/context-selection.ts');
    assert.ok(selectedCellIds.length > 0 && selectedCellIds.length <= 3, 'The synthetic fixture intentionally reads one to three cells');
    const request = harnessRequestSchema.parse({ idempotencyKey: `selection_${randomUUID().replaceAll('-', '')}`, role: 'editor', pageId, appSpec,
      instruction: '帮我看看这些', recipes: [], notebookContext: { document, selectedCellIds, sourceIds: [], connections: [] } });
    const before = structuredClone(request), expectedSelection = notebookContextSelectionMetadata(document, selectedCellIds);
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    let next = 0;
    const task = await new HarnessRuntime().run(request, { dataRuntime: { rowsByDataSourceId: {} }, allowFailureExplanation: false,
      notebookRunner: async () => { throw new Error('Context focus must not run the Notebook'); },
      modelClient: {
        classifyIntent: async (input) => {
          assert.deepEqual(input.notebookSelection, expectedSelection);
          return { model: 'explicit-scripted-selection-router', inputChars: 100, usage,
            decision: { mode: 'readOnlyTask', wantsNotebook: true, wantsData: true, wantsEdsAnalysis: false, wantsRawWorkbook: false,
              wantsFields: false, wantsRecipe: false, wantsAppInspection: false, wantsExcel: false, changeAction: 'none', changeTarget: 'none',
              componentKind: 'none', chartType: 'auto', skillIds: [], confidence: 1, rationale: 'Synthetic current-request focus only' } };
        },
        plan: async ({ fallbackPlan }) => ({ plan: fallbackPlan, model: 'explicit-scripted-selection-plan', inputChars: 100, usage }),
        next: async (input) => {
          assert.deepEqual(input.tools.map((tool) => tool.name), ['cellSearch']);
          assert.deepEqual(input.context.notebook.selection, expectedSelection);
          if (next > 0) assert.equal(input.context.latestObservation.result.sourceCellId, selectedCellIds[next - 1]);
          const cellId = selectedCellIds[next++];
          assert.ok(next <= selectedCellIds.length + 1, 'No unexpected model retry permitted');
          return { model: 'explicit-scripted-selection-actions', usage, turn: cellId
            ? { type: 'callTool', name: 'cellSearch', arguments: { cellId, view: 'source' }, toolCallId: `selection_${next}`, message: '读取所选单元定义' }
            : { type: 'complete', message: `已通过工具读取 ${selectedCellIds.length} 个所选单元的当前定义。本次未运行 Notebook，没有把浏览器旧结果当成本次证据。` } };
        },
      },
    });
    await writeFile(resolve(directory, 'harness-selection-task.json'), JSON.stringify(task, null, 2), { flag: 'wx' });
    assert.deepEqual(request, before, 'Selection and inspection must not change the submitted Notebook');
    assert.equal(next, selectedCellIds.length + 1); assert.equal(task.counters.toolCallCount, selectedCellIds.length);
    assert.equal(task.state, 'completed', task.error); assert.equal(task.verification.status, 'passed');
    assert.equal(task.notebookArtifact, undefined); assert.equal(task.pendingChangeSet, undefined);
    const completedTools = task.trace.filter((event) => event.type === 'tool_completed');
    assert.equal(completedTools.length, selectedCellIds.length);
    assert.ok(completedTools.every((event) => event.toolCall?.name === 'cellSearch'));
    return harnessTaskSummarySchema.parse(task);
  } finally {
    await server.close(); globalThis.fetch = originalFetch;
    if (previousState === undefined) delete process.env.STUDIO_LOCAL_STATE_DIR;
    else process.env.STUDIO_LOCAL_STATE_DIR = previousState;
  }
}
