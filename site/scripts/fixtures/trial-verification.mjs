import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';

export const PYTHON_TITLE = '回执验收合成数据';
export const SQL_TITLE = '回执验收分类汇总';
export const PYTHON_CODE = "raw = pd.DataFrame({'station': ['Alpha', 'Alpha', 'Beta'], 'seconds': [60, 120, 30]})\ncleaned = raw.assign(minutes=raw['seconds'] / 60)";
export const SQL_CODE = 'SELECT station, SUM(minutes) AS minutes FROM cleaned GROUP BY station ORDER BY station';
export const EXPECTED = [{ station: 'Alpha', minutes: 3 }, { station: 'Beta', minutes: 0.5 }];
export const NOTICE_CANARY = 'UNTRUSTED_RECEIPT_NOTICE_CANARY';
export const SOURCE_MARKER = '<img src=x onerror="window.__trialXss=true">';

// Model choices are explicit test doubles. Actual Harness/tools and the local
// Python/DuckDB executor produce receipts; only the rejected receipt's identity
// and notice are deliberately corrupted at the injected runner boundary.
export async function createTrialReceipts({ directory, document, appSpec, pageId }) {
  assert.deepEqual(document.cells.map((cell) => cell.kind), ['python', 'sql']);
  const stateDir = resolve(directory, 'harness-state');
  await mkdir(stateDir);
  const previousState = process.env.STUDIO_LOCAL_STATE_DIR;
  process.env.STUDIO_LOCAL_STATE_DIR = stateDir;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('External HTTP/model requests prohibited during trial acceptance'); };
  const server = await createServer({ root: process.cwd(), configFile: false, envFile: false,
    cacheDir: resolve(directory, 'vite-cache'), logLevel: 'error',
    server: { middlewareMode: true, hmr: false, watch: null }, resolve: { alias: { '@': process.cwd() } } });
  try {
    const { HarnessRuntime } = await server.ssrLoadModule('/core/harness/runtime.ts');
    const { runNotebook } = await server.ssrLoadModule('/core/notebook/server/runtime.ts');
    const { harnessTaskSummarySchema } = await server.ssrLoadModule('/core/harness/contracts.ts');
    const { notebookRunSchema } = await server.ssrLoadModule('/core/notebook/contracts.ts');
    const cells = [...structuredClone(document.cells),
      { id: 'trial_table', kind: 'table', title: '整稿试运行汇总表', inputCellId: document.cells[1].id, columns: ['station', 'minutes'] },
      { id: 'trial_note', kind: 'text', title: '仅待采用的合成说明', markdown: `整稿验收定义：${SOURCE_MARKER}` },
    ];
    const plan = { name: '整稿回执一致性验收', objective: '验证合成分类汇总并生成待采用表格',
      questions: ['Alpha 与 Beta 的分钟总量分别是多少？'], deliverables: ['table', 'narrative'],
      steps: cells.map((cell) => ({ id: cell.id, kind: cell.kind, title: cell.title, objective: '仅使用合成数据验证执行回执',
        dependsOn: cell.inputCellIds ?? (cell.inputCellId ? [cell.inputCellId] : []),
        ...(cell.kind === 'python' || cell.kind === 'sql' ? { transformation: '将三条合成秒数换算为分钟并按分类汇总' } : {}),
        ...(cell.kind === 'table' ? { columns: cell.columns } : {}),
        ...(cell.kind === 'text' ? { narrativeGoal: '说明本次是脚本模型和隔离试运行，不改变正式文档' } : {}),
      })) };
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    async function make(kind) {
      const request = { idempotencyKey: `trial_${kind}_${randomUUID().replaceAll('-', '')}`, role: 'editor', pageId, appSpec,
        instruction: '生成完整 Notebook 分析草稿，保留当前内容并增加汇总表和说明，试运行后等待确认。', recipes: [],
        notebookContext: { document, sourceIds: [], connections: [] } };
      const before = structuredClone(request);
      let next = 0, planId;
      const executions = [], submitted = [];
      const task = await new HarnessRuntime().run(request, { dataRuntime: { rowsByDataSourceId: {} },
        bounds: { maxToolCalls: 2 }, allowFailureExplanation: false,
        modelClient: {
          classifyIntent: async () => ({ model: 'explicit-scripted-trial-router', inputChars: 100, usage,
            decision: { mode: 'readOnlyTask', wantsNotebook: true, wantsData: true, wantsEdsAnalysis: false, wantsRawWorkbook: false,
              wantsFields: false, wantsRecipe: false, wantsAppInspection: false, wantsExcel: false, changeAction: 'none', changeTarget: 'none',
              componentKind: 'none', chartType: 'auto', skillIds: [], confidence: 1, rationale: 'Synthetic whole-draft receipt verification only' } }),
          plan: async ({ fallbackPlan }) => ({ plan: fallbackPlan, model: 'explicit-scripted-trial-plan', inputChars: 100, usage }),
          next: async (input) => {
            next++;
            assert.ok(next <= 2, 'No unexpected model retry permitted');
            if (next === 2) {
              planId = input.context.latestObservation?.result?.analysisPlanArtifactId;
              assert.equal(typeof planId, 'string', 'The real planning tool must produce the plan ID');
            }
            // The second tool uses the remaining budget. A rejected receipt
            // reaches the actual failure path without a scripted final response.
            const name = next === 1 ? 'createAnalysisPlan' : 'createNotebookDraft';
            assert.ok(input.tools.some((tool) => tool.name === name));
            return { model: 'explicit-scripted-trial-actions', usage, turn: { type: 'callTool', name,
              arguments: next === 1 ? plan : { name: plan.name, analysisPlanId: planId, cells },
              toolCallId: `trial_${kind}_${next}`, message: '执行隔离整稿回执验收' } };
          },
        },
        notebookRunner: async (artifact, context) => {
          const actual = await runNotebook({ document: { name: artifact.name, revision: document.revision, cells: artifact.cells },
            sources: [], forAi: true, signal: context.signal, taskId: `trial_${kind}`, userId: 'synthetic' });
          assert.equal(actual.status, 'success');
          assert.deepEqual(actual.cells.find((cell) => cell.cellId === 'trial_table').table.rows, EXPECTED);
          executions.push(actual);
          const returned = structuredClone(actual);
          if (kind === 'rejected') {
            returned.cells[0].resultRef.runId = 'foreign_run_receipt';
            returned.notice = NOTICE_CANARY;
          }
          notebookRunSchema.parse(returned); // Structurally valid; identity is the failing invariant.
          submitted.push(returned);
          return returned;
        },
      });
      await writeFile(resolve(directory, `harness-${kind}-task.json`), JSON.stringify(task, null, 2), { flag: 'wx' });
      await writeFile(resolve(directory, `harness-${kind}-executions.json`), JSON.stringify({ actual: executions, runnerSubmitted: submitted }, null, 2), { flag: 'wx' });
      assert.deepEqual(request, before, 'Trial generation never mutates the formal request');
      assert.equal(executions.length, 1);
      assert.equal(task.counters.toolCallCount, 2);
      const validated = harnessTaskSummarySchema.parse(task);
      assert.ok(!JSON.stringify(validated).includes(NOTICE_CANARY), 'Untrusted runner notice must not enter events, evidence or answer');
      if (kind === 'rejected') {
        assert.equal(next, 2);
        assert.equal(task.state, 'failed');
        assert.equal(task.notebookArtifact, undefined);
        assert.equal(task.notebookDiagnostics.status, 'unavailable');
        assert.equal(task.notebookDiagnostics.runId, undefined);
        assert.ok(task.notebookDiagnostics.cells.every((cell) => cell.status === 'unknown' && !cell.timing));
        assert.ok(task.trace.some((event) => event.type === 'tool_failed' && event.toolCall?.name === 'createNotebookDraft'));
      } else {
        assert.equal(next, 2);
        assert.equal(task.state, 'awaitingConfirmation', task.error);
        assert.equal(task.verification.status, 'passed');
        assert.equal(task.notebookArtifact.executionEvidence.status, 'success');
        assert.equal(task.notebookDiagnostics, undefined);
      }
      return validated;
    }
    return { valid: await make('valid'), rejected: await make('rejected'), retry: await make('retry') };
  } finally {
    await server.close(); globalThis.fetch = originalFetch;
    if (previousState === undefined) delete process.env.STUDIO_LOCAL_STATE_DIR;
    else process.env.STUDIO_LOCAL_STATE_DIR = previousState;
  }
}
