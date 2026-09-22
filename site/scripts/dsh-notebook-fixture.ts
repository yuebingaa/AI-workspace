import assert from "node:assert/strict";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { MemoryDatasetRepository } from "@/core/datasets/server/dataset-repository";
import { createNotebookToolBridge } from "@/core/harness/server/notebook-tool-bridge";
import type { HarnessRequest } from "@/core/harness/contracts";
import { runNotebook } from "@/core/notebook/server/runtime";
import type { NotebookCell } from "@/core/notebook/definition";
import { demoFixtureResult } from "@/fixtures/demo-product";

/** Synthetic, memory-only acceptance input. Never accepts a user project or CSV path. */
export async function createDshNotebookFixture(signal: AbortSignal) {
  const csv = "region,amount\nEast,100\nEast,50\nSouth,80\n";
  const parsed = await parseCsvUpload({ originalFileName: "dsh-synthetic-sales.csv", mimeType: "text/csv",
    stream: new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(csv)); controller.close();
    } }),
  });
  const ownership = { tenantId: "dsh_pilot", ownerId: "synthetic_only" };
  const repository = new MemoryDatasetRepository();
  const stored = await repository.put(ownership, parsed);
  const source = stored.descriptor.source;
  assert.equal(source.aiAccessPolicy, "not-required", "Synthetic sales has no sensitive fields");
  if (!demoFixtureResult.success) throw new Error("Synthetic product fixture unavailable");
  const request: HarnessRequest = {
    idempotencyKey: "dsh_offline_notebook_pilot", instruction: "Analyze the synthetic CSV in Notebook cells and submit a draft.",
    role: "editor", pageId: "page_home", dataSourceId: source.id, recipes: [],
    appSpec: { ...structuredClone(demoFixtureResult.data.dataProduct.appSpec), dataSources: [source] },
    notebookContext: { sourceIds: [source.id], document: { name: "DSH offline pilot", revision: 7,
      cells: [{ id: "data", kind: "data", title: "Synthetic sales", sourceDataSourceId: source.id, outputName: "sales_data" }] } },
  };
  const original = structuredClone(request);
  const cells: NotebookCell[] = [
    { id: "summary", kind: "sql", title: "Regional revenue", inputCellIds: ["data"], outputName: "totals",
      sql: "SELECT region, SUM(amount)::DOUBLE AS revenue FROM sales_data GROUP BY region ORDER BY region" },
    { id: "table", kind: "table", title: "Revenue table", inputCellId: "summary", columns: ["region", "revenue"] },
    { id: "chart", kind: "chart", title: "Revenue chart", inputCellId: "summary", chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
  ];
  const calls: string[] = [];
  let checks = 0, trials = 0;
  let trialSignal: AbortSignal | undefined;
  const bridge = createNotebookToolBridge({ request, dataRuntime: { rowsByDataSourceId: { [source.id]: stored.rows } }, signal,
    authorizeCurrentAccess: () => {
      signal.throwIfAborted();
      assert.equal(source.aiAccessPolicy, "not-required");
      checks++;
    },
    notebookRunner: async (artifact, context) => {
      trials++;
      trialSignal = context.signal;
      return runNotebook({ document: { name: artifact.name, revision: artifact.baseRevision ?? 0, cells: artifact.cells },
        sources: [{ source, rows: stored.rows }], forAi: true, signal: context.signal, log: () => {} });
    },
  });
  const expected = [{ region: "East", revenue: 150 }, { region: "South", revenue: 80 }];
  return {
    actions: [
      { name: "cellSearch", args: {} },
      { name: "editNotebookCells", args: { editVersion: 0, cells } },
      { name: "runNotebookCells", args: { editVersion: 1 } },
      { name: "submitNotebookDraft", args: { editVersion: 1 } },
    ],
    tools: bridge.catalog().map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters,
      execute: async (args: unknown, execution: { signal: AbortSignal }) => {
        const result = await bridge.execute(tool.name, args, execution.signal);
        calls.push(tool.name);
        if (tool.name === "runNotebookCells") {
          const data = result.data as { status: string; results: Array<{ cellId: string; rows: unknown[] }> };
          assert.equal(data.status, "success");
          for (const id of ["summary", "table", "chart"]) {
            assert.deepEqual(data.results.find((item) => item.cellId === id)?.rows, expected);
          }
        }
        // Only bounded observations go to the external loop; never the authoritative artifact.
        return { summary: result.summary, data: result.data };
      },
    })),
    verify() {
      const artifact = bridge.getVerifiedDraft();
      assert.ok(artifact, "Model completion text cannot replace an actual submitted draft");
      assert.deepEqual(calls, ["cellSearch", "editNotebookCells", "runNotebookCells", "submitNotebookDraft"]);
      assert.equal(trials, 1);
      assert.ok(checks >= 5);
      assert.equal(artifact.baseRevision, 7);
      assert.equal(artifact.status, "draft");
      assert.equal(artifact.executionEvidence?.status, "success");
      assert.deepEqual(artifact.executionEvidence?.completedCellIds, ["data", "summary", "table", "chart"]);
      assert.deepEqual(request, original, "Formal Notebook and AppSpec must be unchanged");
      return { csvRows: stored.rows.length, toolCalls: calls, actualNotebookRuns: trials,
        authorizationChecks: checks, expectedResults: expected, draftCellKinds: artifact.cells.map((cell) => cell.kind),
        draftStatus: artifact.status, baseRevision: artifact.baseRevision, formalDocumentUnchanged: true,
        adopted: false, chartRenderingVerified: false };
    },
    verifyCancelled() {
      assert.equal(trials, 1, "Cancel fixture must reach the actual Notebook runner");
      assert.equal(trialSignal?.aborted, true, "DSH tool cancellation must reach real computation");
      assert.equal(calls.includes("submitNotebookDraft"), false);
      assert.throws(() => bridge.getVerifiedDraft(), "Cancelled task cannot deliver a draft");
      assert.deepEqual(request, original);
      return { actualNotebookRuns: trials, notebookSignalAborted: true, draftRejected: true, formalDocumentUnchanged: true };
    },
    close: () => bridge.close(),
  };
}
