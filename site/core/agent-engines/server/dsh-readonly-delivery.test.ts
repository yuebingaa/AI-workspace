import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { harnessRequestSchema } from "@/core/harness/contracts";
import { createNotebookToolBridge } from "@/core/harness/server/notebook-tool-bridge";
import { runNotebook } from "@/core/notebook/server/runtime";
import { runDshEngine, type DshDriverInput, type DshEngineOptions } from "./dsh-engine";

afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  if (!demoFixtureResult.success) throw new Error("Synthetic fixture unavailable");
  const parsed = await parseCsvUpload({ originalFileName: "readonly-delivery.csv", mimeType: "text/csv",
    stream: new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("region,amount\nEast,100\nEast,50\nSouth,80\n")); controller.close();
    } }),
  });
  const source = parsed.dataset.source;
  const request = harnessRequestSchema.parse({ idempotencyKey: "dsh_readonly_delivery_synthetic",
    instruction: "现在是分析了什么东西出来", role: "editor", pageId: "page_home", dataSourceId: source.id, recipes: [],
    appSpec: { ...structuredClone(demoFixtureResult.data.dataProduct.appSpec), dataSources: [source] },
    notebookContext: { sourceIds: [source.id], document: { name: "合成地区汇总", revision: 7, cells: [
      { id: "data", kind: "data", title: "销售数据", sourceDataSourceId: source.id, outputName: "sales_data" },
      { id: "totals", kind: "sql", title: "地区合计", inputCellIds: ["data"], outputName: "totals_data",
        sql: "SELECT region, SUM(amount)::DOUBLE AS revenue FROM sales_data GROUP BY region ORDER BY region" },
      { id: "chart", kind: "chart", title: "地区合计图", inputCellId: "totals", chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
    ] } },
  });
  const runner = vi.fn<NonNullable<DshEngineOptions["notebookRunner"]>>((artifact, context) => runNotebook({
    document: { name: artifact.name, revision: artifact.baseRevision ?? 0, cells: artifact.cells },
    sources: context.sources,
    signal: context.signal, forAi: true, log: () => {},
  }));
  const options: Omit<DshEngineOptions, "driver"> = { dataRuntime: { rowsByDataSourceId: { [source.id]: parsed.rows } },
    notebookRunner: runner, authorizeCurrentAccess: () => {},
  };
  return { request, options, runner };
}

async function call(input: DshDriverInput, name: string, args: unknown) {
  const tool = input.tools.find(candidate => candidate.name === name);
  if (!tool) throw new Error("Synthetic driver requested an unavailable tool");
  return tool.execute(args, input.signal);
}

