import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { notebookCellSchema, type NotebookCell, type NotebookArtifact } from "@/core/notebook/definition";
import type { NotebookDocument } from "@/core/notebook/contracts";
import { cellSource, cellReviewSource, applyRecipeSource, sourceDiff } from "./cell-source";
import { NotebookSource } from "./NotebookSource";
import { NotebookDraftReview } from "./NotebookDraftReview";

const query: Extract<NotebookCell, { kind: "sql" }> = { id: "query", kind: "sql", title: "地区汇总", inputCellIds: ["data"], outputName: "summary", sql: "SELECT region, SUM(amount) AS revenue\nFROM sales GROUP BY region" };
const recipe: Extract<NotebookCell, { kind: "transform" }> = { id: "recipe", kind: "transform", title: "整理数据", inputCellId: "data", outputName: "clean", steps: [{ id: "limit", type: "limit", count: 20 }] };
const sourceCases: Array<{ cell: NotebookCell; language: string; source: unknown }> = [
  { cell: { id: "data", kind: "data", title: "源", sourceDataSourceId: "sales", outputName: "sales" }, language: "数据引用", source: { sourceDataSourceId: "sales", outputName: "sales" } },
  { cell: { id: "semantic", kind: "semanticQuery", title: "语义", inputCellId: "data", modelId: "model", modelVersion: 1, dimensions: [], measures: ["revenue"], limit: 100, outputName: "totals" }, language: "查询配置", source: { inputCellId: "data", modelId: "model", modelVersion: 1, dimensions: [], measures: ["revenue"], limit: 100, outputName: "totals" } },
  { cell: query, language: "SQL", source: query.sql },
  { cell: { id: "warehouse", kind: "warehouseSql", title: "连接", connectionId: "database", outputName: "remote", sql: "SELECT 1 AS value" }, language: "SQL", source: "SELECT 1 AS value" },
  { cell: { id: "python", kind: "python", title: "代码", inputCellIds: [], fileNames: [], outputName: "frame", code: 'frame = pd.DataFrame({"x": [1]})\nprint(frame)' }, language: "Python", source: 'frame = pd.DataFrame({"x": [1]})\nprint(frame)' },
  { cell: recipe, language: "DataRecipe · JSON", source: recipe.steps },
  { cell: { id: "table", kind: "table", title: "表", inputCellId: "data", columns: ["region"] }, language: "展示配置", source: { inputCellId: "data", columns: ["region"] } },
  { cell: { id: "chart", kind: "chart", title: "图", inputCellId: "data", chartType: "bar", categoryField: "region", valueFields: ["amount"] }, language: "展示配置", source: { inputCellId: "data", chartType: "bar", categoryField: "region", valueFields: ["amount"] } },
  { cell: { id: "text", kind: "text", title: "说明", markdown: "# 分析口径\n保留原文" }, language: "Markdown", source: "# 分析口径\n保留原文" },
];

describe("Notebook source and rule editing", () => {
  it.each(sourceCases)("preserves $cell.kind source language and unformatted contents", ({ cell, language, source }) => {
    expect(notebookCellSchema.parse(cell)).toEqual(cell);
    expect(cellSource(cell)).toEqual({ language, value: typeof source === "string" ? source : JSON.stringify(source, null, 2) });
  });
  it("shows executable SQL without silently formatting or changing it", () => {
    expect(cellSource(query)).toEqual({ language: "SQL", value: query.sql });
    expect(cellSource({ ...query, kind: "warehouseSql", connectionId: "warehouse" } as NotebookCell).value).toBe(query.sql);
  });
  it("keeps source and connection rebinding visible even when the SQL is identical", () => {
    expect(cellReviewSource({ ...query, inputCellIds: ["other_data"] })).not.toBe(cellReviewSource(query));
    const external: NotebookCell = { id: "external", kind: "warehouseSql", title: "数据库查询", connectionId: "first", outputName: "external_result", sql: "SELECT * FROM sales" };
    expect(cellReviewSource({ ...external, connectionId: "second" })).not.toBe(cellReviewSource(external));
  });
  it("round-trips rules, preserving identity, dependencies and output names", () => {
    expect(applyRecipeSource(recipe, cellSource(recipe).value)).toEqual(recipe);
    const changed = applyRecipeSource(recipe, '[{"id":"limit","type":"limit","count":5}]');
    expect(changed).toEqual({ ...recipe, steps: [{ id: "limit", type: "limit", count: 5 }] });
    expect(recipe.steps[0]).toEqual({ id: "limit", type: "limit", count: 20 });
  });
  it.each(["[", "[]", '{"steps":[]}', '[{"id":"bad","type":"eval","code":"x"}]', '[{"id":"limit","type":"limit","count":0}]'])("rejects invalid rule source without mutating the saved cell: %s", (source) => {
    const before = structuredClone(recipe);
    expect(() => applyRecipeSource(recipe, source)).toThrow(/处理规则/);
    expect(recipe).toEqual(before);
  });
});

