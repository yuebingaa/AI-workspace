import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { NotebookCell, NotebookArtifact } from "@/core/notebook/definition";
import type { NotebookDocument } from "@/core/notebook/contracts";
import { cellSource, cellReviewSource, applyRecipeSource, sourceDiff } from "./cell-source";
import { NotebookSource } from "./NotebookSource";
import { NotebookDraftReview } from "./NotebookDraftReview";

const query: Extract<NotebookCell, { kind: "sql" }> = { id: "query", kind: "sql", title: "地区汇总", inputCellIds: ["data"], outputName: "summary", sql: "SELECT region, SUM(amount) AS revenue\nFROM sales GROUP BY region" };
const recipe: Extract<NotebookCell, { kind: "transform" }> = { id: "recipe", kind: "transform", title: "整理数据", inputCellId: "data", outputName: "clean", steps: [{ id: "limit", type: "limit", count: 20 }] };

describe("Notebook source and rule editing", () => {
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
});
