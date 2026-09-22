import assert from "node:assert/strict";
import { harnessPublicRequestSchema, harnessRequestSchema } from "@/core/harness/contracts";
import { createHarnessStreamResponse, readHarnessStream } from "@/core/harness/stream";
import { runDshEngine } from "@/core/agent-engines/server/dsh-engine";

/** Actual validation/error-to-trace path; fixed driver, not the public handler or a paid model. */
export async function createToolDiagnosticFixture(payload: unknown, unsupported = false) {
  const publicRequest = harnessPublicRequestSchema.parse(payload);
  const request = harnessRequestSchema.parse({ ...publicRequest, role: "editor", dataSourceId: undefined,
    semanticModel: undefined, edsWorkspace: undefined, recipes: [], appSpec: { ...publicRequest.appSpec, dataSources: [] },
    notebookContext: { document: { name: "独立参数诊断验收", revision: 0,
      cells: unsupported ? [{ id: "synthetic_text", kind: "text", title: "不支持类型验收", markdown: "仅合成说明，无用户数据。" }] : [] }, sourceIds: [],
      connections: [{ id: "synthetic_diagnostic_db", name: "离线诊断连接", kind: "postgresql", allowAi: true }] },
  });
  const baseline = structuredClone(request), controller = new AbortController();
  const response = createHarnessStreamResponse(controller.signal, (signal, onEvent) => runDshEngine(request, {
    signal, onEvent, dataRuntime: { rowsByDataSourceId: {} }, authorizeCurrentAccess() {},
    connectionInspector: async () => { throw new Error("Database I/O forbidden in diagnostic fixture"); },
    notebookRunner: async () => { throw new Error("Notebook execution forbidden in diagnostic fixture"); },
    driver: async input => {
      assert.equal(unsupported, false, "Unsupported cell must be rejected before starting any driver/model");
      const search = input.tools.find(tool => tool.name === "cellSearch"); assert.ok(search);
      input.onModelCall(); await assert.rejects(search.execute({ query: null }));
      input.onModelCall(); await search.execute({});
      return { finalResponse: "此离线诊断仅验证参数错误与纠正，没有生成分析草稿。" };
    },
  }));
  const body = await response.text();
  const { task } = await readHarnessStream(new Response(body, { headers: response.headers }), controller.signal);
  if (unsupported) {
    assert.equal(task.state, "blocked"); assert.match(task.resultMessage ?? "", /notebook_cell_unsupported/u);
    assert.equal(task.counters.modelCallCount, 0); assert.equal(task.counters.toolCallCount, 0);
    assert.equal(task.notebookArtifact, undefined); assert.deepEqual(request, baseline);
    return { body, task, evidence: { actualEngine: true, actualBridgePreflight: true, actualTraceAndSse: true,
      fixedDriverNeverStarted: true, trustedContextFixture: true, browserTransportReplay: true, publicHandler: false,
      officialSdk: false, paidModel: false, database: false, notebookExecution: false,
      safeCodes: ["notebook_cell_unsupported"], formalDocumentUnchanged: true } };
  }
  const failures = task.trace?.filter(event => event.type === "tool_failed") ?? [];
  assert.equal(failures.length, 1); assert.match(failures[0].message, /query: invalid_type/u);
  assert.match(failures[0].message, /invalid_tool_arguments/u);
  assert.equal(task.trace?.filter(event => event.type === "tool_completed").length, 1);
  assert.equal(task.notebookArtifact, undefined); assert.deepEqual(request, baseline);
  return { body, task, evidence: { actualEngine: true, actualCellSearchValidation: true, actualTraceAndSse: true,
    fixedDriver: true, trustedContextFixture: true, browserTransportReplay: true, publicHandler: false,
    officialSdk: false, paidModel: false, database: false, notebookExecution: false,
    failedArgumentPaths: ["query"], safeCodes: ["invalid_type"], correctedToolCalls: 1, formalDocumentUnchanged: true } };
}
