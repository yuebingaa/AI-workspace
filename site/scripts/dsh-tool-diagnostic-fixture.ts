import assert from "node:assert/strict";
import { harnessPublicRequestSchema, harnessRequestSchema } from "@/core/harness/contracts";
import { createHarnessStreamResponse, readHarnessStream } from "@/core/harness/stream";
import { runDshEngine } from "@/core/agent-engines/server/dsh-engine";
import { NotebookSubmissionError } from "@/core/harness/notebook-submission-error";

/** Actual validation/error-to-trace path; fixed driver, not the public handler or a paid model. */
export async function createToolDiagnosticFixture(payload: unknown, scenario: boolean | "submit-no-changes" = false) {
  const unsupported = scenario === true, submitNoChanges = scenario === "submit-no-changes";
  const publicRequest = harnessPublicRequestSchema.parse(payload);
  const request = harnessRequestSchema.parse({ ...publicRequest, role: "editor", dataSourceId: undefined,
    semanticModel: undefined, edsWorkspace: undefined, recipes: [], appSpec: { ...publicRequest.appSpec, dataSources: [] },
    notebookContext: { document: { name: "独立参数诊断验收", revision: 0,
      cells: unsupported ? [{ id: "synthetic_python", kind: "python", title: "关闭能力验收", outputName: "synthetic_value",
        inputCellIds: [], fileNames: [], code: "synthetic_value = pd.DataFrame({'value': [1]})" }] : [] }, sourceIds: [],
      connections: [{ id: "synthetic_diagnostic_db", name: "离线诊断连接", kind: "postgresql", allowAi: true }] },
  });
  const baseline = structuredClone(request), controller = new AbortController();
  const response = createHarnessStreamResponse(controller.signal, (signal, onEvent) => runDshEngine(request, {
    signal, onEvent, dataRuntime: { rowsByDataSourceId: {} }, authorizeCurrentAccess() {},
    notebookCapabilities: { python: { enabled: false, reason: "离线验收关闭Python" } },
    connectionInspector: async () => { throw new Error("Database I/O forbidden in diagnostic fixture"); },
    notebookRunner: async () => { throw new Error("Notebook execution forbidden in diagnostic fixture"); },
    driver: async input => {
      assert.equal(unsupported, false, "Unsupported cell must be rejected before starting any driver/model");
      if (submitNoChanges) {
        const submit = input.tools.find(tool => tool.name === "submitNotebookDraft"); assert.ok(submit);
        input.onModelCall();
        await assert.rejects(submit.execute({ editVersion: 0 }), error => {
          assert.ok(error instanceof NotebookSubmissionError);
          assert.equal(error.code, "notebook_submit_no_changes");
          return true;
        });
        return { finalResponse: "此离线诊断仅验证未修改单元的提交拒绝，没有编辑、运行、生成或采用草稿。" };
      }
      const search = input.tools.find(tool => tool.name === "cellSearch"); assert.ok(search);
      input.onModelCall(); await assert.rejects(search.execute({ query: null }));
      input.onModelCall(); await search.execute({});
      return { finalResponse: "此离线诊断仅验证参数错误与纠正，没有生成分析草稿。" };
    },
  }));
  const body = await response.text();
  const { task } = await readHarnessStream(new Response(body, { headers: response.headers }), controller.signal);
  if (unsupported) {
    assert.equal(task.state, "blocked"); assert.match(task.resultMessage ?? "", /python_unavailable/u);
    assert.equal(task.counters.modelCallCount, 0); assert.equal(task.counters.toolCallCount, 0);
    assert.equal(task.notebookArtifact, undefined); assert.deepEqual(request, baseline);
    return { body, task, evidence: { actualEngine: true, actualBridgePreflight: true, actualTraceAndSse: true,
      fixedDriverNeverStarted: true, trustedContextFixture: true, browserTransportReplay: true, publicHandler: false,
      officialSdk: false, paidModel: false, database: false, notebookExecution: false,
      safeCodes: ["python_unavailable"], formalDocumentUnchanged: true } };
  }
  const failures = task.trace?.filter(event => event.type === "tool_failed") ?? [];
  if (submitNoChanges) {
    assert.equal(task.state, "failed"); assert.equal(task.terminationCode, "verificationFailed");
    assert.equal(task.counters.modelCallCount, 1); assert.equal(task.counters.toolCallCount, 1);
    assert.equal(failures.length, 1); assert.equal(failures[0].toolCall?.name, "submitNotebookDraft");
    assert.match(failures[0].message, /notebook_submit_no_changes/u);
    assert.match(failures[0].message, /本轮没有单元修改，不能生成修改草稿/u);
    assert.equal(task.trace?.filter(event => event.type === "tool_completed").length, 0);
    assert.equal(task.notebookArtifact, undefined); assert.equal(task.pendingChangeSet, undefined);
    assert.deepEqual(request, baseline);
    return { body, task, evidence: { actualEngine: true, actualBridgeSubmitValidation: true, actualTraceAndSse: true,
      fixedDriver: true, trustedContextFixture: true, browserTransportReplay: true, publicHandler: false,
      officialSdk: false, paidModel: false, database: false, notebookExecution: false,
      safeCodes: ["notebook_submit_no_changes"], rejectedTool: "submitNotebookDraft", editVersion: 0,
      formalDocumentUnchanged: true, formalAppSpecUnchanged: true, noDraft: true, noEdits: true } };
  }
  assert.equal(failures.length, 1); assert.match(failures[0].message, /query: invalid_type/u);
  assert.match(failures[0].message, /invalid_tool_arguments/u);
  assert.equal(task.trace?.filter(event => event.type === "tool_completed").length, 1);
  assert.equal(task.notebookArtifact, undefined); assert.deepEqual(request, baseline);
  return { body, task, evidence: { actualEngine: true, actualCellSearchValidation: true, actualTraceAndSse: true,
    fixedDriver: true, trustedContextFixture: true, browserTransportReplay: true, publicHandler: false,
    officialSdk: false, paidModel: false, database: false, notebookExecution: false,
    failedArgumentPaths: ["query"], safeCodes: ["invalid_type"], correctedToolCalls: 1, formalDocumentUnchanged: true } };
}
