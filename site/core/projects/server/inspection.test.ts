import { describe, expect, it } from "vitest";
import { createHarnessTask } from "@/core/harness/task-state";
import { STUDIO_STORAGE_VERSION } from "@/core/repository/studio-repository";
import { notebookDocumentSchema } from "@/core/notebook/contracts";
import { PROJECT_FORMAT, projectManifestSchema } from "../contracts";
import { PROJECT_INSPECTION_LIMITS, projectInspectionSchema } from "../inspection";
import { projectState } from "../test-fixture";
import { inspectProjectManifest } from "./inspection";

const textCell = { id: "known", kind: "text", title: "说明", markdown: "<script>not executed</script>" };
const unknownCell = { id: "future", kind: "pivot", title: "未来步骤", payload: { secret: "opaque-private-payload" }, code: "private unknown code" };
function fixture(books: Record<string, unknown> = {}) {
  const state = projectState();
  return { format: PROJECT_FORMAT, id: "12345678-1234-4234-8234-123456789abc", name: "Inspection fixture", createdAt: "2026-09-21T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z", stateRevision: 4,
    state: { ...state, dataProduct: { ...state.dataProduct, notebooks: books } }, tables: [], files: [] };
}
const book = (cells: unknown[]) => ({ name: "Notebook fixture", revision: 3, cells });

