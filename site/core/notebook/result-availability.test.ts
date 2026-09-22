import { describe, expect, it } from "vitest";
import type { NotebookCellRun, NotebookResultReference } from "./contracts";
import { notebookResultAvailability, type NotebookRunIdentity } from "./result-availability";

const cell = { id: "recipe", kind: "transform" } as const;
const identity: NotebookRunIdentity = { runId: "synthetic_run", revision: 3, accessMode: "user" };
function result(previewRows = 1_000, totalRows = 1_324): NotebookCellRun {
  return { cellId: cell.id, status: "success", durationMs: 1,
    table: { fields: [{ name: "value", label: "合成值", type: "number" }],
      rows: Array.from({ length: previewRows }, (_, value) => ({ value })), truncated: totalRows > previewRows },
    resultRef: { ...identity, cellId: cell.id, resultId: "synthetic_result", mode: "table", inputResultIds: [],
      rowCount: totalRows, complete: true, dataSignature: "synthetic" },
  };
}

describe("Notebook preview and complete-result availability", () => {
  it("allows saving a complete 1,324-row result despite its 1,000-row preview", () => {
    const receipt = result(); const before = structuredClone(receipt);
    expect(notebookResultAvailability(cell, receipt, identity)).toEqual({
      previewRowCount: 1_000, knownRowCount: 1_324, completeness: "complete", previewOnly: true,
      canSaveDataset: true, canSnapshot: false,
    });
    expect(receipt).toEqual(before);
  });
  it.each([0, 1, 500, 501])("uses complete row count %s for empty-result and dashboard limits", (count) => {
    const availability = notebookResultAvailability(cell, result(Math.min(count, 100), count), identity);
    expect(availability.knownRowCount).toBe(count);
    expect(availability.canSaveDataset).toBe(count > 0);
    expect(availability.canSnapshot).toBe(count > 0 && count <= 500);
  });
  it("does not treat engine-truncated rows as a complete original result", () => {
    const receipt = result(); receipt.resultRef!.complete = false;
    const availability = notebookResultAvailability(cell, receipt, identity);
    expect(availability).toMatchObject({ completeness: "incomplete", previewRowCount: 1_000,
      knownRowCount: 1_324, canSaveDataset: false, canSnapshot: false });
  });
  it.each([
    { cellId: "other" }, { runId: "other_run" }, { revision: 4 }, { accessMode: "ai" },
    { rowCount: 999 }, { rowCount: -1 }, { rowCount: 1.5 }, { rowCount: Number.NaN },
  ] satisfies Array<Partial<NotebookResultReference>>)("refuses mismatched reference %j without guessing totals", (override) => {
    const receipt = result(); receipt.resultRef = { ...receipt.resultRef!, ...override };
    expect(notebookResultAvailability(cell, receipt, identity)).toMatchObject({
      completeness: "inconsistent", knownRowCount: null, canSaveDataset: false, canSnapshot: false,
    });
  });
  it("requires independently captured run identity when a result reference exists", () => {
    expect(notebookResultAvailability(cell, result())).toMatchObject({ completeness: "inconsistent", canSaveDataset: false });
  });
  it("rejects preview-length and truncation contradictions", () => {
    const missingPreviewMarker = result(); missingPreviewMarker.table!.truncated = false;
    const falseComplete = result(100, 100); falseComplete.table!.truncated = true;
    const unmarkedPartial = result(100, 100); unmarkedPartial.resultRef!.complete = false;
    for (const receipt of [missingPreviewMarker, falseComplete, unmarkedPartial]) {
      expect(notebookResultAvailability(cell, receipt, identity)).toMatchObject({
        completeness: "inconsistent", knownRowCount: null, canSaveDataset: false, canSnapshot: false,
      });
    }
  });
  it("keeps legacy non-truncated tables usable and legacy truncated totals unknown", () => {
    const legacy = result(100, 100); delete legacy.resultRef;
    expect(notebookResultAvailability(cell, legacy)).toMatchObject({ completeness: "complete", knownRowCount: 100,
      canSaveDataset: true, canSnapshot: true });
    legacy.table!.truncated = true;
    expect(notebookResultAvailability(cell, legacy)).toMatchObject({ completeness: "unknown", knownRowCount: null,
      canSaveDataset: false, canSnapshot: false });
  });
  it.each(["failure", "blocked"] as const)("does not enable saving a %s result with stale table metadata", (status) => {
    expect(notebookResultAvailability(cell, { ...result(), status }, identity)).toMatchObject({
      completeness: "unknown", knownRowCount: null, canSaveDataset: false, canSnapshot: false,
    });
  });
  it("keeps no-table results unavailable and Data-cell save buttons prohibited", () => {
    const noTable = result(); delete noTable.table;
    expect(notebookResultAvailability(cell, noTable, identity)).toMatchObject({ knownRowCount: null, canSaveDataset: false });
    expect(notebookResultAvailability({ ...cell, kind: "data" }, result(100, 100), identity))
      .toMatchObject({ completeness: "complete", canSaveDataset: false, canSnapshot: false });
    expect(notebookResultAvailability({ ...cell, id: "another" }, result(), identity))
      .toMatchObject({ completeness: "inconsistent", canSaveDataset: false });
  });
  it.each([30, 31, 100])("keeps %s-column Dataset saving separate from the dashboard table limit", (count) => {
    const receipt = result(1, 1);
    receipt.table!.fields = Array.from({ length: count }, (_, index) => ({ name: `value_${index}`, label: `值 ${index}`, type: "number" }));
    receipt.table!.rows = [Object.fromEntries(receipt.table!.fields.map((field, index) => [field.name, index]))];
    expect(notebookResultAvailability(cell, receipt, identity)).toMatchObject({
      canSaveDataset: true, canSnapshot: count <= 30,
    });
    expect(notebookResultAvailability({ ...cell, kind: "chart" }, receipt, identity)).toMatchObject({
      canSaveDataset: true, canSnapshot: true,
    });
  });
});
