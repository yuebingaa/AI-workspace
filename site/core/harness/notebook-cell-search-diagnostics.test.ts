import { describe, expect, it } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { StudioValidationError } from "@/core/schemas";
import { NotebookSearchError } from "@/core/notebook/search";
import { NotebookSearchStateError } from "./notebook-cell-search";
import { executeHarnessTool, type HarnessToolContext } from "./tool-registry";

function context(): HarnessToolContext {
  const { product, source, rows } = semanticFixture();
  const document = { name: "诊断测试", revision: 7, cells: [
    { id: "data", kind: "data" as const, title: "数据", sourceDataSourceId: source.id, outputName: "sales_data" },
  ] };
  return { request: { idempotencyKey: "search_diagnostic_fixture", instruction: "检索当前单元",
    role: "editor", pageId: "page_home", appSpec: product.appSpec, recipes: [], dataSourceId: source.id,
    notebookContext: { document, sourceIds: [source.id] } },
  dataRuntime: { rowsByDataSourceId: { [source.id]: rows } }, now: Date.now, id: () => "fixed",
  notebookCellSession: { document: structuredClone(document), editVersion: 0 } };
}

describe("cellSearch finite business errors", () => {
  it.each([
    { args: { cellId: "SYNTHETIC_PRIVATE_CELL" }, code: "notebook_search_anchor_not_found", validation: false, text: "找不到" },
    { args: { direction: "upstream" }, code: "notebook_search_anchor_required", validation: false, text: "需要指定" },
    { args: { editVersion: 1 }, code: "notebook_search_version_stale", validation: true, text: "草稿版本已变化" },
    { args: { runId: "SYNTHETIC_PRIVATE_RUN" }, code: "notebook_search_run_stale", validation: true, text: "运行结果已变化" },
    { args: {}, code: "notebook_search_budget_exceeded", validation: true, text: "超过当前工具预算" },
  ])("$code preserves failure category without identifiers or request values", async fixture => {
    const input = context();
    if (fixture.code === "notebook_search_budget_exceeded") input.resultBudgetChars = 1;
    const before = structuredClone(input.notebookCellSession);
    let failure: unknown;
    try { await executeHarnessTool("cellSearch", fixture.args, input); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(fixture.validation ? NotebookSearchStateError : NotebookSearchError);
    expect(failure instanceof StudioValidationError).toBe(fixture.validation);
    expect(failure).toMatchObject({ code: fixture.code });
    expect(String(failure)).toContain(fixture.text);
    expect(JSON.stringify(failure)).not.toContain("SYNTHETIC_PRIVATE");
    expect(input.notebookCellSession).toEqual(before);
  });
});
