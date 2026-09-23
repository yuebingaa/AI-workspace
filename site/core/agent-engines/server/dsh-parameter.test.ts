import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harnessRequestSchema } from "@/core/harness/contracts";
import type { NotebookCell } from "@/core/notebook/definition";
import { runNotebook } from "@/core/notebook/server/runtime";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { runDshEngine, type DshDriverInput, type DshEngineOptions } from "./dsh-engine";

const network = vi.fn(async () => { throw new Error("No external network in offline parameter regression"); });
beforeEach(() => { network.mockClear(); vi.stubGlobal("fetch", network); });
afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type ParameterCell = Extract<NotebookCell, { kind: "parameter" }>;
function fixture(existing = false) {
  const { product, source: originalSource, rows } = semanticFixture();
  const parameters: ParameterCell[] = [
    { id: "minimum", kind: "parameter", title: "最低金额", outputName: "minimum", parameter: { type: "number", value: 80 } },
    { id: "region", kind: "parameter", title: "选中地区", outputName: "selected_region", parameter: { type: "select", value: "华东", options: ["华东", "华南"] } },
    { id: "label", kind: "parameter", title: "报告标签", outputName: "report_label", parameter: { type: "text", value: "合成销售" } },
    { id: "day", kind: "parameter", title: "报告日期", outputName: "report_day", parameter: { type: "date", value: "2024-02-29" } },
  ];
  const sql: Extract<NotebookCell, { kind: "sql" }> = { id: "filtered", kind: "sql", title: "按参数筛选后合计",
    inputCellIds: ["data", ...parameters.map(cell => cell.id)], outputName: "filtered_sales",
    sql: "SELECT SUM(s.amount)::DOUBLE AS total, t.value AS label, CAST(d.value AS DATE) AS report_date FROM sales_data s CROSS JOIN minimum n CROSS JOIN selected_region r CROSS JOIN report_label t CROSS JOIN report_day d WHERE s.amount >= n.value AND s.region = r.value GROUP BY t.value, d.value" };
  const additions: NotebookCell[] = [...parameters, sql,
    { id: "table", kind: "table", title: "参数筛选结果", inputCellId: sql.id, columns: ["total", "label", "report_date"] },
    { id: "note", kind: "text", title: "实际筛选数值", markdown: "筛选后总额 {{total}}。", references: [{ key: "total", cellId: sql.id, field: "total" }] },
  ];
  const request = harnessRequestSchema.parse({ idempotencyKey: "dsh_parameter_offline", role: "editor", pageId: "page_home",
    instruction: existing ? "帮我看一下，能不能给我一个分析的结论" : "新增文本、数字、日期和单选参数，使用 SQL 筛选真实数据并汇总，生成表格说明，试运行后提交草稿。",
    dataSourceId: originalSource.id, appSpec: product.appSpec, recipes: [],
    notebookContext: { sourceIds: [originalSource.id], document: { name: "DSH 四类参数", revision: 7, cells: [
      { id: "data", kind: "data", title: "合成销售数据", sourceDataSourceId: originalSource.id, outputName: "sales_data" },
      ...(existing ? additions : []),
    ] } },
  });
  const source = request.appSpec.dataSources.find(item => item.id === originalSource.id)!;
  const options: Omit<DshEngineOptions, "driver"> = {
    dataRuntime: { rowsByDataSourceId: { [source.id]: rows } }, authorizeCurrentAccess() {},
    notebookRunner: (artifact, context) => runNotebook({
      document: { name: artifact.name, revision: artifact.baseRevision ?? 0, cells: artifact.cells },
      sources: [{ source: context.request.appSpec.dataSources.find(item => item.id === source.id)!, rows: context.dataRuntime.rowsByDataSourceId[source.id] }],
      signal: context.signal, forAi: true, log() {},
    }),
  };
  return { request, options, parameters, source, rows, sql, additions };
}

