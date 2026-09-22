import { describe, expect, it } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import type { HarnessObservation } from "./contracts";
import { buildHarnessContextSelection } from "./context-selector";
import { compactHarnessToolResult, executeHarnessTool, type HarnessToolContext } from "./tool-registry";
import { indexRawWorkbook, publicRawWorkbookProfile, queryRawWorkbook } from "./raw-workbook-engine";

function context(): HarnessToolContext {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  const data = structuredClone(demoFixtureResult.data);
  const source = data.dataProduct.appSpec.dataSources.find((item) => item.id === "dataset_retail_orders")!;
  source.fields = ["value", "label"].map((name) => ({ ...source.fields[0], name, label: name,
    type: "string", sensitiveCategories: ["name"] }));
  source.rowCount = 123;
  source.columnCount = 2;
  source.aiAccessPolicy = "masked";
  data.dataRuntime.rowsByDataSourceId[source.id] = [
    {}, { value: null, label: null }, { value: "", label: "SYNTHETIC_PRIVATE_VALUE" },
    { value: " ", label: "SYNTHETIC_PRIVATE_VALUE" }, { value: 0, label: false },
    { value: "0", label: false }, { value: 0, label: false }, { value: "Alpha", label: "SYNTHETIC_PRIVATE_VALUE" },
  ];
  return { request: { idempotencyKey: "quality_scope", instruction: "检查数据集空值和重复行，不要修改页面",
    dataSourceId: source.id, pageId: "page_home", role: "editor",
    appSpec: data.dataProduct.appSpec, recipes: data.dataProduct.recipes },
  dataRuntime: data.dataRuntime, now: () => 1_000, id: () => "quality_scope" };
}

async function observation(toolName: "inspectDataset" | "inspectFields", input = context()): Promise<HarnessObservation> {
  const result = await executeHarnessTool(toolName, { dataSourceId: "dataset_retail_orders" }, input);
  return { toolName, toolCallId: `quality_${toolName}`, summary: result.summary, data: result.data };
}