describe("display-only project inspection projection", () => {
  it("returns known text and opaque unknown placeholders without mutating or exposing a runnable project", () => {
    const value = fixture({ page: book([textCell, unknownCell]) }), before = structuredClone(value);
    const result = inspectProjectManifest(value);
    expect(result).toMatchObject({ mode: "read-only", unknownCellCount: 1, omittedSourceCount: 0,
      notebooks: [{ index: 1, name: "Notebook fixture", cells: [
        { index: 1, id: "known", support: "known", kind: "text", source: { language: "markdown", text: textCell.markdown, truncated: false } },
        { index: 2, id: "future", title: "未来步骤", support: "unknown", kind: "pivot" },
      ] }] });
    expect(JSON.stringify(result)).not.toMatch(/opaque-private-payload|private unknown code|validation sentinel|payload|handle|dataProduct/);
    expect(result.notebooks[0].cells[1]).not.toHaveProperty("source");
    expect(value).toEqual(before);
    expect(projectManifestSchema.safeParse(value).success).toBe(false);
    expect(notebookDocumentSchema.safeParse(value.state.dataProduct.notebooks.page).success).toBe(false);
    expect(projectManifestSchema.safeParse(result).success).toBe(false);
    expect(notebookDocumentSchema.safeParse(result.notebooks[0]).success).toBe(false);
  });
  it("accepts a normal project, empty state and existing older compatible state without writing a migration", () => {
    const value = fixture({ page: book([textCell]) });
    expect(inspectProjectManifest(value).unknownCellCount).toBe(0);
    expect(inspectProjectManifest({ ...value, state: null }).notebooks).toEqual([]);
    const old = { ...value, state: { ...value.state, version: STUDIO_STORAGE_VERSION - 1 } };
    const before = structuredClone(old);
    expect(inspectProjectManifest(old).notebooks).toHaveLength(1);
    expect(old).toEqual(before);
  });
  it("hides unrecognized kind strings that are not display-safe ASCII tags", () => {
    const result = inspectProjectManifest(fixture({ page: book([{ ...unknownCell, kind: "<private kind>" }]) }));
    expect(result.notebooks[0].cells[0]).toMatchObject({ support: "unknown", id: "future" });
    expect(result.notebooks[0].cells[0]).not.toHaveProperty("kind");
    expect(JSON.stringify(result)).not.toContain("<private kind>");
  });
  it.each([
    { ...unknownCell, id: undefined }, { ...unknownCell, title: undefined }, { ...unknownCell, id: "../invalid" },
    { ...unknownCell, title: "x".repeat(121) }, { ...unknownCell, kind: "" }, { ...unknownCell, kind: 123 },
  ])("refuses malformed unknown public identity rather than guessing", (cell) => {
    expect(() => inspectProjectManifest(fixture({ page: book([cell]) }))).toThrow();
  });
  it.each([
    { id: "broken", kind: "python", title: "Bad known", code: 123 },
    { ...textCell, extra: "invalid-known-field" },
    { id: "broken", kind: "sql", title: "Bad known", sql: "SELECT 1", inputCellIds: [], outputName: "result" },
  ])("does not allow unknown cells to hide an invalid known cell", (cell) => {
    expect(() => inspectProjectManifest(fixture({ page: book([unknownCell, cell]) }))).toThrow();
  });
  it("retains full manifest, notebook metadata and history validation", () => {
    const value = fixture({ page: book([unknownCell]) });
    for (const invalid of [
      { ...value, unrelated: true },
      { ...value, createdAt: "invalid" },
      { ...value, state: { ...value.state, harnessTasks: [{ broken: true }] } },
      fixture({ page: { ...book([unknownCell]), unknownMetadata: true } }),
    ]) expect(() => inspectProjectManifest(invalid)).toThrow();
    const task = createHarnessTask("inspection_history_key", "Synthetic", "page", "editor", { now: () => new Date("2026-09-21T00:00:00.000Z"), id: () => "fixture_event" });
    const artifact = { id: "artifact", version: 1, status: "draft", name: "History", cells: [textCell], executionOrder: ["known"], lineage: [{ cellId: "known", dependsOn: [] }], sourceDataSourceIds: [], createdAt: "2026-09-21T00:00:00.000Z" };
    const history = { ...value, state: { ...value.state, harnessTasks: [{ ...task, notebookArtifact: artifact }] } };
    expect(inspectProjectManifest(history).unknownCellCount).toBe(1);
    expect(() => inspectProjectManifest({ ...history, state: { ...history.state, harnessTasks: [{ ...task, notebookArtifact: { ...artifact, cells: [unknownCell] } }] } })).toThrow();
  });
  it("refuses future format/version and limits unknown cells to the current workspace version", () => {
    const value = fixture({ page: book([unknownCell]) });
    for (const invalid of [
      { ...value, format: "agentcanvas-local-project-v2" }, { ...value, format: "foreign" },
      { ...value, state: { ...value.state, version: STUDIO_STORAGE_VERSION + 1 } },
      { ...value, state: { ...value.state, version: STUDIO_STORAGE_VERSION - 1 } },
    ]) expect(() => inspectProjectManifest(invalid)).toThrow();
  });
  it("checks original opaque notebook bytes and structural limits before substitution", () => {
    expect(() => inspectProjectManifest(fixture({ page: book([{ ...unknownCell, payload: "x".repeat(PROJECT_INSPECTION_LIMITS.notebookBytes) }]) }))).toThrow();
    expect(() => inspectProjectManifest(fixture({ page: book(Array.from({ length: 31 }, () => unknownCell)) }))).toThrow();
    expect(() => inspectProjectManifest(fixture(Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`page_${index}`, book([unknownCell])]))))).toThrow();
  });
  it("bounds known source per cell and across the complete response, marking truncation and omission", () => {
    const cells = Array.from({ length: 12 }, (_, index) => ({ id: `sql_${index}`, kind: "warehouseSql", title: `SQL ${index}`, connectionId: "demo", outputName: `result_${index}`, sql: `SELECT ${"x".repeat(2_500)}` }));
    const result = inspectProjectManifest(fixture({ page: book(cells) }));
    expect(result.notebooks[0].cells[0].source).toMatchObject({ language: "sql", truncated: true });
    expect(result.notebooks[0].cells[0].source?.text).toHaveLength(2_000);
    expect(result.notebooks.flatMap((item) => item.cells).reduce((total, cell) => total + (cell.source?.text.length ?? 0), 0)).toBe(20_000);
    expect(result.omittedSourceCount).toBe(2);
    expect(result.notebooks[0].cells[10]).not.toHaveProperty("source");
  });
  it("refuses an oversized metadata response instead of silently omitting cells", () => {
    const cells = Array.from({ length: 30 }, (_, index) => ({ id: `c${"x".repeat(116)}${String(index).padStart(2, "0")}`, kind: "k".repeat(80), title: "合".repeat(120) }));
    const value = fixture(Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`page_${index}`, book(cells)])));
    expect(() => inspectProjectManifest(value)).toThrow(/响应大小/);
  });
  it("strictly rejects a forged display DTO with opaque content or executable fields", () => {
    const result = inspectProjectManifest(fixture({ page: book([unknownCell]) }));
    expect(projectInspectionSchema.safeParse({ ...result, handle: "forged" }).success).toBe(false);
    expect(projectInspectionSchema.safeParse({ ...result, notebooks: [{ ...result.notebooks[0], cells: [{ ...result.notebooks[0].cells[0], source: { language: "sql", text: "SELECT 1", truncated: false } }] }] }).success).toBe(false);
    expect(projectInspectionSchema.safeParse({ ...result, unknownCellCount: 0 }).success).toBe(false);
  });
});
