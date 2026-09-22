import { describe, expect, it } from "vitest";
import type { NotebookDocument, NotebookRun } from "./contracts";
import { captureNotebookRunExpectation, parseNotebookRunReceipt } from "./run-receipt";
import { executeNotebook } from "./server/execution";
import { notebookTextResults } from "@/core/harness/notebook-text-results";

function document(): NotebookDocument {
  return { name: "Text receipt", revision: 3, cells: [
    { id: "amount", kind: "parameter", title: "Amount", outputName: "amount", parameter: { type: "text", value: "001" } },
    { id: "note", kind: "text", title: "Note", markdown: "{{value}}", references: [{ key: "value", cellId: "amount", field: "value" }] },
    { id: "static", kind: "text", title: "Static", markdown: "{{legacy}}" },
  ] };
}
async function run() {
  return executeNotebook({ document: document(), sources: [], forAi: true }, { query: async () => { throw new Error("No SQL expected"); }, log: () => {} });
}

describe("text receipt consistency and bounded Agent observations", () => {
  it("captures required text IDs immutably and keeps static-only expectation shape", () => {
    const doc = document(), expected = captureNotebookRunExpectation(doc, "ai");
    expect(expected.textCellIds).toEqual(["note"]); expect(Object.isFrozen(expected.textCellIds)).toBe(true);
    doc.cells[1].id = "changed"; expect(expected.textCellIds).toEqual(["note"]);
    expect(captureNotebookRunExpectation(document(), "ai", "static")).not.toHaveProperty("textCellIds");
  });

  it("accepts real text without a table reference and emits an explicit text preview", async () => {
    const actual = await run(); const parsed = parseNotebookRunReceipt(actual, captureNotebookRunExpectation(document(), "ai"));
    expect(parsed.cells[1].text).toBe("001"); expect(parsed.cells[1]).not.toHaveProperty("resultRef");
    expect(parsed.cells[2]).not.toHaveProperty("text");
    expect(notebookTextResults(parsed)).toEqual({ textResults: [{ cellId: "note", text: "001", truncated: false, characterCount: 3 }], textResultsOmitted: 0 });
  });

  it.each(["missing", "failure", "static", "parameter", "table", "reference"])("rejects incorrect text result: %s", async (kind) => {
    const actual = await run();
    if (kind === "missing") delete actual.cells[1].text;
    if (kind === "failure") { actual.status = "failure"; actual.cells[1].status = "failure"; }
    if (kind === "static") actual.cells[2].text = "not executed";
    if (kind === "parameter") actual.cells[0].text = "wrong kind";
    if (kind === "table") actual.cells[1].table = actual.cells[0].table;
    if (kind === "reference") actual.cells[1].resultRef = actual.cells[0].resultRef;
    expect(() => parseNotebookRunReceipt(actual, captureNotebookRunExpectation(document(), "ai"))).toThrow("执行回执与本次草稿不一致");
  });

  it("allows failures without text and preserves successful empty text", async () => {
    const actual = await run(); actual.cells[1].text = "";
    expect(parseNotebookRunReceipt(actual, captureNotebookRunExpectation(document(), "ai")).cells[1].text).toBe("");
    delete actual.cells[1].text; actual.cells[1].status = "failure"; actual.status = "failure";
    expect(parseNotebookRunReceipt(actual, captureNotebookRunExpectation(document(), "ai")).status).toBe("failure");
    expect(notebookTextResults(actual)).toEqual({});
  });

  it("bounds previews with omission/character counts without changing the stored run", () => {
    const raw: NotebookRun = { runId: "synthetic", revision: 0, startedAt: "2026-09-17T00:00:00.000Z",
      dataSignature: "fixture", notice: "Synthetic preview policy", status: "success",
      cells: Array.from({ length: 5 }, (_, index) => ({ cellId: `note_${index}`, status: "success", durationMs: 0, text: "x".repeat(900 + index) })) };
    const before = structuredClone(raw); const preview = notebookTextResults(raw);
    expect(preview.textResultsOmitted).toBe(2); expect(preview.textResults).toHaveLength(3);
    expect(preview.textResults?.[0]).toEqual({ cellId: "note_2", text: "x".repeat(800), truncated: true, characterCount: 902 });
    expect(raw).toEqual(before);
  });
});