describe("Notebook review diff", () => {
  it.each([
    [undefined, "new\nlast"], ["old\nlast", undefined], ["", ""],
    ["same\nold\nend", "same\nnew\nend"], ["a\nb", "a\nb\nc"],
    ["a\nb\nc", "a\nc"], ["a\nb\nc\nd", "z\nb\nc\nx"],
  ])("preserves both complete versions and correct line numbers", (before, after) => {
    const lines = sourceDiff(before, after);
    const old = lines.filter((line) => line.kind !== "added");
    const next = lines.filter((line) => line.kind !== "removed");
    expect(old.map((line) => line.text)).toEqual(before === undefined ? [] : before.split("\n"));
    expect(next.map((line) => line.text)).toEqual(after === undefined ? [] : after.split("\n"));
    expect(old.map((line) => line.oldLine)).toEqual(old.map((_, i) => i + 1));
    expect(next.map((line) => line.newLine)).toEqual(next.map((_, i) => i + 1));
  });
  it("handles a long changed region without truncating review content", () => {
    const lines = sourceDiff("x\n".repeat(5000), "y\n".repeat(5000));
    expect(lines.filter((line) => line.kind === "removed")).toHaveLength(5000);
    expect(lines.filter((line) => line.kind === "added")).toHaveLength(5000);
  });
  it("renders query-like HTML as escaped code, never active markup", () => {
    const html = renderToStaticMarkup(<NotebookSource language="SQL" label="代码" value={'SELECT \'<script>alert(1)</script>\' -- <img src=x onerror=alert(2)>'} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });
  it("disables adoption of stale drafts without mutating the current document", () => {
    const document: NotebookDocument = { name: "文档", revision: 3, cells: [{ id: "note", kind: "text", title: "说明", markdown: "原文" }] };
    const artifact: NotebookArtifact = { id: "draft", version: 1, status: "draft", name: "文档", baseRevision: 2, cells: [{ ...document.cells[0], kind: "text", markdown: "新文" }], executionOrder: ["note"], lineage: [{ cellId: "note", dependsOn: [] }], sourceDataSourceIds: [], createdAt: "2026-09-15T00:00:00.000Z" };
    const html = renderToStaticMarkup(<NotebookDraftReview document={document} draft={artifact} disabled={false} onAdopt={() => { throw Error("must not adopt during render"); }} onDismiss={() => {}} />);
    expect(html).toMatch(/disabled=""[^>]*>采用草稿/);
    expect(html).toContain("原文"); expect(html).toContain("新文");
    expect(document.revision).toBe(3);
  });
  it.each([undefined, "预览尚未成功运行"])("keeps preview confirmation explicit and respects execution failure: %s", (blockedReason) => {
    const document: NotebookDocument = { name: "原文档", revision: 2, cells: [{ id: "note", kind: "text", title: "说明", markdown: "原文" }] };
    const before = structuredClone(document);
    const artifact: NotebookArtifact = { id: "preview", version: 1, status: "draft", name: "预览文档", baseRevision: 2,
      cells: [{ id: "note", kind: "text", title: "说明", markdown: "新文" }], executionOrder: ["note"], lineage: [{ cellId: "note", dependsOn: [] }],
      sourceDataSourceIds: [], createdAt: "2026-09-24T00:00:00.000Z" };
    const html = renderToStaticMarkup(<NotebookDraftReview document={document} draft={artifact} previewing disabled={false} blockedReason={blockedReason}
      onAdopt={() => { throw Error("must not confirm during render"); }} onDismiss={() => { throw Error("must not dismiss during render"); }} />);
    expect(html).toContain("正在预览 AI 更改 · 待确认");
    expect(html).toContain("撤销预览"); expect(html).toContain("确认更改");
    expect(/disabled=""[^>]*>确认更改/.test(html)).toBe(Boolean(blockedReason));
    expect(document).toEqual(before);
  });
});
