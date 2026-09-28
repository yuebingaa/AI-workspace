import { describe, expect, it } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { harnessRequestSchema } from "@/core/harness/contracts";
import { canDeliverDshExistingAnalysisAnswer, isDshExistingAnalysisRequest, resolveDshReadonlyMode,
  verifyDshReadonlyAnswer, type DshAnalysisToolAttempt, type DshReadonlyObservation } from "./readonly-answer";

function request(instruction: string) {
  if (!demoFixtureResult.success) throw new Error("Synthetic fixture unavailable");
  return harnessRequestSchema.parse({ idempotencyKey: "readonly_mode_test", instruction, role: "editor", pageId: "page_home",
    appSpec: demoFixtureResult.data.dataProduct.appSpec, recipes: [],
    notebookContext: { sourceIds: [], document: { name: "Synthetic", revision: 1, cells: [] } },
  });
}
const search = (id = "search"): DshReadonlyObservation => ({ toolCallId: id, toolName: "cellSearch",
  data: { totalCells: 3, matchedCount: 1, cells: [{ id: "summary" }], editVersion: 0, baseRevision: 7 },
});
const run = (id = "run"): DshReadonlyObservation => ({ toolCallId: id, toolName: "runNotebookCells",
  data: { status: "success", runId: id, editVersion: 0, completedCellIds: ["summary"] },
});
const outputData = () => ({ totalCells: 3, matchedCount: 1, cells: [{ id: "summary" }], editVersion: 0,
  output: { availability: "available", runId: "run", cellId: "summary", fields: [{ name: "revenue", type: "number" }],
    rows: [{ revenue: 150 }], rowCount: 1, availableRows: 1, resultComplete: true, tableTruncated: false,
    resultRef: { runId: "run", cellId: "summary", resultId: "result_summary", accessMode: "ai", revision: 1 } },
});
const output = (): DshReadonlyObservation => ({ toolCallId: "output", toolName: "cellSearch", data: outputData() });
const directRunData = (id = "run") => ({ status: "success", runId: id, editVersion: 0, completedCellIds: ["summary"],
  results: [{ cellId: "summary", fields: [{ name: "revenue", label: "收入", type: "number" }],
    rows: [{ revenue: 150 }], returnedRows: 1, truncated: false,
    resultRef: { runId: id, cellId: "summary", resultId: `${id}:summary`, accessMode: "ai", revision: 7,
      mode: "table", inputResultIds: [], rowCount: 1, complete: true, dataSignature: "synthetic-result-signature" },
  }],
});
const directRun = (id = "run"): DshReadonlyObservation => ({ toolCallId: id, toolName: "runNotebookCells", data: directRunData(id) });
const options = () => ({ mode: { allowRun: true, requireOutput: true }, finalResponse: "汇总单元计算出收入为150。",
  observations: [search(), run(), output()], formalUnchanged: true, failedTools: [] as string[],
});

