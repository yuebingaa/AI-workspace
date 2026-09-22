import { describe, expect, it } from "vitest";
import type { NotebookDocument } from "@/core/notebook/contracts";
import { composerNotebookContext, reconcileNotebookContextSelection, toggleNotebookContextSelection, type NotebookContextSelectionState } from "./notebook-context-selection";

const document: NotebookDocument = { name: "Synthetic notebook", revision: 1, cells: Array.from({ length: 12 }, (_, index) => ({
  id: `parameter_${index}`, kind: "parameter", title: `Parameter ${index}`, outputName: `parameter_${index}`,
  parameter: { type: "text", value: `synthetic value ${index}` },
})) };
const state = (ids: string[] = ["parameter_0"]): NotebookContextSelectionState => ({ scopeKey: "project:page:conversation", ids });

describe("window-local Notebook context selection", () => {
  it("retains a valid selection without copying metadata or mutating the document", () => {
    const current = state(), previous = structuredClone(document);
    expect(reconcileNotebookContextSelection(current, current.scopeKey, document)).toBe(current);
    expect(Object.keys(current)).toEqual(["scopeKey", "ids"]);
    expect(document).toEqual(previous);
  });
  it.each(["other-project:page:conversation", "project:other-page:conversation", "project:page:other-conversation", "project:page:rotated-context"])("clears focus on scope transition to %s", (scopeKey) => {
    const reset = reconcileNotebookContextSelection(state(), scopeKey, document);
    expect(reset).toEqual({ scopeKey, ids: [] });
    expect(reconcileNotebookContextSelection(reset, state().scopeKey, document).ids).toEqual([]);
  });
  it("removes deleted IDs permanently so reintroducing the old ID does not resurrect selection", () => {
    const current = state(["parameter_0", "parameter_1"]);
    const removed = { ...document, cells: document.cells.filter((cell) => cell.id !== "parameter_0") };
    const cleaned = reconcileNotebookContextSelection(current, current.scopeKey, removed);
    expect(cleaned.ids).toEqual(["parameter_1"]);
    expect(reconcileNotebookContextSelection(cleaned, current.scopeKey, document).ids).toEqual(["parameter_1"]);
  });
  it("keeps IDs through title, output-name, value and display-order changes", () => {
    const current = state(["parameter_2", "parameter_0"]);
    const next: NotebookDocument = { ...document, revision: 2, cells: [...document.cells].reverse().map((cell) => cell.kind === "parameter" && cell.parameter.type === "text"
      ? { ...cell, title: "Renamed", outputName: `renamed_${cell.id}`, parameter: { ...cell.parameter, value: "changed" } }
      : cell) };
    expect(reconcileNotebookContextSelection(current, current.scopeKey, next)).toBe(current);
  });
  it("filters invalid/duplicate IDs and caps the normalized window state", () => {
    const current = state(["missing", "parameter_0", "parameter_0", ...document.cells.map((cell) => cell.id)]);
    const cleaned = reconcileNotebookContextSelection(current, current.scopeKey, document);
    expect(cleaned.ids).toEqual(document.cells.slice(0, 10).map((cell) => cell.id));
  });
  it("adds and removes focus by ID without changing saved definitions", () => {
    const current = state();
    const added = toggleNotebookContextSelection(current, current.scopeKey, document, "parameter_1");
    expect(added.ids).toEqual(["parameter_0", "parameter_1"]);
    expect(toggleNotebookContextSelection(added, added.scopeKey, document, "parameter_0").ids).toEqual(["parameter_1"]);
    expect(current.ids).toEqual(["parameter_0"]);
  });
  it("does not add an eleventh selection, but permits removing an already selected item", () => {
    const current = state(document.cells.slice(0, 10).map((cell) => cell.id));
    expect(toggleNotebookContextSelection(current, current.scopeKey, document, "parameter_10")).toBe(current);
    expect(toggleNotebookContextSelection(current, current.scopeKey, document, "parameter_0").ids).toHaveLength(9);
  });
  it("ignores unknown IDs and retained callbacks from an old scope", () => {
    const current = state();
    expect(toggleNotebookContextSelection(current, current.scopeKey, document, "missing")).toBe(current);
    expect(toggleNotebookContextSelection(current, "previous-scope", document, "parameter_1")).toBe(current);
  });
  it("does not restore selection from a renamed duplicate title", () => {
    const duplicate = { ...document, cells: document.cells.map((cell) => ({ ...cell, title: "Same title" })) };
    const current = state(["parameter_1"]);
    expect(reconcileNotebookContextSelection(current, current.scopeKey, duplicate).ids).toEqual(["parameter_1"]);
  });
});

describe("composer Notebook request context", () => {
  it("keeps canvas opt-in when no focus was selected", () => {
    expect(composerNotebookContext(document, ["source"], [], "canvas")).toBeUndefined();
  });
  it.each(["agent", "notebook"] as const)("%s receives the current document without requiring hidden manual cell selection", mode => {
    expect(composerNotebookContext(document, ["source"], [], mode)).toEqual({ document, sourceIds: ["source"] });
  });
  it("includes explicit IDs in AI/canvas mode without copying results or widening source scope", () => {
    const sourceIds = ["authorized_source"];
    const context = composerNotebookContext(document, sourceIds, ["parameter_1"], "canvas");
    expect(context).toEqual({ document, sourceIds, selectedCellIds: ["parameter_1"] });
    expect(context?.document).toBe(document);
    expect(context?.sourceIds).toBe(sourceIds);
    expect(Object.keys(context!)).toEqual(["document", "sourceIds", "selectedCellIds"]);
  });
  it("does not transmit a deleted focus or enable Notebook mode solely from stale IDs", () => {
    expect(composerNotebookContext(document, [], ["deleted"], "canvas")).toBeUndefined();
    expect(composerNotebookContext(document, [], ["deleted", "parameter_0", "parameter_0"], "canvas")?.selectedCellIds).toEqual(["parameter_0"]);
  });
});
