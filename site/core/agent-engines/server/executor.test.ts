import { expect, it, vi } from "vitest";
import { createAgentExecutor } from "./executor";
import { harnessRequestSchema } from "@/core/harness/contracts";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";

it("取消后保持执行租约直至可信驱动完成回收，不接纳迟到结果", async () => {
  if (!demoFixtureResult.success) throw new Error("Fixture unavailable");
  const parsed = await parseCsvUpload({ originalFileName: "executor.csv", mimeType: "text/csv",
    stream: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("region,value\nEast,1")); controller.close(); } }),
  });
  const request = harnessRequestSchema.parse({ idempotencyKey: "dsh_executor_cleanup", instruction: "分析数据",
    role: "editor", pageId: "page_home", dataSourceId: parsed.dataset.datasetId, recipes: [],
    appSpec: { ...structuredClone(demoFixtureResult.data.dataProduct.appSpec), dataSources: [parsed.dataset.source] },
    notebookContext: { sourceIds: [parsed.dataset.datasetId], document: { name: "CSV", revision: 0, cells: [
      { id: "data", kind: "data", title: "Data", sourceDataSourceId: parsed.dataset.datasetId, outputName: "data_rows" },
    ] } },
  });
  const started = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const abort = new AbortController();
  const execute = createAgentExecutor(async ({ signal }) => {
    started.resolve();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    await cleanup.promise;
    signal.throwIfAborted();
    return {};
  });
  let settled = false;
  const running = execute("dsh", request, { signal: abort.signal, authorizeCurrentAccess: () => {},
    dataRuntime: { rowsByDataSourceId: { [parsed.dataset.datasetId]: parsed.rows } }, notebookRunner: vi.fn(),
  }).then((task) => { settled = true; return task; });
  await started.promise;
  abort.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(settled).toBe(false);
  cleanup.resolve();
  const task = await running;
  expect(task.state).toBe("cancelled");
  expect(task.notebookArtifact).toBeUndefined();
});