describe("Harness 当前行集质量统计口径", () => {
  it("返回真实当前行集统计，不沿用描述行数或把结果称为原文件空行", async () => {
    const result = await observation("inspectDataset");
    expect(result.data).toMatchObject({ rowCount: 8, columnCount: 2, qualityProfile: {
      version: 1, rowCount: 8, columnCount: 2, cellCount: 16, nullCellCount: 4, nullRate: 0.25,
      emptyRowCount: 2, duplicateRowCount: 2, nonNullBlankStringCount: 2,
      declaredRowCount: 123, rowCountMatchesSource: false,
      rules: { scope: "current-dataset-rows", nulls: "null-or-missing", blankStrings: "not-null",
        duplicates: "typed-all-declared-fields-excluding-first", emptyRows: "all-declared-fields-null",
        denominator: "rows-times-declared-columns", originalFile: "not-measured" },
    } });
    expect(JSON.stringify(result.data)).not.toContain("SYNTHETIC_PRIVATE_VALUE");
    expect(result.data).not.toHaveProperty("rows");
    expect(result.summary).toContain("导入/来源质量");
  });

  it("字段分析提供当前行数与空值比例分母，保留敏感样本策略", async () => {
    const result = await observation("inspectFields");
    expect(result.data).toMatchObject({ rowCount: 8, fieldCount: 2,
      rules: { scope: "current-dataset-rows", nulls: "null-or-missing", blankStrings: "not-null",
        denominator: "rows-per-field", originalFile: "not-measured" },
      fields: [{ field: "value", nullCount: 2, nullRatio: 0.25 }, { field: "label", nullCount: 2, nullRatio: 0.25 }],
    });
    expect(JSON.stringify(result.data)).not.toContain("SYNTHETIC_PRIVATE_VALUE");
  });

  it.each([false, true])("普通/压缩上下文保留统计数字及口径（压缩=%s）", async (compacted) => {
    const input = context();
    const dataset = await observation("inspectDataset", input);
    const selection = buildHarnessContextSelection(input.request, [dataset], 2, compacted);
    expect(selection.context).toMatchObject({ latestObservation: { result: {
      qualityProfile: { nullCellCount: 4, duplicateRowCount: 2, rules: { scope: "current-dataset-rows", originalFile: "not-measured" } },
    } } });
    expect(selection.workingMemory.keyStatistics.join(" ")).toContain("当前数据集行集");
    expect(selection.workingMemory.keyStatistics.join(" ")).toContain("不代表原文件");
    const fields = await observation("inspectFields", input);
    const followUp = buildHarnessContextSelection(input.request, [dataset, fields], 3, compacted);
    expect(followUp.context)
      .toMatchObject({ latestObservation: { result: { rowCount: 8, rules: { denominator: "rows-per-field" },
        fields: [{ nullRatio: 0.25 }, { nullRatio: 0.25 }] } } });
    const qualityFact = "dataset_retail_orders: 行集空单元格4/16[null/缺失]，空白串2[非空]，全空行2[全声明列]，重复2[类型/全列,不计首次]；实际8/声明123行不符，完整性未证实，非原件";
    expect(followUp.workingMemory.keyStatistics).toContain(qualityFact);
    expect(followUp.context).toMatchObject({ workingMemory: { verifiedFacts: expect.arrayContaining([qualityFact]) } });
    expect(qualityFact.length).toBeLessThanOrEqual(240);
  });

  it.each([false, true])("仅页面后续修改省略无关质量数值，质量分析加页面修改仍保留（压缩=%s）", async (compacted) => {
    const input = context();
    input.request.instruction = "检查 retail_orders 数据集的基本信息，并将‘本月收入’标题改为‘月度总收入’，不要应用";
    const dataset = await observation("inspectDataset", input);
    const page = buildHarnessContextSelection(input.request, [dataset], 2, compacted);
    expect(page.toolNames).toEqual(["createChangeSetPreview"]);
    expect(page.context).toMatchObject({ latestObservation: { result: { qualityProfile: {
      statisticsOmitted: true, rules: { scope: "current-dataset-rows", originalFile: "not-measured" },
    } } } });
    expect(JSON.stringify(page.context)).not.toContain('"nullCellCount"');
    expect(JSON.stringify(page.context)).not.toContain('"duplicateRowCount"');
    expect(page.workingMemory.keyStatistics.join(" ")).not.toContain("行集空单元格");

    input.request.instruction = "检查 retail_orders 字段空值和重复行，并将‘本月收入’标题改为‘月度总收入’，不要应用";
    const analysis = buildHarnessContextSelection(input.request, [dataset], 2, compacted);
    expect(analysis.context).toMatchObject({ latestObservation: { result: { qualityProfile: {
      nullCellCount: 4, duplicateRowCount: 2,
      rules: { scope: "current-dataset-rows", duplicates: "typed-all-declared-fields-excluding-first" },
    } } } });
  });

  it("宽表触发工具结果压缩时优先省略字段，完整保留计数规则", async () => {
    const input = context();
    const source = input.request.appSpec.dataSources.find((item) => item.id === "dataset_retail_orders")!;
    source.fields = Array.from({ length: 40 }, (_, index) => ({ ...source.fields[0],
      name: `column_${index}`, label: "宽字段".repeat(40) }));
    input.resultBudgetChars = 1_600;
    input.resultBudgetEntries = 4;
    const result = await observation("inspectDataset", input);
    expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(1_600);
    expect(result.data).toMatchObject({ qualityProfile: { rowCount: 8, columnCount: 40,
      rules: { scope: "current-dataset-rows", denominator: "rows-times-declared-columns", originalFile: "not-measured" } } });
    expect(result.summary).toContain("截断");
  });

  it("极小工具预算无法容纳完整统计时只给范围明确的摘要", async () => {
    const input = context();
    input.resultBudgetChars = 200;
    const result = await observation("inspectDataset", input);
    expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(200);
    expect(result.data).toMatchObject({ truncated: true });
    expect(result.data).not.toHaveProperty("qualityProfile");
    expect(result.data).not.toHaveProperty("rowCount");
    expect(result.summary).toContain("当前数据集行集");
  });

  it("字段工具预算裁剪整个统计记录，保留分母与真实字段总数", async () => {
    const input = context();
    const source = input.request.appSpec.dataSources.find((item) => item.id === "dataset_retail_orders")!;
    source.fields = Array.from({ length: 20 }, (_, index) => ({ ...source.fields[0], name: `column_${index}` }));
    input.resultBudgetChars = 1_200;
    input.resultBudgetEntries = 4;
    const result = await observation("inspectFields", input);
    expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(1_200);
    expect(result.data).toMatchObject({ rowCount: 8, fieldCount: 20, truncated: true,
      rules: { scope: "current-dataset-rows", denominator: "rows-per-field" },
      fields: expect.arrayContaining([expect.objectContaining({ field: "column_0", nullCount: 8, nullRatio: 1, uniqueCount: 0 })]),
    });
  });

  it.each([false, true])("原件扫描/查询口径在普通与压缩上下文保留（压缩=%s）", (compacted) => {
    const input = context();
    const index = indexRawWorkbook([{ sheet: "合成原件", data: [["Line", "DT(s)"], [null, null], ["A", 1]] }], "quality_context_scope");
    const profile = publicRawWorkbookProfile(index);
    const query = queryRawWorkbook(index, { mode: "rows", sheetName: "合成原件" });
    for (const [toolName, data] of [["scanEdsRawWorkbook", profile], ["queryEdsRawWorkbook", query]] as const) {
      const selection = buildHarnessContextSelection(input.request, [{ toolName, data, summary: "合成原件统计", toolCallId: toolName }], 2, compacted);
      expect(selection.context).toMatchObject({ latestObservation: { result: { rules: profile.rules, scannedDataRowCount: 1 } } });
      expect(selection.workingMemory.keyStatistics.join(" ")).toContain("自动表头后非空白记录");
      expect(selection.workingMemory.keyStatistics.join(" ")).toContain("不代表原文件空行数");
    }
  });

  it("极小预算省略原件计数后，工作记忆不能将未知写成0", () => {
    const input = context();
    const profile = publicRawWorkbookProfile(indexRawWorkbook([{ sheet: "合成原件", data: [
      ["Line", "DT(s)"], ["A", 1],
    ] }], "quality_omitted_scope"));
    const result = compactHarnessToolResult({ summary: "原件仅检查表头后非空白记录，统计不可用于推断原文件空行数。", data: profile }, 180, 4, { keys: ["rules"] });
    expect(result.data).toMatchObject({ truncated: true });
    expect(result.data).not.toHaveProperty("scannedDataRowCount");
    for (const toolName of ["scanEdsRawWorkbook", "queryEdsRawWorkbook"] as const) {
      const selection = buildHarnessContextSelection(input.request, [{ toolName, toolCallId: toolName,
        summary: result.summary, data: result.data }], 2, true);
      expect(selection.workingMemory.keyStatistics.join(" ")).toContain("统计值不可用");
      expect(selection.workingMemory.keyStatistics.join(" ")).not.toMatch(/0 (?:行|条)/u);
    }
  });

  it("字段结果整体省略后，不虚构零字段", async () => {
    const input = context();
    input.resultBudgetChars = 150;
    const result = await observation("inspectFields", input);
    expect(result.data).toMatchObject({ truncated: true });
    expect(result.data).not.toHaveProperty("fieldCount");
    const selection = buildHarnessContextSelection(input.request, [result], 2, true);
    expect(selection.context).toMatchObject({ latestObservation: { result: { truncated: true } } });
    expect(JSON.stringify(selection.context)).not.toContain('"fieldCount":0');
  });

  it.each([false, true])("字段上下文裁剪准确标明总数及截断（压缩=%s）", async (compacted) => {
    const input = context();
    const source = input.request.appSpec.dataSources.find((item) => item.id === "dataset_retail_orders")!;
    source.fields = Array.from({ length: 20 }, (_, index) => ({ ...source.fields[0], name: `column_${index}` }));
    input.resultBudgetChars = 50_000;
    const fields = await observation("inspectFields", input);
    expect(buildHarnessContextSelection(input.request, [fields], 2, compacted).context)
      .toMatchObject({ latestObservation: { result: { fieldCount: 20, truncated: true,
        rowCount: 8, rules: { scope: "current-dataset-rows" } } } });
  });
});
