import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harnessRequestSchema } from "@/core/harness/contracts";
import type { NotebookCell } from "@/core/notebook/definition";
import { runNotebook } from "@/core/notebook/server/runtime";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { runDshEngine, type DshDriverInput, type DshEngineOptions } from "./dsh-engine";

const network = vi.fn(async () => { throw new Error("External network is not permitted in this offline semantic test"); });
beforeEach(() => { network.mockClear(); vi.stubGlobal("fetch", network); });
afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function fixture(existing = false) {
  const { product, source: originalSource, rows, model } = semanticFixture();
  const semantic: Extract<NotebookCell, { kind: "semanticQuery" }> = {
    id: "semantic", kind: "semanticQuery", title: "固定销售口径", inputCellId: "data", outputName: "semantic_sales",
    modelId: model.id, modelVersion: model.version, dimensions: ["area"], measures: ["revenue"], limit: 100,
  };
  const additions: NotebookCell[] = [semantic,
    { id: "table", kind: "table", title: "语义结果表", inputCellId: semantic.id, columns: ["area", "revenue"] },
    { id: "chart", kind: "chart", title: "语义结果图", inputCellId: semantic.id, chartType: "bar", categoryField: "area", valueFields: ["revenue"] },
  ];
  const request = harnessRequestSchema.parse({ idempotencyKey: "dsh_semantic_offline", role: "editor", pageId: "page_home",
    instruction: existing ? "帮我看一下，能不能给我一个分析的结论" : "使用已选语义模型添加地区销售语义查询、表格和图表，运行后提交草稿。",
    dataSourceId: originalSource.id, appSpec: product.appSpec, recipes: [], semanticModel: model,
    notebookContext: { sourceIds: [originalSource.id], document: { name: "DSH 单表语义分析", revision: 7, cells: [
      { id: "data", kind: "data", title: "合成销售数据", sourceDataSourceId: originalSource.id, outputName: "sales_data" },
      ...(existing ? additions : []),
    ] } },
  });
  const source = request.appSpec.dataSources.find(item => item.id === originalSource.id)!;
  const options: Omit<DshEngineOptions, "driver"> = {
    dataRuntime: { rowsByDataSourceId: { [source.id]: rows } }, authorizeCurrentAccess() {},
    notebookRunner: (artifact, context) => runNotebook({
      document: { name: artifact.name, revision: artifact.baseRevision ?? 0, cells: artifact.cells },
      sources: [{ source: context.request.appSpec.dataSources.find(item => item.id === source.id)!,
        rows: context.dataRuntime.rowsByDataSourceId[source.id] }],
      semanticModels: context.request.semanticModel ? [context.request.semanticModel] : [],
      signal: context.signal, forAi: true, log() {},
    }),
  };
  return { request, options, source, rows, semantic, additions };
}

async function call(input: DshDriverInput, name: string, args: unknown) {
  const tool = input.tools.find(candidate => candidate.name === name);
  if (!tool) throw new Error(`Unavailable synthetic test tool: ${name}`);
  input.onModelCall(); // Fixed test driver counter, not a provider request.
  return tool.execute(args, input.signal);
}

const expected = [{ area: "华东", revenue: 150 }, { area: "华南", revenue: 80 }];

