import { describe, expect, it } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import type { HarnessObservation, HarnessRequest, HarnessSemanticIntentDecision } from "./contracts";
import { buildHarnessContextSelection, estimateHarnessModelInputChars } from "./context-selector";
import { harnessToolCatalog } from "./tool-registry";

function fixture() {
  const { product, source } = semanticFixture();
  const request: HarnessRequest = {
    idempotencyKey: "notebook_compaction", instruction: "检查现有单元，添加 SQL 汇总和图表单元",
    role: "editor", pageId: "page_home", appSpec: product.appSpec, recipes: [], dataSourceId: source.id,
    notebookContext: { sourceIds: [source.id], document: { name: "合成示例", revision: 3, cells: [
      { id: "data", kind: "data", title: "合成数据", sourceDataSourceId: source.id, outputName: "source_rows" },
    ] } },
  };
  const intent: HarnessSemanticIntentDecision = {
    mode: "readOnlyTask", wantsNotebook: true, wantsData: true, wantsEdsAnalysis: false,
    wantsRawWorkbook: false, wantsFields: false, wantsRecipe: false, wantsAppInspection: false, wantsExcel: false,
    changeAction: "none", changeTarget: "none", componentKind: "none", chartType: "auto", skillIds: [],
    confidence: 1, rationale: "先检索真实定义，再编辑待采用草稿",
  };
  return { request, intent };
}

const searchObservation: HarnessObservation = {
  toolName: "cellSearch", toolCallId: "search", summary: "已检索定义；尚未运行。",
  data: { editVersion: 0, totalCells: 1, matchedCount: 1, sourceCellId: "data", sourceTruncated: false },
};

describe("Notebook 模型上下文压缩", () => {
  it.each([false, true])("只压缩重复路由提示，不改变工具、Schema、记忆与元数据（followUp=%s）", (followUp) => {
    const { request, intent } = fixture();
    const before = structuredClone({ request, intent });
    const observations = followUp ? [searchObservation] : [];
    const iteration = followUp ? 2 : 1;
    const normal = buildHarnessContextSelection(request, observations, iteration, false, undefined, undefined, [], [], intent, true);
    const compact = buildHarnessContextSelection(request, observations, iteration, true, undefined, undefined, [], [], intent, true);
    const tools = (names: typeof normal.toolNames) => harnessToolCatalog({ names, request, semanticIntent: intent });
    expect(normal.context.semanticIntent).toEqual({ ...intent, source: "model" });
    expect(compact.context.semanticIntent).toEqual({ mode: intent.mode, source: "model" });
    expect(compact.toolNames).toEqual(normal.toolNames);
    expect(compact.toolNames).toContain(followUp ? "editNotebookCells" : "cellSearch");
    expect(tools(compact.toolNames)).toEqual(tools(normal.toolNames));
    expect(compact.workingMemory).toEqual(normal.workingMemory);
    expect(compact.context.workingMemory).toEqual(normal.context.workingMemory);
    expect(compact.editableNodes).toEqual(normal.editableNodes);
    expect(compact.blockingReason).toBe(normal.blockingReason);
    expect(compact.context.latestObservation).toEqual(normal.context.latestObservation);
    expect(compact.context.goalSummary).toBe(normal.context.goalSummary);
    expect(compact.context.taskMode).toBe(normal.context.taskMode);
    expect(compact.context.notebook).toMatchObject({
      name: request.notebookContext!.document.name, baseRevision: 3,
      sourceIds: request.notebookContext!.sourceIds, totalCells: 1, trust: "untrustedProjectData",
      rule: expect.stringContaining("不自动应用"),
    });
    for (const boundary of ["保留其他单元", "声明上游 outputName", "无跨次隐藏变量", "真实运行失败修正再跑", "提交待采用"]) {
      expect(compact.context.notebook).toMatchObject({ rule: expect.stringContaining(boundary) });
    }
    // Inspection's established compaction may omit declared output names, but
    // the entry-metadata trust rule is never turned into execution evidence.
    expect(compact.context.inputInspection).toMatchObject({ basis: "entryMetadataOnly", rule: expect.stringContaining("不是数据内容、运行结果或授权") });
    if (followUp) expect(compact.context.inputInspection).toEqual(normal.context.inputInspection);
    expect(estimateHarnessModelInputChars(compact.context, tools(compact.toolNames), iteration))
      .toBeLessThan(estimateHarnessModelInputChars(normal.context, tools(normal.toolNames), iteration));
    expect({ request, intent }).toEqual(before);
  });

  it("没有 Notebook 单元工具时，压缩路径仍保留完整语义路由", () => {
    const { request, intent } = fixture();
    delete request.notebookContext;
    request.instruction = "检查数据字段";
    intent.wantsNotebook = false;
    intent.wantsFields = true;
    const selection = buildHarnessContextSelection(request, [], 1, true, undefined, undefined, [], [], intent);
    expect(selection.context.semanticIntent).toEqual({ ...intent, source: "model" });
    expect(selection.context.notebook).toBeUndefined();
  });

  it("没有模型路由时不制造语义决策", () => {
    const { request } = fixture();
    const selection = buildHarnessContextSelection(request, [], 1, true);
    expect(selection.context).not.toHaveProperty("semanticIntent");
  });

  it("只读 Notebook 检索的分页、旧结果与不自动运行规则不被精简", () => {
    const { request, intent } = fixture();
    request.instruction = "查找 Notebook 单元，不要修改";
    const normal = buildHarnessContextSelection(request, [searchObservation], 2, false, undefined, undefined, [], [], intent);
    const compact = buildHarnessContextSelection(request, [searchObservation], 2, true, undefined, undefined, [], [], intent);
    expect(compact.context.notebook).toEqual(normal.context.notebook);
    expect(compact.context.notebook).toMatchObject({ rule: expect.stringContaining("notRun/stale 不代表空表") });
    expect(compact.context.notebook).toMatchObject({ rule: expect.stringContaining("不创建草稿或自动运行") });
    expect(compact.toolNames).toEqual(["cellSearch"]);
  });
});
