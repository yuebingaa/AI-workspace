import assert from "node:assert/strict";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { runNotebook } from "@/core/notebook/server/runtime";
import { adoptNotebookDraft } from "@/core/notebook/client-state";
import type { NotebookCell } from "@/core/notebook/definition";
import { harnessRequestSchema, type HarnessTraceEvent } from "@/core/harness/contracts";
import { createHarnessStreamResponse, readHarnessStream } from "@/core/harness/stream";
import { createAgentExecutor } from "@/core/agent-engines/server/executor";
import { createOfficialDshDriver } from "@/core/agent-engines/server/dsh-driver";

/** Offline only: official SDK/loop + real broker/business tools, no provider call. */
export async function verifyDshEmbedding() {
  if (!demoFixtureResult.success) throw new Error("Synthetic fixture unavailable");
  const parsed = await parseCsvUpload({ originalFileName: "dsh-embedding-synthetic.csv", mimeType: "text/csv",
    stream: new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("region,amount\nEast,100\nEast,50\nSouth,80\n")); controller.close();
    } }),
  });
  const source = parsed.dataset.source;
  const request = harnessRequestSchema.parse({ idempotencyKey: "dsh_sdk_embedding_synthetic",
    instruction: "检查单元，计算地区收入并生成 SQL、表格和图表草稿，先不要采用。",
    role: "editor", pageId: "page_home", dataSourceId: source.id, recipes: [],
    appSpec: { ...structuredClone(demoFixtureResult.data.dataProduct.appSpec), dataSources: [source] },
    notebookContext: { sourceIds: [source.id], document: { name: "DSH 合成 CSV 分析", revision: 7,
      cells: [{ id: "data", kind: "data", title: "合成销售数据", sourceDataSourceId: source.id, outputName: "sales_data" }] } },
  });
  const original = structuredClone(request);
  const cells: NotebookCell[] = [
    { id: "summary", kind: "sql", title: "地区收入汇总", inputCellIds: ["data"], outputName: "totals",
      sql: "SELECT region, SUM(amount)::DOUBLE AS revenue FROM sales_data GROUP BY region ORDER BY region" },
    { id: "table", kind: "table", title: "地区收入表", inputCellId: "summary", columns: ["region", "revenue"] },
    { id: "chart", kind: "chart", title: "地区收入图", inputCellId: "summary", chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
  ];
  const actions = [
    { name: "cellSearch", args: {} },
    { name: "editNotebookCells", args: { editVersion: 0, cells } },
    { name: "runNotebookCells", args: { editVersion: 1 } },
    { name: "submitNotebookDraft", args: { editVersion: 1 } },
  ];
  const executor = createAgentExecutor(createOfficialDshDriver(() => ({ mode: "fixture", actions,
    finalText: "Untrusted fixture claim: already saved. This must not reach the UI." })));
  const events: HarnessTraceEvent[] = [];
  let authorizations = 0, trials = 0;
  const expected = [{ region: "East", revenue: 150 }, { region: "South", revenue: 80 }];
  const controller = new AbortController();
  const response = createHarnessStreamResponse(controller.signal, (signal, emit) => executor("dsh", request, {
    signal, onEvent: emit, dataRuntime: { rowsByDataSourceId: { [source.id]: parsed.rows } },
    authorizeCurrentAccess() { authorizations++; },
    notebookRunner: async (artifact, context) => {
      trials++;
      const result = await runNotebook({ document: { name: artifact.name, revision: artifact.baseRevision ?? 0, cells: artifact.cells },
        sources: [{ source, rows: parsed.rows }], forAi: true, signal: context.signal, log: () => {} });
      assert.equal(result.status, "success");
      for (const cellId of ["summary", "table", "chart"]) assert.deepEqual(result.cells.find((entry) => entry.cellId === cellId)?.table?.rows, expected);
      return result;
    },
  }));
  const { task } = await readHarnessStream(response, controller.signal, (event) => events.push(event));
  assert.equal(task.state, "awaitingConfirmation", task.error);
  assert.equal(task.counters.modelCallCount, 5);
  assert.equal(task.counters.toolCallCount, 4);
  assert.equal(task.usage, undefined, "Do not invent provider usage for fixed actions");
  assert.equal(trials, 1);
  assert.ok(authorizations >= 10);
  assert.ok(task.notebookArtifact);
  assert.equal(task.notebookArtifact.baseRevision, 7);
  assert.equal(task.notebookArtifact.executionEvidence?.status, "success");
  assert.deepEqual(events.filter((event) => event.type === "tool_completed").map((event) => event.toolCall?.name), actions.map((action) => action.name));
  assert.equal(events.filter((event) => event.type === "completed").length, 1);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.ok(!JSON.stringify(events).includes("already saved"));
  assert.deepEqual(request, original);
  const adopted = adoptNotebookDraft(request.notebookContext!.document, task.notebookArtifact);
  assert.deepEqual(adopted.cells.map((cell) => cell.kind), ["data", "sql", "table", "chart"]);
  assert.deepEqual(request, original, "Adoption produces a new document; test does not persist it");
  const cancelled = new AbortController();
  let driverSettled = false, cancelledTrialSignal: AbortSignal | undefined;
  const cancellableDriver = createOfficialDshDriver(() => ({ mode: "fixture", actions }));
  const cancelExecutor = createAgentExecutor(async (input) => {
    try { return await cancellableDriver(input); }
    finally { driverSettled = true; }
  });
  const cancelTask = await cancelExecutor("dsh", { ...request, idempotencyKey: "dsh_sdk_embedding_cancelled" }, {
    signal: cancelled.signal, dataRuntime: { rowsByDataSourceId: { [source.id]: parsed.rows } }, authorizeCurrentAccess() {},
    notebookRunner: async (_artifact, context) => {
      cancelledTrialSignal = context.signal;
      cancelled.abort();
      throw new Error("Explicit offline cancellation at the actual Notebook runner");
    },
  });
  assert.equal(cancelTask.state, "cancelled");
  assert.equal(cancelTask.notebookArtifact, undefined);
  assert.equal(cancelledTrialSignal?.aborted, true);
  assert.equal(driverSettled, true, "The task cannot release its lease before SDK cleanup settles");
  assert.deepEqual(request, original);
  return { passed: true, runtime: "official-dsh-sdk", provider: "fixed-actions-no-provider-http",
    actualSqlResults: expected, toolCalls: task.counters.toolCallCount, fixedModelCalls: task.counters.modelCallCount,
    authorizations, notebookTrials: trials, state: task.state, completedFrames: 1,
    formalDocumentUnchanged: true, inMemoryAdoptionVerified: true, persisted: false,
    cancellation: { state: cancelTask.state, notebookSignalAborted: true, driverSettledAtTaskReturn: true, artifactWithheld: true },
    events: events.map(({ type, sequence, message, toolCall }) => ({ type, sequence, message, toolCall })),
  };
}
