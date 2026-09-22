import assert from "node:assert/strict";
import { harnessPublicRequestSchema, harnessRequestSchema } from "@/core/harness/contracts";
import { createHarnessStreamResponse, readHarnessStream } from "@/core/harness/stream";
import { runDshEngine } from "@/core/agent-engines/server/dsh-engine";

export const expectedToolLimitMessage = "DSH 已达到工具调用次数保护（6 次），未交付可采用草稿；正式 Notebook 与看板未修改。";

/** Browser request + explicitly synthetic trusted context; actual engine, tools, limit and SSE. */
export async function createToolLimitFixture(payload: unknown) {
  const publicRequest = harnessPublicRequestSchema.parse(payload);
  const request = harnessRequestSchema.parse({ ...publicRequest, role: "editor", dataSourceId: undefined,
    semanticModel: undefined, edsWorkspace: undefined, recipes: [],
    appSpec: { ...publicRequest.appSpec, dataSources: [] },
    notebookContext: { document: { name: "隔离工具上限验收", revision: 0, cells: [] }, sourceIds: [],
      connections: [{ id: "synthetic_limit_db", name: "离线测试连接", kind: "postgresql", allowAi: true }] },
  });
  const original = structuredClone(request);
  let attempts = 0;
  const controller = new AbortController();
  const response = createHarnessStreamResponse(controller.signal, (signal, onEvent) => runDshEngine(request, {
    signal, onEvent, maxToolCalls: 6, dataRuntime: { rowsByDataSourceId: {} }, authorizeCurrentAccess() {},
    connectionInspector: async () => { throw new Error("Database access is prohibited in this fixture."); },
    notebookRunner: async () => { throw new Error("Notebook execution is prohibited in this fixture."); },
    driver: async (input) => {
      const tool = input.tools.find(tool => tool.name === "cellSearch");
      assert.ok(tool);
      input.onModelCall();
      for (let index = 0; index < 7; index++) { attempts++; await tool.execute({}); }
      throw new Error("The seventh call must be rejected by the real engine limit.");
    },
  }));
  const body = await response.text();
  const { task } = await readHarnessStream(new Response(body, { headers: response.headers }), controller.signal);
  assert.equal(attempts, 7);
  assert.equal(task.counters.toolCallCount, 6);
  assert.equal(task.state, "failed");
  assert.equal(task.resultMessage, expectedToolLimitMessage);
  assert.equal(task.error, expectedToolLimitMessage);
  assert.equal(task.notebookArtifact, undefined);
  assert.equal(task.pendingChangeSet, undefined);
  assert.equal(task.trace?.filter(event => event.type === "tool_completed").length, 6);
  assert.deepEqual(request, original);
  return { body, task, evidence: { actualEngine: true, actualCellSearchTools: true, actualSseEncoder: true,
    simulatedDriver: true, syntheticTrustedContext: true, replayedBrowserTransport: true,
    officialSdk: false, realPaidModel: false, realDatabase: false, attemptedTools: attempts,
    completedTools: task.counters.toolCallCount, finalState: task.state, formalDocumentUnchanged: true,
    noDraft: true, resultMessage: task.resultMessage } };
}