describe("DSH selected single-table semantic Notebook integration", () => {
  it("generates, actually executes and submits a semantic/table/chart draft without changing formal definitions", async () => {
    const test = fixture(), before = structuredClone(test.request), rowsBefore = structuredClone(test.rows);
    const runner = vi.fn(test.options.notebookRunner);
    const task = await runDshEngine(test.request, { ...test.options, notebookRunner: runner, driver: async input => {
      expect(input.context.semanticModel).toMatchObject({ id: "sales_model", version: 1, sourceDatasetId: test.source.id,
        dimensions: [expect.objectContaining({ key: "area", field: "region" })],
        measures: expect.arrayContaining([expect.objectContaining({ key: "revenue", field: "amount", aggregation: "sum" })]) });
      expect(input.tools.map(tool => tool.name)).toEqual(["cellSearch", "editNotebookCells", "runNotebookCells", "submitNotebookDraft"]);
      await call(input, "cellSearch", {});
      await call(input, "editNotebookCells", { editVersion: 0, cells: test.additions });
      const result = await call(input, "runNotebookCells", { editVersion: 1 });
      expect(result.data).toMatchObject({ status: "success", results: expect.arrayContaining([
        expect.objectContaining({ cellId: "semantic", rows: expected, resultRef: expect.objectContaining({ accessMode: "ai", complete: true }) }),
        expect.objectContaining({ cellId: "chart", rows: expected }),
      ]) });
      const submitted = await call(input, "submitNotebookDraft", { editVersion: 1 });
      expect(submitted).not.toHaveProperty("notebookArtifact");
      return { finalResponse: "模型声称已经直接改好正式文档。" };
    } });
    expect(task).toMatchObject({ state: "awaitingConfirmation", verification: { status: "passed" },
      notebookArtifact: { sourceDataSourceIds: [test.source.id], baseRevision: 7, executionEvidence: { status: "success" } } });
    expect(task.notebookArtifact?.cells).toEqual([before.notebookContext!.document.cells[0], ...test.additions]);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(test.request).toEqual(before); expect(test.rows).toEqual(rowsBefore);
  });

  it("answers an existing semantic conclusion from this task's real output, without edit or submit", async () => {
    const test = fixture(true), before = structuredClone(test.request);
    const task = await runDshEngine(test.request, { ...test.options, driver: async input => {
      expect(input.context.completion).toMatchObject({ mode: "readonly_answer", requireOutput: true });
      expect(input.tools.map(tool => tool.name)).toEqual(["cellSearch", "runNotebookCells"]);
      await call(input, "cellSearch", {});
      const result = await call(input, "runNotebookCells", { editVersion: 0 });
      expect(result.data).toMatchObject({ status: "success", results: expect.arrayContaining([expect.objectContaining({ cellId: "semantic", rows: expected })]) });
      return { finalResponse: "本次按已选销售口径重新计算，华东销售额150、华南80，合计230。正式步骤没有修改。" };
    } });
    expect(task).toMatchObject({ state: "completed", verification: { status: "passed" }, counters: { toolCallCount: 2 } });
    expect(task.resultMessage).toContain("合计230"); expect(task.notebookArtifact).toBeUndefined(); expect(test.request).toEqual(before);
  });

  it.each(["pending", "missing-model", "wrong-version", "wrong-id"] as const)("rejects %s before exposing a model or performing execution", async mode => {
    const test = fixture(true);
    if (mode === "pending") test.source.aiAccessPolicy = "pending";
    else if (mode === "missing-model") delete test.request.semanticModel;
    else {
      const cell = test.request.notebookContext!.document.cells.find(cell => cell.kind === "semanticQuery")!;
      if (cell.kind !== "semanticQuery") throw new Error("Invalid semantic fixture");
      if (mode === "wrong-version") cell.modelVersion += 1;
      else cell.modelId = "unselected_model";
    }
    const before = structuredClone(test.request), driver = vi.fn(async () => ({ finalResponse: "Must not be called" })), runner = vi.fn(test.options.notebookRunner);
    const task = await runDshEngine(test.request, { ...test.options, driver, notebookRunner: runner });
    expect(task).toMatchObject({ state: "blocked", counters: { modelCallCount: 0, toolCallCount: 0 } });
    expect(task.notebookArtifact).toBeUndefined(); expect(driver).not.toHaveBeenCalled(); expect(runner).not.toHaveBeenCalled(); expect(test.request).toEqual(before);
  });

  it.each(["masked", "exclude-sensitive-samples"] as const)("preserves the existing pre-aggregation %s policy through semantic aliases", async policy => {
    const test = fixture(true);
    test.source.aiAccessPolicy = policy; test.source.fields[0].sensitiveCategories = ["name"];
    test.rows[0].region = "SYNTHETIC_PRIVATE_A"; test.rows[1].region = "SYNTHETIC_PRIVATE_A"; test.rows[2].region = "SYNTHETIC_PRIVATE_B";
    const before = structuredClone(test.request), rowsBefore = structuredClone(test.rows), observations: unknown[] = [];
    let runObservation: unknown;
    const runner = vi.fn(test.options.notebookRunner);
    const task = await runDshEngine(test.request, { ...test.options, notebookRunner: runner, driver: async input => {
      observations.push(input.context); observations.push(await call(input, "cellSearch", {}));
      const result = await call(input, "runNotebookCells", { editVersion: 0 }); observations.push(result); runObservation = result.data;
      if (policy === "masked") expect(result.data).toMatchObject({ status: "success", results: expect.arrayContaining([
        expect.objectContaining({ cellId: "semantic", rows: [{ area: "匿名_1", revenue: 150 }, { area: "匿名_2", revenue: 80 }] }),
      ]) });
      return { finalResponse: policy === "masked" ? "本次匿名分组销售额为150和80，未展示敏感分组原文。" : "本次敏感分组被移除，空值校验失败，没有已验证结论。" };
    } });
    expect(task.state).toBe(policy === "masked" ? "completed" : "failed");
    if (policy === "exclude-sensitive-samples") expect(runObservation).toMatchObject({ status: "failure", errors: expect.arrayContaining([
      expect.objectContaining({ cellId: "semantic", status: "failure", error: expect.stringContaining("空值") }),
    ]) });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(JSON.stringify({ task, observations })).not.toContain("SYNTHETIC_PRIVATE");
    expect(task.notebookArtifact).toBeUndefined(); expect(test.request).toEqual(before); expect(test.rows).toEqual(rowsBefore);
  });

  it("still permits non-sensitive total revenue when sensitive dimension samples are excluded", async () => {
    const test = fixture(true);
    test.source.aiAccessPolicy = "exclude-sensitive-samples"; test.source.fields[0].sensitiveCategories = ["name"];
    test.rows.forEach(row => { row.region = "SYNTHETIC_PRIVATE_EXCLUDED"; });
    test.request.notebookContext!.document.cells = [test.request.notebookContext!.document.cells[0], { ...test.semantic, dimensions: [] }];
    const before = structuredClone(test.request);
    const task = await runDshEngine(test.request, { ...test.options, driver: async input => {
      await call(input, "cellSearch", {}); const result = await call(input, "runNotebookCells", { editVersion: 0 });
      expect(result.data).toMatchObject({ status: "success", results: [expect.objectContaining({ cellId: "semantic", rows: [{ revenue: 230 }] })] });
      expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE");
      return { finalResponse: "仅计算非敏感金额合计230，不读取或显示已排除的姓名分组。" };
    } });
    expect(task).toMatchObject({ state: "completed", verification: { status: "passed" } }); expect(test.request).toEqual(before);
  });

  it.each(["cancel", "revoke"] as const)("does not deliver a successful semantic run after %s", async mode => {
    const test = fixture(), before = structuredClone(test.request), controller = new AbortController(); let allowed = true;
    let actualRunStatus: string | undefined;
    const runner = vi.fn(async (...args: Parameters<DshEngineOptions["notebookRunner"]>) => {
      const result = await test.options.notebookRunner(...args); actualRunStatus = result.status;
      if (mode === "cancel") controller.abort(); else allowed = false;
      return result;
    });
    const task = await runDshEngine(test.request, { ...test.options, signal: controller.signal, notebookRunner: runner,
      authorizeCurrentAccess() { if (!allowed) throw new Error("Synthetic scope revoked"); },
      driver: async input => {
        await call(input, "cellSearch", {}); await call(input, "editNotebookCells", { editVersion: 0, cells: test.additions });
        await call(input, "runNotebookCells", { editVersion: 1 });
        throw new Error("Late run must not reach the driver");
      },
    });
    expect(task.state).toBe(mode === "cancel" ? "cancelled" : "failed"); expect(task.notebookArtifact).toBeUndefined();
    expect(actualRunStatus).toBe("success");
    if (mode === "cancel") expect(controller.signal.aborted).toBe(true); else expect(allowed).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1); expect(test.request).toEqual(before);
  });
});
