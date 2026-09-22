import { describe, expect, it, vi } from "vitest";
import { notebookDatasetProvenanceSchema } from "@/core/datasets/provenance";
import type { NotebookDocument } from "./contracts";
import { notebookDatasetProvenance } from "./provenance";
import { executeNotebook } from "./server/execution";

function fixture(): NotebookDocument {
  return { name: "Parameter provenance", revision: 3, cells: [
    { id: "selected", kind: "parameter", title: "Selection", outputName: "selected", parameter: { type: "select", value: "East", options: ["East", "South"] } },
    { id: "show", kind: "table", title: "Selected value", inputCellId: "selected", columns: ["value"] },
    { id: "unrelated", kind: "parameter", title: "Unrelated", outputName: "unrelated", parameter: { type: "text", value: "unrelated literal must not leak" } },
  ] };
}

describe("Dataset provenance for parameter-dependent results", () => {
  it("serializes the exact parameter definition and only the selected successful dependency closure", async () => {
    const document = fixture();
    const run = await executeNotebook({ document, sources: [], targetCellId: "show" }, { query: vi.fn(), log: vi.fn() });
    const provenance = notebookDatasetProvenance(document, run, "show");
    expect(provenance.connectionIds).toEqual([]);
    expect(provenance.lineage).toMatchObject({ rowCount: 1, complete: true, sourceDatasetIds: [], accessMode: "user" });
    expect(provenance.lineage?.steps.map((step) => [step.kind, step.cellId, step.inputCellIds]))
      .toEqual([["parameter", "selected", []], ["table", "show", ["selected"]]]);
    expect(JSON.parse(provenance.lineage!.steps[0].definition)).toEqual(document.cells[0]);
    expect(notebookDatasetProvenanceSchema.parse(JSON.parse(JSON.stringify(provenance)))).toEqual(provenance);
    expect(JSON.stringify(provenance)).not.toContain("unrelated literal");
    expect(JSON.stringify(provenance)).not.toContain('"rows":');
    const originalDefinition = provenance.lineage!.steps[0].definition;
    Object.assign(document.cells[0], { parameter: { type: "select", value: "South", options: ["East", "South"] } });
    document.revision++;
    expect(provenance.lineage!.steps[0].definition).toBe(originalDefinition);
    expect(() => notebookDatasetProvenance(document, run, "show")).toThrow("版本已变化");
  });

  it("preserves old provenance without lineage and refuses unknown new kinds", async () => {
    const old = { kind: "notebook", runId: "old", resultId: "old-result", cellId: "old-cell", revision: 0, connectionIds: [] };
    expect(notebookDatasetProvenanceSchema.parse(old)).toEqual(old);
    const document = fixture();
    const run = await executeNotebook({ document, sources: [], targetCellId: "show" }, { query: vi.fn(), log: vi.fn() });
    const provenance = notebookDatasetProvenance(document, run, "show");
    Object.assign(provenance.lineage!.steps[0], { kind: "remoteParameterTemplate" });
    expect(notebookDatasetProvenanceSchema.safeParse(provenance).success).toBe(false);
  });

  it("does not save failed parameter chains as successful lineage", async () => {
    const document = fixture();
    const run = await executeNotebook({ document, sources: [], targetCellId: "show", signal: AbortSignal.abort() }, { query: vi.fn(), log: vi.fn() });
    expect(run.status).toBe("failure");
    expect(() => notebookDatasetProvenance(document, run, "show")).toThrow("不完整");
  });
});
