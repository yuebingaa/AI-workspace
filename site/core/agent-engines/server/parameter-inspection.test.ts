import { describe, expect, it } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { harnessRequestSchema } from "@/core/harness/contracts";
import { resolveDshReadonlyMode, verifyDshReadonlyAnswer } from "./readonly-answer";
import { hasCompleteParameterSources, resolveDshParameterInspection } from "./parameter-inspection";

function fixture(instruction: string) {
  if (!demoFixtureResult.success) throw new Error("Synthetic fixture unavailable");
  return harnessRequestSchema.parse({ idempotencyKey: "parameter_definition_question", instruction, role: "editor", pageId: "page_home",
    appSpec: demoFixtureResult.data.dataProduct.appSpec, recipes: [], notebookContext: { sourceIds: [], selectedCellIds: ["region"],
      document: { name: "Synthetic", revision: 7, cells: [
        { id: "region", kind: "parameter", title: "地区选择", outputName: "region_pick", parameter: { type: "select", value: "East", options: ["East", "South"] } },
        { id: "limit", kind: "parameter", title: "最低金额", outputName: "minimum", parameter: { type: "number", value: 50 } },
      ] } } });
}

describe("whole parameter definition question routing", () => {
  it.each(["当前参数值是多少？", "当前参数的值是什么？", "请查看当前参数的配置。", "当前Notebook的参数有哪些选项？",
    "Show current parameter values", "What are the current values of the parameters?", "不要运行，告诉我当前参数的类型",
    "当前参数的类型是什么？当前参数的选项有哪些？"])("reads all current parameter definitions without execution: %s", instruction => {
    const request = fixture(instruction), before = structuredClone(request);
    expect(resolveDshParameterInspection(request)).toEqual({ cellIds: ["region", "limit"] });
    expect(resolveDshReadonlyMode(request)).toEqual({ allowRun: false, requireOutput: false, parameterInspection: { cellIds: ["region", "limit"] } });
    expect(request).toEqual(before);
  });
  it.each(["查看参数 region 的当前值", "参数「地区选择」的值是多少", "What is the current value of parameter region_pick?",
    "所选参数的类型是什么？", "Explain the selected parameter configuration"])("resolves one exact or selected parameter: %s", instruction => {
    expect(resolveDshParameterInspection(fixture(instruction))).toEqual({ cellIds: ["region"] });
  });
  it.each(["当前参数值是多少，并改成South", "当前参数值是多少，计算销售额", "当前参数配置和销售结果是什么",
    "按当前参数计算收入", "当前参数的最优值是多少", "读取其他文件的参数值", "查看参数missing的值",
    "当前参数值是多少，顺便导出Excel", "Show current parameter values and run SQL", "What is total revenue for current parameters?",
    "参数region.*的值是多少", "不要修改参数，然后创建图表", "请总结当前参数的业务结论"])("does not downgrade extra goals or unknown subjects: %s", instruction => {
    expect(resolveDshParameterInspection(fixture(instruction))).toBeUndefined();
    expect(resolveDshReadonlyMode(fixture(instruction))?.parameterInspection).toBeUndefined();
  });
  it("requires real unambiguous targets and a selected parameter for selected wording", () => {
    const request = fixture("参数「地区选择」的值是多少");
    request.notebookContext!.document.cells[1].title = "地区选择";
    expect(resolveDshParameterInspection(request)).toBeUndefined();
    request.instruction = "所选参数的类型是什么"; request.notebookContext!.selectedCellIds = [];
    expect(resolveDshParameterInspection(request)).toBeUndefined();
    request.instruction = "当前参数值是多少"; request.notebookContext!.document.cells = [];
    expect(resolveDshParameterInspection(request)).toBeUndefined();
    delete request.notebookContext;
    expect(resolveDshParameterInspection(request)).toBeUndefined();
  });
  it("requires quoted metadata for an action-like exact title, instead of swallowing mixed goals", () => {
    const request = fixture("Show parameter region value and delete current chart value");
    request.notebookContext!.document.cells[0].title = "region value and delete current chart";
    expect(resolveDshParameterInspection(request)).toBeUndefined();
    request.instruction = 'Show parameter "region value and delete current chart" value';
    expect(resolveDshParameterInspection(request)).toEqual({ cellIds: ["region"] });
    request.notebookContext!.document.cells[0].title = "地区并修改看板";
    request.instruction = "参数地区并修改看板的值是什么";
    expect(resolveDshParameterInspection(request)).toBeUndefined();
    request.instruction = "参数「地区并修改看板」的值是什么";
    expect(resolveDshParameterInspection(request)).toEqual({ cellIds: ["region"] });
  });
});

