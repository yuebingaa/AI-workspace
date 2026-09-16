import { describe, expect, it, vi } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { runNotebook } from "@/core/notebook/server/runtime";
import type { NotebookDocument, NotebookRun, NotebookTable } from "@/core/notebook/contracts";
import type { HarnessModel, HarnessRequest } from "./contracts";
import { executeHarnessTool, type HarnessToolContext } from "./tool-registry";
import { plannedHarnessToolSequence } from "./context-selector";
import { isNotebookInspection } from "./notebook-cell-tools";
import { DeepSeekHarness } from "./deepseek-harness";

function fixture() {
  const { product, source, rows } = semanticFixture();
  const document: NotebookDocument = { name: "结构化检索", revision: 7, cells: [
    { id: "data", kind: "data", title: "销售数据", sourceDataSourceId: source.id, outputName: "sales_data" },
    { id: "summary", kind: "sql", title: "区域汇总", inputCellIds: ["data"], outputName: "totals",
      sql: "SELECT region, SUM(amount) AS revenue FROM sales_data GROUP BY region ORDER BY revenue DESC" },
    { id: "chart", kind: "chart", title: "区域收入", inputCellId: "summary", chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
    { id: "note", kind: "text", title: "说明", markdown: "定义与输出分开读取" },
  ] };
  const request: HarnessRequest = { idempotencyKey: "search_" + crypto.randomUUID(), instruction: "查找 totals 变量的来源及依赖它的图表单元，不要修改或运行",
    role: "editor", pageId: "page_home", appSpec: product.appSpec, recipes: [], dataSourceId: source.id,
    notebookContext: { sourceIds: [source.id], document } };
  const context: HarnessToolContext = { request, dataRuntime: { rowsByDataSourceId: { [source.id]: rows } }, now: Date.now, id: () => crypto.randomUUID(),
    notebookCellSession: { document: structuredClone(document), editVersion: 0 },
    notebookRunner: (artifact, ctx) => runNotebook({ document: { name: artifact.name, revision: 7, cells: artifact.cells },
      sources: [{ source, rows }], forAi: true, signal: ctx.signal, log: () => {} }) };
  return { request, context };
}

function installRun(context: HarnessToolContext, table: NotebookTable): NotebookRun {
  const state = context.notebookCellSession!;
  const run: NotebookRun = { runId: "run_fixture", revision: 7, startedAt: new Date().toISOString(), status: "success", dataSignature: "signature", notice: "synthetic receipt",
    cells: state.document.cells.map((cell) => ({ cellId: cell.id, status: "success", durationMs: 0,
      ...(cell.id === "summary" ? { table, resultRef: { resultId: "result_fixture", runId: "run_fixture", cellId: cell.id,
        revision: 7, mode: "table", inputResultIds: [], rowCount: table.rows.length, complete: !table.truncated,
        dataSignature: "signature", accessMode: "ai" } } : {}) })) };
  state.run = run; state.runVersion = 0;
  return run;
}

describe("CellSearch 按需读取与有效运行回执", () => {
  it("Python 长日志遵守工具预算，并标出诊断截断", async () => {
    const { context } = fixture();
    const run = installRun(context, { fields: [{ name: "value", label: "值", type: "number" }], rows: [{ value: 1 }], truncated: false });
    Object.assign(run.cells[1], { stdout: "out".repeat(600), stderr: "err".repeat(600) });
    context.resultBudgetChars = 2400;
    const result = await executeHarnessTool("cellSearch", { cellId: "summary", view: "output" }, context);
    expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(2400);
    expect(result.data).toMatchObject({ output: { logsTruncated: true, rows: [{ value: 1 }] } });
  });

  it("按变量读取声明血缘，组合图表筛选，不附带源码或计算数据", async () => {
    const { context } = fixture();
    const before = structuredClone(context.notebookCellSession);
    const result = await executeHarnessTool("cellSearch", { variable: "totals", direction: "both", kind: "chart", view: "lineage" }, context);
    expect(result.data).toMatchObject({ anchorCellId: "summary", matchedCount: 1, cells: [{ id: "chart", relation: "downstream", distance: 1 }], source: "", runStatus: "notRun",
      lineage: { cellId: "summary", definedVariable: "totals", basis: "declaredNotebookBindings", linkCount: 2,
        links: [{ relation: "upstream", cellId: "data", variable: "sales_data" }, { relation: "downstream", cellId: "chart", variable: "totals" }] } });
    expect(context.notebookCellSession).toEqual(before);
    await expect(executeHarnessTool("cellSearch", { cellId: "summary", variable: "totals" }, context)).rejects.toThrow();
  });

  it("未运行、有效 SQL 输出、编辑失效和重跑换页身份分别处理", async () => {
    const { context } = fixture();
    const search = (args: Record<string, unknown> = {}) => executeHarnessTool("cellSearch", { variable: "totals", view: "output", ...args }, context);
    expect((await search()).data).toMatchObject({ output: { availability: "notRun" } });
    await executeHarnessTool("runNotebookCells", { editVersion: 0 }, context);
    const firstRunId = context.notebookCellSession!.run!.runId;
    expect((await search({ editVersion: 0, runId: firstRunId })).data).toMatchObject({ runStatus: "success", source: "", output: {
      availability: "available", rowCount: 2, availableRows: 2, resultComplete: true,
      rows: [{ region: "华东", revenue: 150 }, { region: "华南", revenue: 80 }], nextRowOffset: null,
      resultRef: { runId: firstRunId, cellId: "summary", revision: 7, accessMode: "ai" },
    } });
    await executeHarnessTool("runNotebookCells", { editVersion: 0 }, context);
    await expect(search({ runId: firstRunId })).rejects.toThrow("运行结果已变化");
    await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [{ id: "note", kind: "text", title: "更新", markdown: "新版本" }] }, context);
    expect((await search()).data).toMatchObject({ editVersion: 1, runStatus: "stale", output: { availability: "stale" } });
    expect(JSON.stringify((await search()).data)).not.toContain("华东");
    await expect(search({ editVersion: 0 })).rejects.toThrow("草稿版本已变化");
  }, 15_000);

  it("空表不同于失败、被阻止和无表格结果；不暴露 user 或错配的引用", async () => {
    const { context } = fixture();
    const table: NotebookTable = { fields: [{ name: "value", label: "值", type: "string" }], rows: [], truncated: false };
    const run = installRun(context, table);
    const search = (cellId = "summary") => executeHarnessTool("cellSearch", { cellId, view: "output" }, context);
    expect((await search()).data).toMatchObject({ output: { availability: "available", rowCount: 0, rows: [], nextRowOffset: null } });
    expect((await search("note")).data).toMatchObject({ output: { availability: "noTable" } });
    const cell = run.cells[1];
    table.rows.push({ value: "private_sentinel" });
    for (const patch of [{ accessMode: "user" as const }, { cellId: "wrong_cell" }, { runId: "wrong_run" }, { revision: 6 }]) {
      const ref = { ...cell.resultRef! }; Object.assign(cell.resultRef!, patch);
      const result = await search();
      expect(result.data).toMatchObject({ output: { availability: "unavailable" } });
      expect(JSON.stringify(result.data)).not.toContain("private_sentinel");
      cell.resultRef = ref;
    }
    run.status = "failure"; cell.status = "failure"; cell.error = "Unknown field";
    run.cells[2].status = "blocked";
    expect((await search()).data).toMatchObject({ output: { availability: "failure", error: "Unknown field" } });
    expect((await search("chart")).data).toMatchObject({ output: { availability: "blocked" } });
    run.revision = 6;
    expect((await search()).data).toMatchObject({ output: { availability: "stale" } });
    const abort = new AbortController(); abort.abort(); context.signal = abort.signal;
    await expect(search()).rejects.toThrow();
  });

  it("宽表与长文本在工具预算内分页，标明截断和可读行数，页尾不会重复游标", async () => {
    const { context } = fixture();
    const fields: NotebookTable["fields"] = Array.from({ length: 8 }, (_, i) => ({ name: `field_${i}`, label: `列${i}`, type: "string" }));
    const table: NotebookTable = { fields, rows: Array.from({ length: 7 }, (_, i) => Object.fromEntries(fields.map((field) => [field.name, `${i}:` + "甲".repeat(500)]))), truncated: true };
    const run = installRun(context, table); run.cells[1].resultRef!.rowCount = 100;
    context.resultBudgetChars = 1800;
    const seen = new Set<string>(); let fieldOffset = 0;
    for (let columnPage = 0; columnPage < 8; columnPage += 1) {
      let rowOffset = 0; let nextFieldOffset: number | null = null;
      for (let rowPage = 0; rowPage < 7; rowPage += 1) {
        const result = await executeHarnessTool("cellSearch", { variable: "totals", view: "output", rowOffset, fieldOffset, editVersion: 0, runId: run.runId }, context);
        expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(1800);
        const output = (result.data as { output: { rows: Array<Record<string, string>>; fields: NotebookTable["fields"]; nextRowOffset: number | null; nextFieldOffset: number | null; truncatedValues: number } }).output;
        expect(result.data).toMatchObject({ output: { availability: "available", rowCount: 100, availableRows: 7, resultComplete: false, tableTruncated: true } });
        expect(output.truncatedValues).toBeGreaterThan(0);
        output.rows.forEach((row, i) => output.fields.forEach((field) => { expect(row[field.name]).toMatch(new RegExp(`^${rowOffset + i}:`)); seen.add(`${rowOffset + i}/${field.name}`); }));
        nextFieldOffset = output.nextFieldOffset;
        if (output.nextRowOffset === null) break;
        expect(output.nextRowOffset).toBeGreaterThan(rowOffset); rowOffset = output.nextRowOffset;
      }
      if (nextFieldOffset === null) break;
      expect(nextFieldOffset).toBeGreaterThan(fieldOffset); fieldOffset = nextFieldOffset;
    }
    expect(seen.size).toBe(7 * 8);
    expect((await executeHarnessTool("cellSearch", { cellId: "summary", view: "output", fieldOffset: 8 }, context)).data)
      .toMatchObject({ output: { rows: [], nextFieldOffset: null, nextRowOffset: null } });
  });
});

