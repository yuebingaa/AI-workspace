import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { notebookDatasetProvenanceSchema, type DatasetLineage } from "@/core/datasets/provenance";
import { DatasetProvenance } from "./DatasetProvenance";

const kinds = [
  ["data", "源数据"], ["sql", "本地 SQL"], ["python", "Python"], ["warehouseSql", "数据库 SQL"],
  ["semanticQuery", "语义查询"], ["transform", "数据处理"], ["table", "表格"], ["chart", "图表"], ["text", "说明"], ["parameter", "参数"],
] as const;

function provenance(steps: DatasetLineage["steps"]) {
  return notebookDatasetProvenanceSchema.parse({
    kind: "notebook", runId: "synthetic_run", resultId: "synthetic_result", cellId: "result", revision: 1, connectionIds: [],
    lineage: { version: 1, recordedAt: "2026-09-17T00:00:00Z", accessMode: "user", sourceDatasetIds: [],
      rowCount: 1, complete: true, dataSignature: "a".repeat(64), steps },
  });
}

describe("Dataset Notebook source presentation", () => {
  it.each(kinds)("renders the %s label without changing existing root-source wording", (kind, label) => {
    const html = renderToStaticMarkup(<DatasetProvenance provenance={provenance([
      { cellId: "result", kind, title: "合成步骤", inputCellIds: [], definition: "{}" },
    ])} />);
    expect(html).toContain(`<span>${label}</span>`);
    expect(html).toContain(`输入：${kind === "parameter" ? "参数值" : "数据来源"}`);
    expect(html).toContain("下载来源记录");
    expect(html).not.toContain("undefined");
  });
  it("retains named upstream links and escaped parameter definitions", () => {
    const input = provenance([
      { cellId: "parameter", kind: "parameter", title: "合成参数", inputCellIds: [], definition: JSON.stringify({ value: "<script>literal</script>" }) },
      { cellId: "result", kind: "sql", title: "合成查询", inputCellIds: ["parameter"], definition: "{}" },
    ]);
    const html = renderToStaticMarkup(<DatasetProvenance provenance={input} />);
    expect(html).toContain("输入：参数值");
    expect(html).toContain("输入：合成参数");
    expect(html).toContain("&lt;script&gt;literal&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("keeps missing provenance hidden and old reference-only receipts readable", () => {
    expect(renderToStaticMarkup(<DatasetProvenance />)).toBe("");
    const input = provenance([]);
    delete input.lineage;
    const html = renderToStaticMarkup(<DatasetProvenance provenance={input} />);
    expect(html).toContain("此历史结果只保留运行引用，没有详细步骤。");
    expect(html).not.toContain("参数值");
  });
});