describe("private current-definition source proof", () => {
  const source = JSON.stringify({ kind: "parameter", parameter: { type: "text", value: "A".repeat(2000) } }, null, 2);
  const evidence = { baseRevision: 7, sourceById: new Map([["long", source], ["short", "short-source"]]) };
  const inspection = { cellIds: ["long", "short"] };
  const page = (cellId: string, start: number) => {
    const text = evidence.sourceById.get(cellId)!;
    const end = Math.min(start + 2000, text.length), truncated = end < text.length;
    return { toolName: "cellSearch", toolCallId: `${cellId}:${start}`, sourceOffset: start,
      data: { totalCells: 2, matchedCount: 1, cells: [{ id: cellId }], editVersion: 0, baseRevision: 7,
        sourceCellId: cellId, source: text.slice(start, end), sourceTruncated: truncated, nextSourceOffset: truncated ? end : null } };
  };
  it("accepts complete reordered and overlapping pages while preserving exact versions", () => {
    const observations = [page("long", 2000), page("short", 0), page("long", 0), page("long", 1000)];
    expect(hasCompleteParameterSources(inspection, evidence, observations)).toBe(true);
    const result = verifyDshReadonlyAnswer({ mode: { allowRun: false, requireOutput: false, parameterInspection: inspection },
      observations, formalUnchanged: true, failedTools: [], parameterSourceEvidence: evidence,
      finalResponse: "两个参数已按当前定义读取，没有重新执行计算。" });
    expect(result.valid).toBe(true); expect(result.message).toContain("参数值是分析输入，不是业务计算结果");
  });
  it("accepts exact shorter pages returned by the existing result budget", () => {
    const first = page("long", 0), second = page("long", 1100);
    first.data.source = source.slice(0, 1100); first.data.nextSourceOffset = 1100;
    expect(hasCompleteParameterSources(inspection, evidence, [second, page("short", 0), first])).toBe(true);
    first.data.source = "";
    expect(hasCompleteParameterSources(inspection, evidence, [first, second, page("short", 0)])).toBe(false);
  });
  it.each(["missing-source", "missing-target", "missing-first", "hole", "missing-ledger-offset", "forged-ledger-offset",
    "old-revision", "edited-version", "tampered-content", "truncated-flag", "wrong-next"] as const)("rejects %s", defect => {
    const observations = [page("long", 0), page("long", 2000), page("short", 0)];
    if (defect === "missing-target") observations.pop();
    else if (defect === "missing-first") observations.shift();
    else if (defect === "hole") observations[1] = page("long", 2001);
    else if (defect === "missing-ledger-offset") Reflect.deleteProperty(observations[0], "sourceOffset");
    else if (defect === "forged-ledger-offset") observations[0].sourceOffset = 1;
    else if (defect === "old-revision") observations[0].data.baseRevision = 6;
    else if (defect === "edited-version") observations[0].data.editVersion = 1;
    else if (defect === "tampered-content") observations[0].data.source = "model-invented-value";
    else if (defect === "truncated-flag") observations[0].data.sourceTruncated = false;
    else if (defect === "wrong-next") observations[0].data.nextSourceOffset = null;
    expect(hasCompleteParameterSources(inspection, defect === "missing-source" ? undefined : evidence, observations)).toBe(false);
  });
  it("does not admit execution, mutations or duplicate call IDs in a definition-only task", () => {
    const input = { mode: { allowRun: false, requireOutput: false, parameterInspection: inspection },
      observations: [page("long", 0), page("long", 2000), page("short", 0)], formalUnchanged: true,
      failedTools: [], parameterSourceEvidence: evidence, finalResponse: "参数值已从本轮定义读取。" };
    expect(verifyDshReadonlyAnswer({ ...input, mode: { ...input.mode, allowRun: true } }).valid).toBe(false);
    expect(verifyDshReadonlyAnswer({ ...input, formalUnchanged: false }).valid).toBe(false);
    expect(verifyDshReadonlyAnswer({ ...input, failedTools: ["editNotebookCells"] }).valid).toBe(false);
    expect(verifyDshReadonlyAnswer({ ...input, observations: [...input.observations, input.observations[0]] }).valid).toBe(false);
  });
});
