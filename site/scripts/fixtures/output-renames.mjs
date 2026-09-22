import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';

// Deterministic choices, real Harness/tools/SQL/Python and receipt verification.
// The browser explicitly replays the resulting SSE; no live provider is called.
export async function createOutputRenameReceipt({ directory, document, appSpec, pageId, ids }) {
  const stateDir = resolve(directory, 'harness-state'); await mkdir(stateDir);
  const previousState = process.env.STUDIO_LOCAL_STATE_DIR;
  process.env.STUDIO_LOCAL_STATE_DIR = stateDir;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('External HTTP/model requests prohibited during output rename acceptance'); };
  const server = await createServer({ root: process.cwd(), configFile: false, envFile: false,
    cacheDir: resolve(directory, 'vite-cache'), logLevel: 'error',
    server: { middlewareMode: true, hmr: false, watch: null }, resolve: { alias: { '@': process.cwd() } } });
  try {
    const { HarnessRuntime } = await server.ssrLoadModule('/core/harness/runtime.ts');
    const { runNotebook } = await server.ssrLoadModule('/core/notebook/server/runtime.ts');
    const { harnessTaskSummarySchema } = await server.ssrLoadModule('/core/harness/contracts.ts');
    const cells = structuredClone(document.cells).filter((cell) => [ids.input, ids.sql, ids.python].includes(cell.id));
    const parameter = cells.find((cell) => cell.id === ids.input);
    const sql = cells.find((cell) => cell.id === ids.sql);
    const python = cells.find((cell) => cell.id === ids.python);
    parameter.outputName = 'ai_threshold';
    sql.sql = "SELECT 'Synthetic' AS region, (value * 2)::DOUBLE AS total FROM ai_threshold";
    python.outputName = 'ai_python';
    python.code = "import pandas as pd\nai_python = pd.DataFrame({'region': ['Synthetic'], 'total': [ai_threshold['value'].iloc[0] * 3]})";
    const request = { idempotencyKey: `rename_${randomUUID().replaceAll('-', '')}`, role: 'editor', pageId, appSpec,
      instruction: '修改当前 Notebook 参数和 Python 输出变量名称，同步修复直接使用它们的代码。保留所有单元，试运行后提交待确认草稿。', recipes: [],
      notebookContext: { document, sourceIds: [], connections: [] } };
    const before = structuredClone(request);
    const calls = [['cellSearch', {}], ['editNotebookCells', { editVersion: 0, cells }], ['runNotebookCells', { editVersion: 1 }], ['submitNotebookDraft', { editVersion: 1 }]];
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    let next = 0;
    const executions = [];
    const task = await new HarnessRuntime().run(request, { dataRuntime: { rowsByDataSourceId: {} }, allowFailureExplanation: false,
      modelClient: {
        classifyIntent: async () => ({ model: 'explicit-scripted-rename-router', inputChars: 100, usage,
          decision: { mode: 'readOnlyTask', wantsNotebook: true, wantsData: true, wantsEdsAnalysis: false, wantsRawWorkbook: false,
            wantsFields: false, wantsRecipe: false, wantsAppInspection: false, wantsExcel: false, changeAction: 'none', changeTarget: 'none',
            componentKind: 'none', chartType: 'auto', skillIds: [], confidence: 1, rationale: 'Synthetic output rename acceptance only' } }),
        plan: async ({ fallbackPlan }) => ({ plan: fallbackPlan, model: 'explicit-scripted-rename-plan', inputChars: 100, usage }),
        next: async (input) => {
          const call = calls[next++]; assert.ok(call, 'No unexpected model retry permitted');
          const [name, arguments_] = call;
          assert.ok(input.tools.some((tool) => tool.name === name), `Expected ${name} to be authorized`);
          return { model: 'explicit-scripted-rename-actions', usage, turn: { type: 'callTool', name, arguments: arguments_,
            toolCallId: `rename_${next}`, message: '执行合成改名草稿验收' } };
        },
      },
      notebookRunner: async (artifact, context) => {
        const run = await runNotebook({ document: { name: artifact.name, revision: document.revision, cells: artifact.cells },
          sources: [], forAi: true, signal: context.signal, taskId: 'rename_synthetic', userId: 'synthetic' });
        executions.push(run);
        assert.equal(run.status, 'success');
        assert.deepEqual(run.cells.find((cell) => cell.cellId === ids.sql).table.rows, [{ region: 'Synthetic', total: 200 }]);
        assert.deepEqual(run.cells.find((cell) => cell.cellId === ids.python).table.rows, [{ region: 'Synthetic', total: 300 }]);
        return run;
      },
    });
    await writeFile(resolve(directory, 'harness-rename-task.json'), JSON.stringify(task, null, 2), { flag: 'wx' });
    await writeFile(resolve(directory, 'harness-rename-executions.json'), JSON.stringify(executions, null, 2), { flag: 'wx' });
    assert.deepEqual(request, before, 'Draft generation must not mutate the formal Notebook');
    assert.equal(executions.length, 1); assert.equal(next, 4); assert.equal(task.counters.toolCallCount, 4);
    assert.equal(task.state, 'awaitingConfirmation', task.error); assert.equal(task.verification.status, 'passed');
    assert.equal(task.notebookArtifact.executionEvidence.status, 'success');
    assert.equal(task.notebookArtifact.baseRevision, document.revision);
    assert.equal(task.notebookArtifact.cells.length, document.cells.length);
    return harnessTaskSummarySchema.parse(task);
  } finally {
    await server.close(); globalThis.fetch = originalFetch;
    if (previousState === undefined) delete process.env.STUDIO_LOCAL_STATE_DIR;
    else process.env.STUDIO_LOCAL_STATE_DIR = previousState;
  }
}