describe("Harness 只检索 Notebook 的完成流程", () => {
  it("连续读血缘及源码后可回答，Verifier 通过且不运行或创建草稿", async () => {
    const { request, context } = fixture(); const before = structuredClone(request);
    const runner = vi.fn(context.notebookRunner!);
    const visualVerifier = { verify: vi.fn(async () => { throw new Error("结构检索不应触发视觉检查"); }) };
    const model: HarnessModel = { next: async (input) => {
      expect(input.tools.map((tool) => tool.name)).toEqual(["cellSearch"]);
      expect(input.estimatedInputChars).toBeLessThanOrEqual(10_000);
      if (input.iteration > 1) expect(input.context.notebookSearchContinuation).toBe(true);
      return { model: "scripted-search", usage: { promptTokens: 30, completionTokens: 30, totalTokens: 60 },
        turn: input.iteration === 3 ? { type: "complete", message: "totals 由区域汇总单元定义，上游为 sales_data，下游是区域收入图表。本次只读取定义，没有运行计算。" }
          : { type: "callTool", name: "cellSearch", arguments: { variable: "totals", view: input.iteration === 1 ? "lineage" : "source" }, toolCallId: `search_${input.iteration}`, message: "核查定义" } };
    } };
    const task = await new DeepSeekHarness().run(request, { dataRuntime: context.dataRuntime, modelClient: model, notebookRunner: runner, visualVerifier });
    expect(task.state, task.error).toBe("completed");
    expect(task.verification?.status).toBe("passed"); expect(task.counters.toolCallCount).toBe(2);
    expect(task.notebookArtifact).toBeUndefined(); expect(task.pendingChangeSet).toBeUndefined();
    expect(runner).not.toHaveBeenCalled(); expect(visualVerifier.verify).not.toHaveBeenCalled(); expect(request).toEqual(before);
  });

  it("空 Notebook 无数据源也能搜索；第一次工具调用之前不能凭空完成", async () => {
    const { request } = fixture();
    request.appSpec.dataSources = []; request.dataSourceId = undefined;
    request.notebookContext = { sourceIds: [], document: { name: "空白分析", revision: 0, cells: [] } };
    request.instruction = "查看当前 Notebook 的单元";
    const model: HarnessModel = { next: async ({ iteration, context }) => {
      if (iteration === 2) expect(context.latestObservation).toMatchObject({ result: { totalCells: 0, matchedCount: 0 } });
      return { model: "scripted-empty-search", usage: { promptTokens: 30, completionTokens: 30, totalTokens: 60 },
        turn: iteration === 1 ? { type: "callTool", name: "cellSearch", arguments: { view: "summary" }, toolCallId: "empty", message: "读取索引" }
          : { type: "complete", message: "当前 Notebook 尚无单元。" } };
    } };
    const task = await new DeepSeekHarness().run(request, { dataRuntime: { rowsByDataSourceId: {} }, modelClient: model });
    expect(task.state, task.error).toBe("completed"); expect(task.verification?.status).toBe("passed");
    const premature = await new DeepSeekHarness().run({ ...request, idempotencyKey: "premature_" + crypto.randomUUID() }, {
      dataRuntime: { rowsByDataSourceId: {} }, modelClient: { next: async () => ({ model: "scripted-premature", usage: { promptTokens: 30, completionTokens: 30, totalTokens: 60 },
        turn: { type: "complete", message: "没有单元。" } }) },
    });
    expect(premature.state).toBe("failed"); expect(premature.terminationCode).toBe("protocolViolation");
  });

  it("读取运行结果走只读检索，明确编辑或执行仍走原草稿链", () => {
    const { request } = fixture();
    for (const instruction of ["查看汇总单元的运行结果", "查找 totals 变量来源，不要编辑", "追踪这个单元的上游依赖", "查找哪些单元使用 totals"]) {
      expect(isNotebookInspection({ ...request, instruction }), instruction).toBe(true);
      expect(plannedHarnessToolSequence({ ...request, instruction })).toEqual(["cellSearch"]);
    }
    for (const instruction of ["查找汇总单元并修改 SQL", "读取数据单元后运行分析", "创建一个图表单元", "查找并修复失败单元"]) {
      expect(isNotebookInspection({ ...request, instruction }), instruction).toBe(false);
      expect(plannedHarnessToolSequence({ ...request, instruction })).toEqual(["cellSearch", "editNotebookCells", "runNotebookCells", "submitNotebookDraft"]);
    }
  });
});