describe("conservative DSH read-only task mode", () => {
  it.each(["总结当前Notebook的结构", "解释当前SQL里的结论字段来源", "概括一下已有单元的作用"])("preserves explicit definition questions containing conclusion words: %s", instruction => {
    expect(resolveDshReadonlyMode(request(instruction))).toEqual({ allowRun: true, requireOutput: false });
  });
  it.each(["总结当前Notebook的结构，再预测下个月", "解释陌生文件里的结论字段来源", "总结当前Notebook的结构并导出", "总结当前Notebook的结构，分析北京增长", "解释当前SQL里的结论并读取其他文件字段来源"])("does not relax definition routing for other sources or extra goals: %s", instruction => {
    expect(resolveDshReadonlyMode(request(instruction))).toBeUndefined();
  });
  it("requires output if a definition explanation is combined with a conclusion request", () => {
    expect(resolveDshReadonlyMode(request("总结当前Notebook的结构，给我一个分析结论")))
      .toEqual({ allowRun: true, requireOutput: true });
  });
  it.each([
    "帮我看一下，能不能给我一个分析的结论", "帮我看看，能否给出分析结论？",
    "请给我当前分析的结论", "能不能总结一下已有分析结果？", "帮我总结当前Notebook的结果",
    "概括一下本次分析结果", "请根据现有结果给出一个分析结论", "请说明当前分析结论",
    "当前分析的结论是什么？", "可以给我一个结论吗？", "请给我分析的总结",
    "不要修改单元，帮我总结一下已有分析结果",
  ])("recognizes a conclusion request as an output question: %s", instruction => {
    expect(resolveDshReadonlyMode(request(instruction))).toEqual({ allowRun: true, requireOutput: true });
  });
  it.each([
    "给我分析结论，并新增图表", "请总结当前结果然后导出Excel", "帮我看一下，按月计算销售额，再给我结论",
    "请给我北京销售增长的分析结论", "总结一下陌生文件的分析结果", "总结 input 文件的分析结果",
    "给出分析结论，把收入提高10%", "总结现有结果并预测下个月", "先重新分析，再给我结论",
  ])("does not hide additional goals or unresolved named subjects in a conclusion request: %s", instruction => {
    expect(resolveDshReadonlyMode(request(instruction))).toBeUndefined();
    expect(isDshExistingAnalysisRequest(request(instruction))).toBe(false);
  });
  it("matches conclusion subjects only to selected source names and preserves explicit no-run", () => {
    const input = request("总结 input 文件的分析结果");
    const source = input.appSpec.dataSources[0];
    source.name = "input.xlsx";
    expect(resolveDshReadonlyMode(input)).toBeUndefined();
    input.notebookContext!.sourceIds.push(source.id);
    expect(resolveDshReadonlyMode(input)).toEqual({ allowRun: true, requireOutput: true });
    input.instruction = "请给出 input.xlsx 文件的分析结论。";
    expect(resolveDshReadonlyMode(input)).toEqual({ allowRun: true, requireOutput: true });
    source.name = "input-other.xlsx";
    expect(resolveDshReadonlyMode(input)).toBeUndefined();
    input.instruction = "不要运行，帮我看一下，能不能给我一个分析的结论";
    expect(resolveDshReadonlyMode(input)).toEqual({ allowRun: false, requireOutput: false });
  });
  it.each(["现在是分析了什么东西出来", "查看当前 SQL 单元的运行结果", "说明已有分析结果", "当前总计是多少？"])("recognizes an existing result question: %s", instruction => {
    expect(resolveDshReadonlyMode(request(instruction))).toEqual({ allowRun: true, requireOutput: true });
  });
  it("distinguishes definitions and explicit no-run instructions without changing old Harness routing", () => {
    expect(resolveDshReadonlyMode(request("解释当前 Notebook 的结构和单元作用"))).toEqual({ allowRun: true, requireOutput: false });
    for (const instruction of ["不要运行，解释当前结果", "不用执行，查看当前 SQL 定义", "禁止重新运行，说明现有结果"]) {
      expect(resolveDshReadonlyMode(request(instruction))).toEqual({ allowRun: false, requireOutput: false });
    }
    expect(resolveDshReadonlyMode(request("不要修改单元，说明已有分析结果"))).toEqual({ allowRun: true, requireOutput: true });
  });
  it.each(["分析一下当前数据", "请帮我分析这个文件", "请创建分析步骤", "解释当前结果并导出 Excel", "修改 SQL，然后说明结果", "删除当前图表再解释", "新增当前结果的图表", "重新分析现有数据并总结", "解释这个SQL并把标题改成月报", "查看当前结果然后重命名图表", "显示当前图表，并调整颜色", "解释当前结果，然后移动图表", "解释当前分析结果并分析北京销售变化", "hello"])("does not downgrade mutations or unknown requests: %s", instruction => {
    expect(resolveDshReadonlyMode(request(instruction))).toBeUndefined();
  });
  it("requires the server-selected Notebook environment", () => {
    const input = request("解释当前结果"); delete input.notebookContext;
    expect(resolveDshReadonlyMode(input)).toBeUndefined();
  });
});