async function call(input: DshDriverInput, name: string, args: unknown) {
  const tool = input.tools.find(item => item.name === name);
  if (!tool) throw new Error(`Missing fixture tool: ${name}`);
  input.onModelCall(); // Fixed-driver accounting, never a provider request.
  return tool.execute(args, input.signal);
}

function expectComputedResult(data: unknown, total: number, label = "合成销售") {
  expect(data).toMatchObject({ status: "success", results: expect.arrayContaining([
    expect.objectContaining({ cellId: "filtered", rows: [{ total, label, report_date: "2024-02-29" }],
      resultRef: expect.objectContaining({ accessMode: "ai", complete: true, sourceDatasetIds: ["semantic_sales"] }) }),
    expect.objectContaining({ cellId: "table", rows: [{ total, label, report_date: "2024-02-29" }] }),
  ]), textResults: [expect.objectContaining({ cellId: "note", text: `筛选后总额 ${total}。` })] });
}

describe("DSH canonical parameter Notebook integration", () => {
  it("executes all four literal types with actual SQL and submits only a confirmation draft", async () => {
    const test = fixture(), before = structuredClone(test.request), rowsBefore = structuredClone(test.rows), runner = vi.fn(test.options.notebookRunner);
    const task = await runDshEngine(test.request, { ...test.options, notebookRunner: runner, driver: async input => {
      await call(input, "cellSearch", {});
      await call(input, "editNotebookCells", { editVersion: 0, cells: test.additions });
      expectComputedResult((await call(input, "runNotebookCells", { editVersion: 1 })).data, 100);
      expect(await call(input, "submitNotebookDraft", { editVersion: 1 })).not.toHaveProperty("notebookArtifact");
      return { finalResponse: "模型自称已直接更新正式步骤，不能取代人工确认。" };
    } });
    expect(task).toMatchObject({ state: "awaitingConfirmation", verification: { status: "passed" },
      notebookArtifact: { baseRevision: 7, sourceDataSourceIds: [test.source.id], executionEvidence: { status: "success" } } });
    expect(task.notebookArtifact!.cells).toEqual([before.notebookContext!.document.cells[0], ...test.additions]);
    expect(runner).toHaveBeenCalledTimes(1); expect(test.request).toEqual(before); expect(test.rows).toEqual(rowsBefore);
  });

  it("uses this task's fresh parameter-dependent SQL output in a readonly answer", async () => {
    const test = fixture(true), before = structuredClone(test.request), runner = vi.fn(test.options.notebookRunner);
    const task = await runDshEngine(test.request, { ...test.options, notebookRunner: runner, driver: async input => {
      expect(input.tools.map(tool => tool.name)).toEqual(["cellSearch", "runNotebookCells"]);
      await call(input, "cellSearch", {});
      expectComputedResult((await call(input, "runNotebookCells", { editVersion: 0 })).data, 100);
      return { finalResponse: "本轮按华东和最低金额80重新筛选，实际汇总100；参数80本身不是业务汇总。" };
    } });
    expect(task).toMatchObject({ state: "completed", verification: { status: "passed" }, counters: { toolCallCount: 2 } });
    expect(task.notebookArtifact).toBeUndefined(); expect(runner).toHaveBeenCalledTimes(1); expect(test.request).toEqual(before);
  });

  it("changes an existing parameter from 80 to 50 and recomputes 100 to 150 without mutating formal values", async () => {
    const test = fixture(true); test.request.instruction = "把最低金额参数改为50，重新运行筛选并提交草稿让我确认。";
    const before = structuredClone(test.request), runner = vi.fn(test.options.notebookRunner), runIds: unknown[] = [];
    const changed = { ...test.parameters[0], parameter: { type: "number" as const, value: 50 } };
    const task = await runDshEngine(test.request, { ...test.options, notebookRunner: runner, driver: async input => {
      await call(input, "cellSearch", {});
      for (const version of [0, 1]) {
        if (version === 1) await call(input, "editNotebookCells", { editVersion: 0, cells: [changed] });
        const result = await call(input, "runNotebookCells", { editVersion: version });
        expectComputedResult(result.data, version === 0 ? 100 : 150);
        if (result.data && typeof result.data === "object" && "runId" in result.data) runIds.push(result.data.runId);
      }
      await call(input, "submitNotebookDraft", { editVersion: 1 }); return { finalResponse: "参数修改仅在待采用草稿中。" };
    } });
    expect(task.state).toBe("awaitingConfirmation"); expect(task.notebookArtifact!.cells.find(cell => cell.id === "minimum")).toEqual(changed);
    expect(new Set(runIds).size).toBe(2); expect(runner).toHaveBeenCalledTimes(2); expect(test.request).toEqual(before);
  });

  it("retains SQL-looking and template-looking parameter text as literal data", async () => {
    const test = fixture(), literal = "O'Reilly'); DROP TABLE sales_data; -- {{execute(secret)}}";
    test.parameters[2].parameter = { type: "text", value: literal };
    const before = structuredClone(test.request), rowsBefore = structuredClone(test.rows), sqlBefore = test.sql.sql;
    const task = await runDshEngine(test.request, { ...test.options, driver: async input => {
      await call(input, "cellSearch", {}); await call(input, "editNotebookCells", { editVersion: 0, cells: test.additions });
      expectComputedResult((await call(input, "runNotebookCells", { editVersion: 1 })).data, 100, literal);
      await call(input, "submitNotebookDraft", { editVersion: 1 }); return { finalResponse: "文本作为普通参数数据，不是 SQL 或指令。" };
    } });
    expect(task.state).toBe("awaitingConfirmation"); expect(test.sql.sql).toBe(sqlBefore); expect(sqlBefore).not.toContain(literal);
    expect(test.request).toEqual(before); expect(test.rows).toEqual(rowsBefore);
  });

  it.each([
    ["non-finite number", { type: "number", value: Infinity }],
    ["invalid date", { type: "date", value: "2026-02-30" }],
    ["unlisted select", { type: "select", value: "outside", options: ["allowed"] }],
    ["extra execution field", { type: "text", value: "literal", sql: "SELECT secret" }],
  ])("rejects %s at the tool schema before execution", async (_label, parameter) => {
    const test = fixture(), before = structuredClone(test.request), runner = vi.fn(test.options.notebookRunner); let rejected = false;
    const task = await runDshEngine(test.request, { ...test.options, notebookRunner: runner, driver: async input => {
      await call(input, "cellSearch", {});
      try { await call(input, "editNotebookCells", { editVersion: 0, cells: [{ ...test.parameters[0], parameter }] }); }
      catch { rejected = true; }
      return { finalResponse: "无有效编辑，不能提交。" };
    } });
    expect(rejected).toBe(true); expect(runner).not.toHaveBeenCalled(); expect(task.state).toBe("failed");
    expect(task.notebookArtifact).toBeUndefined(); expect(test.request).toEqual(before);
  });

  it("rejects an apparently successful run with the parameter result omitted", async () => {
    const test = fixture(), before = structuredClone(test.request); let actualStatus: string | undefined, rejected = false, submitRejected = false;
    const runner = vi.fn(async (...args: Parameters<DshEngineOptions["notebookRunner"]>) => {
      const run = await test.options.notebookRunner(...args); actualStatus = run.status;
      return { ...run, cells: run.cells.filter(cell => cell.cellId !== "minimum") };
    });
    const task = await runDshEngine(test.request, { ...test.options, notebookRunner: runner, driver: async input => {
      await call(input, "cellSearch", {}); await call(input, "editNotebookCells", { editVersion: 0, cells: test.additions });
      try { await call(input, "runNotebookCells", { editVersion: 1 }); } catch { rejected = true; }
      try { await call(input, "submitNotebookDraft", { editVersion: 1 }); } catch { submitRejected = true; }
      return { finalResponse: "缺少参数回执，不能交付。" };
    } });
    expect(actualStatus).toBe("success"); expect(rejected).toBe(true); expect(submitRejected).toBe(true);
    expect(task.state).toBe("failed"); expect(task.notebookArtifact).toBeUndefined(); expect(test.request).toEqual(before);
  });

  it.each([false, true])("does not treat a parameter-only result as business analysis evidence (output search=%s)", async searchOutput => {
    const test = fixture(true); test.request.notebookContext!.document.cells = [test.request.notebookContext!.document.cells[0], test.parameters[0]];
    const before = structuredClone(test.request); let actualStatus: unknown;
    const task = await runDshEngine(test.request, { ...test.options, driver: async input => {
      await call(input, "cellSearch", {});
      const result = await call(input, "runNotebookCells", { editVersion: 0 });
      if (result.data && typeof result.data === "object" && "status" in result.data) actualStatus = result.data.status;
      if (searchOutput) await call(input, "cellSearch", { cellId: "minimum", view: "output", editVersion: 0 });
      return { finalResponse: "销售总金额为80，已完成本轮分析。" };
    } });
    expect(actualStatus).toBe("success"); expect(task).toMatchObject({ state: "failed", terminationCode: "verificationFailed" });
    expect(task.notebookArtifact).toBeUndefined(); expect(test.request).toEqual(before);
  });

  it("still explains a parameter definition without pretending to calculate business results", async () => {
    const test = fixture(true); test.request.instruction = "不要运行，解释当前Notebook的定义。";
    test.request.notebookContext!.document.cells = [test.request.notebookContext!.document.cells[0], test.parameters[0]];
    const before = structuredClone(test.request), runner = vi.fn(test.options.notebookRunner);
    const task = await runDshEngine(test.request, { ...test.options, notebookRunner: runner, driver: async input => {
      expect(input.tools.map(tool => tool.name)).toEqual(["cellSearch"]);
      await call(input, "cellSearch", { cellId: "minimum", view: "source" });
      return { finalResponse: "最低金额是数字参数，当前定义值80；这不是业务销售总额，未运行计算。" };
    } });
    expect(task).toMatchObject({ state: "completed", verification: { status: "passed" } });
    expect(runner).not.toHaveBeenCalled(); expect(test.request).toEqual(before);
  });

  it.each(["cancel", "revoke"] as const)("does not deliver a completed parameter run after %s", async mode => {
    const test = fixture(), before = structuredClone(test.request), controller = new AbortController(); let allowed = true, actualStatus: string | undefined;
    const runner = vi.fn(async (...args: Parameters<DshEngineOptions["notebookRunner"]>) => {
      const run = await test.options.notebookRunner(...args); actualStatus = run.status;
      if (mode === "cancel") controller.abort(); else allowed = false;
      return run;
    });
    const task = await runDshEngine(test.request, { ...test.options, notebookRunner: runner, signal: controller.signal,
      authorizeCurrentAccess() { if (!allowed) throw new Error("Synthetic authorization revoked"); }, driver: async input => {
        await call(input, "cellSearch", {}); await call(input, "editNotebookCells", { editVersion: 0, cells: test.additions });
        await call(input, "runNotebookCells", { editVersion: 1 }); throw new Error("Late run must not reach driver");
      } });
    expect(actualStatus).toBe("success"); expect(task.state).toBe(mode === "cancel" ? "cancelled" : "failed");
    expect(task.notebookArtifact).toBeUndefined(); expect(runner).toHaveBeenCalledTimes(1); expect(test.request).toEqual(before);
  });

  it("does not use parameter availability to bypass pending Dataset authorization", async () => {
    const test = fixture(true); test.source.aiAccessPolicy = "pending";
    const before = structuredClone(test.request), runner = vi.fn(test.options.notebookRunner), driver = vi.fn(async () => ({ finalResponse: "Must not run" }));
    const task = await runDshEngine(test.request, { ...test.options, notebookRunner: runner, driver });
    expect(task).toMatchObject({ state: "blocked", counters: { modelCallCount: 0, toolCallCount: 0 } });
    expect(runner).not.toHaveBeenCalled(); expect(driver).not.toHaveBeenCalled(); expect(test.request).toEqual(before);
  });
});