// Regression: a real read-only answer must not be forced through draft adoption.
describe("DSH read-only delivery regression", () => {
  it("a real 150/80 run carries sufficient result evidence without a redundant output search or draft submission", async () => {
    const { request, options, runner } = await fixture(), before = structuredClone(request);
    const network = vi.fn(async () => { throw new Error("Network is prohibited in this regression"); });
    vi.stubGlobal("fetch", network);
    const task = await runDshEngine(request, { ...options, driver: async input => {
      expect(input.instruction).toBe(request.instruction);
      expect(input.tools.map(tool => tool.name)).toEqual(["cellSearch", "runNotebookCells"]);
      expect((await call(input, "cellSearch", {})).data).toMatchObject({ totalCells: 3, matchedCount: 3 });
      expect((await call(input, "runNotebookCells", { editVersion: 0 })).data).toMatchObject({ status: "success",
        results: ["totals", "chart"].map(cellId => ({ cellId, resultRef: { cellId, accessMode: "ai", revision: 7 },
          rows: [{ region: "East", revenue: 150 }, { region: "South", revenue: 80 }], returnedRows: 2, truncated: false })),
      });
      return { finalResponse: "本次按地区汇总收入：East 为150，South 为80；已有一个SQL汇总和一个柱状图，未修改步骤。" };
    } });
    expect(runner).toHaveBeenCalledOnce();
    expect(task.counters.toolCallCount).toBe(2);
    expect(task.trace?.filter(event => event.type === "tool_completed" && event.toolCall?.name === "cellSearch")).toHaveLength(1);
    expect(task.trace?.filter(event => event.type === "tool_failed")).toHaveLength(0);
    expect(task).toMatchObject({ state: "completed", terminationCode: "completed", verification: { status: "passed" } });
    expect(task.error).toBeUndefined();
    expect(task.notebookArtifact).toBeUndefined();
    expect(task.resultMessage).toContain("East");
    expect(task.resultMessage).toContain("只读回答");
    expect(task.trace?.some(event => event.toolCall?.name === "editNotebookCells" || event.toolCall?.name === "submitNotebookDraft")).toBe(false);
    expect(request).toEqual(before);
    expect(network).not.toHaveBeenCalled();
  }, 20_000);

  it("an unchanged real Notebook run cannot satisfy the separate draft submission contract", async () => {
    const { request, options, runner } = await fixture(), before = structuredClone(request);
    const bridge = createNotebookToolBridge({ ...options, request, profile: "notebook" });
    try {
      const result = await bridge.execute("runNotebookCells", { editVersion: 0 });
      expect(result.data).toMatchObject({ status: "success", completedCellIds: ["data", "totals", "chart"] });
      expect(result.data).not.toHaveProperty("next");
      // Deliberate negative contract probe: no model may turn a read-only request
      // into an edit merely to make this explicit rejected submit succeed.
      await expect(bridge.execute("submitNotebookDraft", { editVersion: 0 })).rejects.toThrow("尚未修改任何单元");
      expect(bridge.getVerifiedDraft()).toBeUndefined();
      expect(runner).toHaveBeenCalledOnce();
      expect(request).toEqual(before);
    } finally { bridge.close(); }
  }, 20_000);

  it("cannot recover a cancelled search by delivering earlier read-only evidence", async () => {
    const { request, options } = await fixture();
    request.instruction = "解释这个SQL";
    const task = await runDshEngine(request, { ...options, driver: async input => {
      await call(input, "cellSearch", {});
      const cancelledCall = new AbortController();
      cancelledCall.abort();
      const search = input.tools.find(tool => tool.name === "cellSearch")!;
      await expect(search.execute({}, cancelledCall.signal)).rejects.toThrow();
      return { finalResponse: "当前SQL按地区分组，汇总amount，并按地区排序。" };
    } });
    expect(task.state).toBe("failed");
    expect(task.notebookArtifact).toBeUndefined();
    expect(task.verification?.status).not.toBe("passed");
  });

  it.each([
    ["revocation", "verification_started"], ["cancellation", "verification_started"],
    ["revocation", "verification_completed"], ["cancellation", "verification_completed"],
  ])("fails closed when %s happens at %s", async (kind, phase) => {
    const { request, options } = await fixture();
    request.instruction = "解释这个SQL";
    let authorized = true;
    const controller = new AbortController();
    const task = await runDshEngine(request, { ...options, signal: controller.signal,
      authorizeCurrentAccess: () => { if (!authorized) throw new Error("Synthetic authorization revoked"); },
      onEvent: event => {
        if (event.type !== phase) return;
        if (kind === "revocation") authorized = false;
        else controller.abort();
      },
      driver: async input => {
        await call(input, "cellSearch", {});
        return { finalResponse: "当前SQL按地区分组，汇总amount，并按地区排序。" };
      },
    });
    expect(task.state).toBe(kind === "revocation" ? "failed" : "cancelled");
    expect(task.notebookArtifact).toBeUndefined();
    expect(task.verification?.status).not.toBe("passed");
  });

  it("cannot deliver an answer if a cancelled tool closes the bridge at verification_completed", async () => {
    const { request, options } = await fixture();
    request.instruction = "解释这个SQL";
    let cancelTool: (() => Promise<boolean>) | undefined;
    let cancellation: Promise<boolean> | undefined;
    const task = await runDshEngine(request, { ...options,
      onEvent: event => { if (event.type === "verification_completed") cancellation = cancelTool?.(); },
      driver: async input => {
        await call(input, "cellSearch", {});
        const search = input.tools.find(tool => tool.name === "cellSearch")!;
        cancelTool = () => {
          const controller = new AbortController(); controller.abort();
          return search.execute({}, controller.signal).then(() => false, () => true);
        };
        return { finalResponse: "当前SQL按地区分组，汇总amount，并按地区排序。" };
      },
    });
    expect(await cancellation).toBe(true);
    expect(task.state).toBe("failed");
    expect(task.notebookArtifact).toBeUndefined();
    expect(task.verification?.status).not.toBe("passed");
  });
});