describe("bounded existing-analysis delivery option, not tool routing", () => {
  it.each(["分析input文件", "分析 input.xlsx 文件", "分析当前数据", "请分析这份文件。", "帮我分析一下当前数据集", "请帮我分析这个文件", "分析数据"])("allows the simple whole request without routing to readonly: %s", instruction => {
    const input = request(instruction);
    input.appSpec.dataSources[0].name = "input";
    input.notebookContext!.sourceIds = [input.appSpec.dataSources[0].id];
    expect(isDshExistingAnalysisRequest(input)).toBe(true);
    expect(resolveDshReadonlyMode(input)).toBeUndefined();
  });

  it.each(["分析input文件并把标题改成月报", "分析input文件，按月统计订单", "分析input文件，将金额提高10%后收入多少", "预测未来3个月", "分析并导出Excel", "不要运行，只解释input", "分析input文件生成图表", "重新分析input文件", "分析北京销售变化数据", "分析input文件的平均值", "分析input文件然后删除单元", "分析input文件\n生成图表", "分析input calculate total文件", "分析nonexistent_other_file文件", "hello", "分析这个新计算目标"])("retains the original draft contract: %s", instruction => {
    expect(isDshExistingAnalysisRequest(request(instruction))).toBe(false);
  });

  it("only recognizes non-neutral names from selected source metadata", () => {
    const input = request("分析销售明细文件");
    const source = input.appSpec.dataSources[0];
    expect(source).toBeDefined();
    source.name = "销售明细.xlsx";
    expect(isDshExistingAnalysisRequest(input)).toBe(false);
    input.notebookContext!.sourceIds.push(source.id);
    expect(isDshExistingAnalysisRequest(input)).toBe(true);
    source.name = "input (1)-3536 8.10";
    input.instruction = "分析input文件";
    expect(isDshExistingAnalysisRequest(input)).toBe(false);
    source.name = "input";
    expect(isDshExistingAnalysisRequest(input)).toBe(true);
    delete input.notebookContext;
    expect(isDshExistingAnalysisRequest(input)).toBe(false);
  });

  const attempts = (): DshAnalysisToolAttempt[] => [
    { toolName: "cellSearch", status: "success" }, { toolName: "runNotebookCells", status: "success" },
  ];
  it("requires a complete successful private ledger, allowing only corrected trusted search failures", () => {
    expect(canDeliverDshExistingAnalysisAnswer(attempts())).toBe(true);
    const corrected: DshAnalysisToolAttempt = { toolName: "cellSearch", status: "failure", recoverableSearchFailure: true };
    expect(canDeliverDshExistingAnalysisAnswer([corrected, ...attempts()])).toBe(true);
    expect(canDeliverDshExistingAnalysisAnswer([...attempts(), corrected])).toBe(false);
    expect(canDeliverDshExistingAnalysisAnswer([{ ...corrected, recoverableSearchFailure: false }, ...attempts()])).toBe(false);
    expect(canDeliverDshExistingAnalysisAnswer([])).toBe(false);
    expect(canDeliverDshExistingAnalysisAnswer(attempts().slice(0, 1))).toBe(false);
    expect(canDeliverDshExistingAnalysisAnswer(attempts().slice(1))).toBe(false);
  });

  it.each(["editNotebookCells", "submitNotebookDraft", "inspectConnectionSchema", "unknown"])("rejects every attempted %s even if failed or later restored", toolName => {
    for (const status of ["running", "success", "failure"] as const) {
      expect(canDeliverDshExistingAnalysisAnswer([...attempts(), { toolName, status, recoverableSearchFailure: true }])).toBe(false);
    }
  });
  it("does not turn unknown failures or in-flight calls into success", () => {
    for (const toolName of ["cellSearch", "runNotebookCells"]) {
      for (const status of ["running", "failure"] as const) {
        expect(canDeliverDshExistingAnalysisAnswer([...attempts(), { toolName, status }])).toBe(false);
      }
    }
  });
});

