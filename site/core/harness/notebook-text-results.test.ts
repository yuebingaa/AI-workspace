import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { executeNotebook } from "@/core/notebook/server/execution";
import type { NotebookCell } from "@/core/notebook/definition";
import type { NotebookRun } from "@/core/notebook/contracts";
import { notebookTextResults, preserveNotebookTextResultMetadata } from "./notebook-text-results";
import { compactHarnessToolResult, executeHarnessTool, type HarnessToolContext } from "./tool-registry";

const textDataSchema = z.object({
  textResults: z.array(z.object({ cellId: z.string(), text: z.string(), truncated: z.boolean(), characterCount: z.number() }).strict()),
  textResultsOmitted: z.number(),
});

describe("bounded Notebook text observations", () => {
  it("keeps at most three successful texts and reports exact preview and omitted counts", () => {
    const run: NotebookRun = { runId: "run", revision: 1, startedAt: "2026-09-17T00:00:00.000Z", status: "failure", dataSignature: "test", notice: "synthetic",
      cells: [
        { cellId: "first", status: "success", durationMs: 1, text: "first" },
        { cellId: "empty", status: "success", durationMs: 1, text: "" },
        { cellId: "exact", status: "success", durationMs: 1, text: "x".repeat(800) },
        { cellId: "long", status: "success", durationMs: 1, text: "y".repeat(801) },
        { cellId: "failed", status: "failure", durationMs: 1, text: "must-not-return" },
      ] };
    const before = structuredClone(run);
    expect(notebookTextResults(run)).toEqual({ textResults: [
      { cellId: "empty", text: "", truncated: false, characterCount: 0 },
      { cellId: "exact", text: "x".repeat(800), truncated: false, characterCount: 800 },
      { cellId: "long", text: "y".repeat(800), truncated: true, characterCount: 801 },
    ], textResultsOmitted: 1 });
    expect(run).toEqual(before);
  });

  it("corrects a false complete flag after generic budget compression without restoring removed characters", () => {
    const source = { textResults: [{ cellId: "note", text: "a".repeat(600), truncated: false, characterCount: 600 }], textResultsOmitted: 0 };
    const compacted = { textResults: [{ cellId: "note", text: "a".repeat(220) + "…", truncated: false, characterCount: 600 }] };
    expect(preserveNotebookTextResultMetadata(source, compacted)).toEqual({ textResults: [
      { cellId: "note", text: "a".repeat(220) + "…", truncated: true, characterCount: 600 },
    ], textResultsOmitted: 0 });
    expect(source.textResults[0].text).toHaveLength(600);
  });

  it("restores omitted metadata fields as one atomic item and counts missing rows, not generic array sentinels", () => {
    const source = { textResults: [
      { cellId: "first", text: "abc", truncated: false, characterCount: 3 },
      { cellId: "second", text: "def", truncated: false, characterCount: 3 },
    ], textResultsOmitted: 4 };
    const compacted = { textResults: [{ cellId: "first", text: "abc" }, { truncated: true, omittedCount: 1 }] };
    expect(preserveNotebookTextResultMetadata(source, compacted)).toEqual({ textResults: [
      { cellId: "first", text: "abc", truncated: false, characterCount: 3 },
    ], textResultsOmitted: 5 });
  });

  it("does not fabricate text when compression removed the text property or entire array", () => {
    const source = { textResults: [{ cellId: "note", text: "private synthetic body", truncated: false, characterCount: 22 }], textResultsOmitted: 2 };
    for (const compacted of [{ textResults: [{ cellId: "note" }] }, { truncated: true, summaryOnly: "omitted" }]) {
      const result = preserveNotebookTextResultMetadata(source, compacted);
      expect(result).toMatchObject({ textResults: [], textResultsOmitted: 3 });
      expect(JSON.stringify(result)).not.toContain("private synthetic body");
    }
  });

  it("leaves non-text tools unchanged", () => {
    const compacted = { rows: [], truncated: true };
    expect(preserveNotebookTextResultMetadata({ rows: [1] }, compacted)).toBe(compacted);
  });

  it("reproduces and fixes the actual generic compactor path at a forced 900-character budget", () => {
    const source = { textResults: [{ cellId: "note", text: "a".repeat(600), truncated: false, characterCount: 600 }], textResultsOmitted: 0, padding: "b".repeat(2000) };
    const result = compactHarnessToolResult({ summary: "synthetic text", data: source }, 900, 16, { textResults: true });
    const data = textDataSchema.parse(result.data);
    expect(data.textResults).toEqual([{ cellId: "note", text: "a".repeat(220) + "…", truncated: true, characterCount: 600 }]);
    expect(data.textResultsOmitted).toBe(0);
    expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(900);
    expect(result.summary).toContain("按上下文预算截断");
  });

  it.each([160, 200, 400])("preserves the exact old non-text fallback behavior at budget %s", (budget) => {
    const result = { summary: "s".repeat(1000), data: Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`field_${index}`, "a".repeat(2000)]),
    ) };
    const original = compactHarnessToolResult(result, budget);
    expect(original.data).toHaveProperty("summaryOnly");
    expect(compactHarnessToolResult(result, budget, 16, { textResults: true })).toEqual(original);
  });

  it.each([160, 240, 350, 500])("keeps omission metadata honest through repeated truncation at budget %s", (budget) => {
    const source = { textResults: Array.from({ length: 3 }, (_, index) => ({ cellId: `note_${index}`, text: "x".repeat(800), truncated: true, characterCount: 2000 })),
      textResultsOmitted: 2, padding: "b".repeat(5000) };
    const result = compactHarnessToolResult({ summary: "s".repeat(1000), data: source }, budget, 16, { textResults: true });
    const data = textDataSchema.parse(result.data);
    expect(data.textResults.length + data.textResultsOmitted).toBe(5);
    expect(data.textResults.every((item) => item.truncated && item.characterCount === 2000 && item.text.length <= 800)).toBe(true);
    expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(budget);
  });

  it("wires metadata repair into real createNotebookDraft tool execution without changing the saved document", async () => {
    const { product } = semanticFixture(); product.appSpec.dataSources = [];
    const parameter: NotebookCell = { id: "parameter", kind: "parameter", title: "长文本参数", outputName: "literal", parameter: { type: "text", value: "a".repeat(600) } };
    const note: NotebookCell = { id: "note", kind: "text", title: "说明", markdown: "{{value}}", references: [{ key: "value", cellId: parameter.id, field: "value" }] };
    const context: HarnessToolContext = { request: { idempotencyKey: "text_budget", instruction: "创建引用说明", role: "editor", pageId: "page_home", appSpec: product.appSpec, recipes: [],
      notebookContext: { sourceIds: [], document: { name: "预算验证", revision: 2, cells: [] } } },
      now: Date.now, id: () => crypto.randomUUID(), dataRuntime: { rowsByDataSourceId: {} }, resultBudgetChars: 1000,
      notebookRunner: (artifact, ctx) => executeNotebook({ document: { name: artifact.name, revision: artifact.baseRevision ?? 2, cells: artifact.cells }, sources: [], forAi: true, signal: ctx.signal }, { query: vi.fn(), log: vi.fn() }),
    };
    const result = await executeHarnessTool("createNotebookDraft", { name: "有界说明", cells: [parameter, note] }, context);
    const data = textDataSchema.parse(result.data);
    expect(data.textResults.length + data.textResultsOmitted).toBe(1);
    for (const item of data.textResults) {
      expect(item.characterCount).toBe(600);
      expect(item.truncated).toBe(item.text !== "a".repeat(600));
    }
    expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(1000);
    expect(result.notebookArtifact?.executionEvidence?.status).toBe("success");
    expect(context.request.notebookContext!.document.cells).toEqual([]);
  });
});
