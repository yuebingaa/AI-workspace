import { describe, expect, it } from "vitest";
import { notebookSemanticModelIssue } from "./client-state";
import type { NotebookCell } from "./definition";
import { semanticFixture } from "@/core/semantic/test-fixture";

const { model } = semanticFixture();
const cell: Extract<NotebookCell, { kind: "semanticQuery" }> = { id: "semantic_query", kind: "semanticQuery", title: "业务汇总",
  inputCellId: "data", modelId: model.id, modelVersion: 1, dimensions: ["area"], measures: ["revenue"], limit: 10, outputName: "totals" };
describe("Notebook semantic model adoption preflight", () => {
  it("rejects an old draft when its model is missing and preserves definitions", () => {
    const cells = [structuredClone(cell)], before = structuredClone(cells);
    expect(notebookSemanticModelIssue(cells, [])).toContain("已删除或不在当前工作界面");
    expect(notebookSemanticModelIssue(cells, [])).toContain("semantic_query");
    expect(cells).toEqual(before);
  });
  it("accepts the same model ID and leaves version and member checks to execution", () => {
    expect(notebookSemanticModelIssue([cell], [model])).toBeUndefined();
    expect(notebookSemanticModelIssue([cell], [{ ...model, version: 2 }])).toBeUndefined();
    expect(notebookSemanticModelIssue([cell], [{ ...model, id: "different_model" }])).toBeTruthy();
  });
  it("does not scan arbitrary source text or reject non-semantic drafts", () => {
    expect(notebookSemanticModelIssue([{ id: "text", kind: "text", title: "说明", markdown: model.id }], [])).toBeUndefined();
    expect(notebookSemanticModelIssue([], [])).toBeUndefined();
  });
  it("caps diagnostics while reporting every missing reference in the total", () => {
    const issue = notebookSemanticModelIssue(Array.from({ length: 5 }, (_, index) => ({ ...cell, id: `query_${index}` })), []);
    expect(issue).toContain("另有 2 个单元"); expect(issue).toContain("query_2"); expect(issue).not.toContain("query_3");
  });
});