describe("DSH read-only evidence verification", () => {
  it.each(["run", "output"] as const)("does not count a known parameter %s as business result evidence", evidence => {
    const input = { ...options(), parameterCellIds: ["summary"], observations: evidence === "run" ? [search(), directRun()] : [search(), run(), output()] };
    const before = structuredClone(input);
    expect(verifyDshReadonlyAnswer(input)).toMatchObject({ valid: false, issue: expect.stringContaining("结果问题缺少") });
    expect(input).toEqual(before);
  });
  it("still permits definition-only explanation of a known parameter", () => {
    expect(verifyDshReadonlyAnswer({ ...options(), parameterCellIds: ["summary"], mode: { allowRun: false, requireOutput: false },
      observations: [search()], finalResponse: "参数当前定义为150；未运行业务计算。" })).toMatchObject({ valid: true, issue: "" });
  });
  it("retains actual SQL evidence alongside valid parameters, but still validates every result reference", () => {
    const data = directRunData(), parameter = structuredClone(data.results[0]);
    parameter.cellId = "minimum"; parameter.resultRef.cellId = "minimum"; parameter.resultRef.resultId = "run:minimum";
    data.completedCellIds.push("minimum"); data.results.unshift(parameter);
    const input = { ...options(), parameterCellIds: ["minimum"], observations: [search(), { ...directRun(), data }] };
    expect(verifyDshReadonlyAnswer(input)).toMatchObject({ valid: true, issue: "" });
    parameter.resultRef.runId = "old_run";
    expect(verifyDshReadonlyAnswer(input).valid).toBe(false);
  });
  it("keeps a real SQL result valid when a later parameter output is inspected", () => {
    const parameterOutput = outputData();
    parameterOutput.cells[0].id = "minimum"; parameterOutput.output.cellId = "minimum";
    parameterOutput.output.resultRef.cellId = "minimum";
    const data = directRunData(); data.completedCellIds.push("minimum");
    expect(verifyDshReadonlyAnswer({ ...options(), parameterCellIds: ["minimum"],
      observations: [search(), { ...directRun(), data }, { ...output(), data: parameterOutput }] })).toMatchObject({ valid: true });
  });
  it("accepts only current-run AI result evidence and leaves input observations unchanged", () => {
    const input = options(), before = structuredClone(input);
    expect(verifyDshReadonlyAnswer(input)).toMatchObject({ valid: true, issue: "", evidenceIds: ["search", "run", "output"] });
    expect(verifyDshReadonlyAnswer(input).message).toContain("只读回答");
    expect(verifyDshReadonlyAnswer(input).message).toContain("范围以实际返回数据为准");
    expect(input).toEqual(before);
  });
  it("accepts canonical samples returned directly by a successful run without another output search", () => {
    const input = { ...options(), observations: [search(), directRun()] }, before = structuredClone(input);
    expect(verifyDshReadonlyAnswer(input)).toMatchObject({ valid: true, issue: "", evidenceIds: ["search", "run"] });
    expect(input).toEqual(before);
    const empty = directRunData();
    empty.results[0].rows = []; empty.results[0].returnedRows = 0; empty.results[0].resultRef.rowCount = 0;
    expect(verifyDshReadonlyAnswer({ ...input, observations: [search(), { ...directRun(), data: empty }], finalResponse: "本次汇总结果为空，没有满足条件的行。" }).valid).toBe(true);
  });
  it.each(["runId", "cellId", "accessMode", "revision", "editVersion", "returnedRows", "truncated", "fields"])("rejects invalid direct-run %s evidence", key => {
    const data = directRunData();
    if (key === "editVersion") data.editVersion = 1;
    else if (key === "returnedRows") data.results[0].returnedRows = 2;
    else if (key === "truncated") data.results[0].truncated = true;
    else if (key === "fields") data.results[0].fields = [];
    else if (key === "revision") data.results[0].resultRef.revision = 6;
    else if (key === "runId") data.results[0].resultRef.runId = "earlier_run";
    else if (key === "cellId") data.results[0].resultRef.cellId = "uncompleted_cell";
    else data.results[0].resultRef.accessMode = "user";
    expect(verifyDshReadonlyAnswer({ ...options(), observations: [search(), { ...directRun(), data }] }).valid).toBe(false);
  });
  it("does not accept status alone, a failed run, missing references or results from an older run", () => {
    const failed = directRunData(); failed.status = "failure";
    const unregistered = directRunData(); unregistered.completedCellIds = ["other_cell"];
    const missingReference = { ...directRunData(), results: directRunData().results.map(item => ({ ...item, resultRef: undefined })) };
    for (const data of [failed, unregistered, missingReference, { ...directRunData(), results: [] }, run().data]) {
      expect(verifyDshReadonlyAnswer({ ...options(), observations: [search(), { ...directRun(), data }] }).valid).toBe(false);
    }
    expect(verifyDshReadonlyAnswer({ ...options(), observations: [search(), directRun(), run("new_run")] }).valid).toBe(false);
    const stale = directRunData(); stale.runId = "new_run";
    expect(verifyDshReadonlyAnswer({ ...options(), observations: [search(), directRun(), { ...directRun("new_run"), data: stale }] }).valid).toBe(false);
    expect(verifyDshReadonlyAnswer({ ...options(), observations: [directRun(), search()] }).valid).toBe(false);
  });
  it("accepts definition evidence or an explicitly empty Notebook, but not no-match guesses", () => {
    const input = { ...options(), mode: { allowRun: false, requireOutput: false }, observations: [search()], finalResponse: "这个 Notebook 定义了地区汇总。" };
    expect(verifyDshReadonlyAnswer(input)).toMatchObject({ valid: true, message: expect.stringContaining("不代表数值结果已经验证") });
    input.observations = [{ ...search(), data: { totalCells: 0, matchedCount: 0, cells: [] } }];
    expect(verifyDshReadonlyAnswer(input).valid).toBe(true);
    input.observations = [{ ...search(), data: { totalCells: 3, matchedCount: 0, cells: [] } }];
    expect(verifyDshReadonlyAnswer(input).valid).toBe(false);
    expect(verifyDshReadonlyAnswer({ ...input, observations: [] }).valid).toBe(false);
  });
  it.each(["runId", "cellId", "accessMode", "editVersion", "availability"])("rejects mismatched %s output evidence", key => {
    const input = options(), data = outputData();
    if (key === "editVersion") data.editVersion = 1;
    else if (key === "availability") data.output.availability = "stale";
    else if (key === "runId") data.output.resultRef.runId = "another_run";
    else if (key === "cellId") data.output.resultRef.cellId = "another_cell";
    else data.output.resultRef.accessMode = "user";
    input.observations[2] = { ...output(), data };
    expect(verifyDshReadonlyAnswer(input).valid).toBe(false);
  });
  it("requires a preceding successful run and rereading outputs after any newer run", () => {
    expect(verifyDshReadonlyAnswer({ ...options(), observations: [search(), output()] }).valid).toBe(false);
    expect(verifyDshReadonlyAnswer({ ...options(), observations: [search(), output(), run()] }).valid).toBe(false);
    expect(verifyDshReadonlyAnswer({ ...options(), observations: [search(), run(), output(), run("new_run")] }).valid).toBe(false);
    expect(verifyDshReadonlyAnswer({ ...options(), observations: [search(), { ...run(), data: { status: "failure" } }, output()] }).valid).toBe(false);
  });
  it("allows corrected search mistakes but never failed runs or mutation attempts", () => {
    expect(verifyDshReadonlyAnswer({ ...options(), failedTools: ["cellSearch", "cellSearch"] }).valid).toBe(true);
    for (const name of ["runNotebookCells", "editNotebookCells", "submitNotebookDraft", "unknown"]) {
      expect(verifyDshReadonlyAnswer({ ...options(), failedTools: [name] }).valid).toBe(false);
      expect(verifyDshReadonlyAnswer({ ...options(), observations: [...options().observations, { toolCallId: "extra", toolName: name, data: {} }] }).valid).toBe(false);
    }
    expect(verifyDshReadonlyAnswer({ ...options(), mode: { allowRun: false, requireOutput: false } }).valid).toBe(false);
    expect(verifyDshReadonlyAnswer({ ...options(), formalUnchanged: false }).valid).toBe(false);
  });
  it.each([undefined, "", "   ", "已完成", "分析已完成。", "done"])("rejects an absent or generic answer", finalResponse => {
    expect(verifyDshReadonlyAnswer({ ...options(), finalResponse }).valid).toBe(false);
  });
  it("redacts text and returns at most 15 actual evidence IDs within public task limits", () => {
    const input = { ...options(), observations: [...Array.from({ length: 20 }, (_, index) => search(`search_${index}`)), run(), output()],
      finalResponse: "结果说明：Bearer synthetic_test_token sk-synthetic_only_123。" + "合成说明。".repeat(1000) + "完整只读结尾" };
    const result = verifyDshReadonlyAnswer(input);
    expect(result.valid).toBe(true); expect(result.message.length).toBeGreaterThan(5000);
    expect(result.message.endsWith("完整只读结尾")).toBe(true);
    expect(result.message).not.toContain("synthetic_test_token"); expect(result.message).not.toContain("sk-synthetic_only_123");
    expect(result.evidenceIds).toEqual(input.observations.slice(-15).map(item => item.toolCallId));
    expect(verifyDshReadonlyAnswer({ ...options(), observations: [search(), search(), run(), output()] }).valid).toBe(false);
  });
});
