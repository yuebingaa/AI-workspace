import { describe, expect, it } from "vitest";
import { executeDataRecipe } from "@/core/data";
import type { DataRecipe, DataSourceDefinition } from "@/core/models";
import { demoFixtureResult } from "@/fixtures/demo-product";
import {
  escapeExcelFormulaText,
  generateDataRecipeExcel,
  sanitizeExcelFileName,
  type ExcelSheetDefinition,
} from "./recipe-excel-export";

function fixtureInput() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  const fixtures = structuredClone(demoFixtureResult.data);
  const recipe = fixtures.dataProduct.recipes.find((candidate) => candidate.id === "recipe_east_anomalies");
  const source = fixtures.dataProduct.appSpec.dataSources.find((candidate) => candidate.id === recipe?.sourceDatasetId);
  const rows = source ? fixtures.dataRuntime.rowsByDataSourceId[source.id] : undefined;
  if (!recipe || !source || !rows) throw new Error("Excel 测试 fixture 不完整");
  return { recipe, source, rows };
}

describe("DataRecipe Excel 导出", () => {
  it("使用 Node toBuffer 生成包含两个工作表的真实 XLSX", async () => {
    const generated = await generateDataRecipeExcel({
      ...fixtureInput(),
      now: () => new Date("2026-09-02T03:00:00.000Z"),
    });

    expect(generated.fileName).toBe("华东异常订单与复购分析_20260902.xlsx");
    expect(generated.buffer.subarray(0, 2).toString()).toBe("PK");
    expect(generated.sizeBytes).toBe(generated.buffer.length);
    expect(generated.rowCount).toBeGreaterThan(0);
    expect(generated.fieldCount).toBeGreaterThan(0);
  });

  it("只导出配方筛选后的结果，并生成分析结果和导出说明", async () => {
    const input = fixtureInput();
    const execution = executeDataRecipe(input.recipe, input.source, input.rows);
    if (!execution.success) throw new Error(execution.error);
    let captured: ExcelSheetDefinition[] = [];

    const generated = await generateDataRecipeExcel({
      ...input,
      writer: async (sheets) => {
        captured = sheets;
        return Buffer.from("PK mock workbook");
      },
    });

    expect(captured.map((sheet) => sheet.sheet)).toEqual(["分析结果", "导出说明"]);
    expect(captured[0].data).toHaveLength(execution.rows.length + 1);
    expect(generated.rowCount).toBe(execution.rows.length);
    expect(generated.rowCount).toBeLessThan(input.rows.length);
    expect(JSON.stringify(captured[1].data)).toContain("region equals 华东");
    expect(JSON.stringify(captured[1].data)).toContain(input.recipe.id);
  });

  it("显式转义公式注入文本并保留数字、文本和日期类型", async () => {
    const source: DataSourceDefinition = {
      id: "dataset_formula_test",
      name: "formula_test",
      rowCount: 1,
      columnCount: 3,
      qualityScore: 100,
      updatedAt: "2026-09-02T00:00:00.000Z",
      sourceType: "local-fixture",
      fields: [
        { name: "note", label: "文本", type: "string", aggregatable: false, supportedAggregations: ["none"] },
        { name: "amount", label: "金额", type: "number", aggregatable: true, supportedAggregations: ["sum"] },
        { name: "date", label: "日期", type: "date", aggregatable: false, supportedAggregations: ["none"] },
      ],
    };
    const recipe: DataRecipe = {
      id: "recipe_formula_test",
      name: "公式防护测试",
      sourceDatasetId: source.id,
      outputDatasetId: "dataset_formula_output",
      status: "ready",
      steps: [{ id: "select", type: "selectFields", fields: ["note", "amount", "date"] }],
    };
    let captured: ExcelSheetDefinition[] = [];
    await generateDataRecipeExcel({
      recipe,
      source,
      rows: [{ note: "=HYPERLINK(\"bad\")", amount: 42.5, date: "2026-09-02" }],
      writer: async (sheets) => {
        captured = sheets;
        return Buffer.from("PK typed workbook");
      },
    });
    const row = captured[0].data[1] as Array<{ value: unknown; type: unknown }>;
    expect(row[0]).toMatchObject({ value: "'=HYPERLINK(\"bad\")", type: String });
    expect(row[1]).toMatchObject({ value: 42.5, type: Number });
    expect(row[2].type).toBe(Date);
    expect(row[2].value).toBeInstanceOf(Date);
    expect(["=1+1", "+cmd", "-2+3", "@SUM(A1)", "  =hidden"].map(escapeExcelFormulaText))
      .toEqual(["'=1+1", "'+cmd", "'-2+3", "'@SUM(A1)", "'  =hidden"]);
  });

  it("拒绝路径型非法文件名，并清理普通非法字符", () => {
    expect(() => sanitizeExcelFileName("../../secret.xlsx", "fallback")).toThrow(/文件名不合法/);
    expect(() => sanitizeExcelFileName("C:\\temp\\secret.xlsx", "fallback")).toThrow(/文件名不合法/);
    expect(sanitizeExcelFileName("华东:异常*订单.xlsx", "fallback")).toBe("华东_异常_订单.xlsx");
  });

  it("拒绝超出行数、列数、文件大小或超时限制的导出", async () => {
    const input = fixtureInput();
    await expect(generateDataRecipeExcel({ ...input, limits: { maxRows: 1 } })).rejects.toThrow(/行数超限/);
    await expect(generateDataRecipeExcel({ ...input, limits: { maxColumns: 1 } })).rejects.toThrow(/列数超限/);
    await expect(generateDataRecipeExcel({
      ...input,
      limits: { maxFileBytes: 20 },
      writer: async () => Buffer.alloc(21, 1),
    })).rejects.toThrow(/文件大小超限/);
    await expect(generateDataRecipeExcel({
      ...input,
      limits: { timeoutMs: 5 },
      writer: async () => await new Promise((resolve) => setTimeout(() => resolve(Buffer.from("PK late")), 30)),
    })).rejects.toThrow(/导出超时/);
  });
});
