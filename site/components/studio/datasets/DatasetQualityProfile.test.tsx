import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DataRow, DataSourceDefinition } from "@/core/models";
import { DataSourceDetailsPanel } from "../DataSourceDetailsPanel";

const source: DataSourceDefinition = {
  id: "dataset_quality_ui", name: "合成数据", rowCount: 4, columnCount: 2,
  qualityScore: 81, updatedAt: "2026-09-16T00:00:00.000Z", sourceType: "csv",
  fields: [
    { name: "category", label: "分类", type: "string", aggregatable: false, supportedAggregations: ["none", "count"] },
    { name: "note", label: "说明", type: "string", aggregatable: false, supportedAggregations: ["none", "count"] },
  ],
};
const rows: DataRow[] = [
  { category: "A", note: "" }, { category: "A", note: "" },
  { category: null }, { category: " ", note: "\t" },
];
function render(definition = source, currentRows = rows) {
  return renderToStaticMarkup(<DataSourceDetailsPanel source={definition} rows={currentRows}
    onPreviewRecipeBinding={() => {}} onClose={() => {}} />);
}
function currentStatistics(html: string) {
  const section = html.match(/<section[^>]*aria-label="当前数据统计"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  expect(section).toBeDefined();
  return section!;
}

describe("dataset current-row quality presentation", () => {
  it("provides current statistics for a legacy source without stored quality", () => {
    const html = render(); const statistics = currentStatistics(html);
    expect(html).toContain("导入 / 来源质量摘要");
    expect(html).toContain("81%");
    expect(statistics).toContain("当前行数</dt><dd>4</dd>");
    expect(statistics).toContain("声明字段</dt><dd>2</dd>");
    expect(statistics).toContain("空单元格</dt><dd>2 / 8");
    expect(statistics).toContain("25.0%");
    expect(statistics).toContain("全空行</dt><dd>1</dd>");
    expect(statistics).toContain("额外重复行</dt><dd>1</dd>");
  });
  it("preserves source quality separately instead of presenting it as current counts", () => {
    const html = render({ ...source, quality: { nullCellCount: 9, nullRate: 0.75, duplicateRowCount: 7,
      typeConflictCount: 3, anomalies: [] } });
    expect(html).toContain("75.0% · 重复行 7");
    expect(html).toContain('aria-label="导入 / 来源质量提示"');
    const statistics = currentStatistics(html);
    expect(statistics).toContain("空单元格</dt><dd>2 / 8");
    expect(statistics).not.toContain("75.0%");
    expect(statistics).not.toContain("重复行 7");
  });
  it("warns when available rows differ from the declared count without claiming complete coverage", () => {
    const statistics = currentStatistics(render({ ...source, rowCount: 80 }));
    expect(statistics).toContain("当前可用 4 行，数据源声明 80 行；以下不是全量统计。");
    expect(statistics).toContain("当前行数</dt><dd>4</dd>");
  });
  it("shows empty data counts without NaN, infinite rates or invented empty rows", () => {
    const statistics = currentStatistics(render({ ...source, rowCount: 0 }, []));
    expect(statistics).toContain("当前行数</dt><dd>0</dd>");
    expect(statistics).toContain("空单元格</dt><dd>0 / 0");
    expect(statistics).toContain("0.0%");
    expect(statistics).toContain("全空行</dt><dd>0</dd>");
    expect(statistics).toContain("额外重复行</dt><dd>0</dd>");
    expect(statistics).not.toMatch(/NaN|Infinity/);
  });
  it("explains nulls, duplicate denominators, blank strings and the original-file boundary", () => {
    const statistics = currentStatistics(render());
    expect(statistics).toContain("空值＝null 或缺失");
    expect(statistics).toContain("当前行数 × 声明字段数");
    expect(statistics).toContain("全部声明字段为空");
    expect(statistics).toContain("相同记录不计第一次");
    expect(statistics).toContain("空字符串或纯空白字符串 4 个不算 null");
    expect(statistics).toContain("未检查原件物理行、表头或全空白行");
  });
});
