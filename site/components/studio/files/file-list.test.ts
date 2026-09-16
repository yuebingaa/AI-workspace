import { describe, expect, it } from "vitest";
import type { DataSourceDefinition } from "@/core/models";
import type { ProjectManifest } from "@/core/projects/contracts";
import { buildFileList, fileSize, sortFileList } from "./file-list";

const source = (id: string, name = id): DataSourceDefinition => ({ id, name, rowCount: 3, columnCount: 2, qualityScore: 100, sourceType: "csv", fields: [], updatedAt: "2026-09-15T00:00:00.000Z" });
describe("Original file list", () => {
  it("hides archived project originals, including files with no live tables", () => {
    const manifest = { files: [
      { id: "live", name: "orphan.csv", datasetIds: [], bytes: 2, savedAt: "2026-09-15T00:00:00Z" },
      { id: "archived", name: "archived.csv", datasetIds: [], bytes: 2, savedAt: "2026-09-15T00:00:00Z", deletedAt: "2026-09-15T01:00:00Z" },
    ], tables: [] } as unknown as ProjectManifest;
    const entries = buildFileList({ manifest, sources: [], files: [], workbooks: [] });
    expect(entries.map((entry) => entry.id)).toEqual(["live"]);
    expect(manifest.files).toHaveLength(2);
  });
  it("does not recreate a removed session file as a fallback row while keeping other data visible", () => {
    const sources = [source("removed"), source("restored")];
    const entries = buildFileList({ sources, files: [], workbooks: [], removedDatasetIds: ["removed"] });
    expect(entries.map((entry) => entry.id)).toEqual(["data_restored"]);
    expect(sources).toHaveLength(2);
  });
  it("only exposes files associated with the current workspace", () => {
    const file = new File(["private"], "other.csv");
    expect(buildFileList({ sources: [], files: [{ file, datasetId: "other", importedAt: "2026-09-15T00:00:00Z" }], workbooks: [] })).toEqual([]);
  });
  it("groups the same workbook object without duplicating file or table entries", () => {
    const file = new File(["workbook"], "sales.xlsx");
    const files = [{ file, datasetId: "first", importedAt: "2026-09-15T00:00:00Z" }];
    const result = buildFileList({ sources: [source("first"), source("second")], files, workbooks: [
      { id: "original_first", datasetId: "first", file, sheetNames: ["First", "Second"] },
      { id: "original_second", datasetId: "second", file, sheetNames: ["First", "Second"] },
    ] });
    expect(result).toHaveLength(1); expect(result[0].tables.map((table) => table.id)).toEqual(["first", "second"]);
    expect(result[0].file).toBe(file); expect(result[0].bytes).toBe(file.size);
  });
  it("keeps two distinct imports with identical names separate", () => {
    const files = ["first", "second"].map((datasetId) => ({ datasetId, file: new File([datasetId], "sales.csv"), importedAt: "2026-09-15T00:00:00Z" }));
    expect(buildFileList({ sources: files.map(({ datasetId }) => source(datasetId)), files, workbooks: [] })).toHaveLength(2);
  });
  it("does not invent an original file or file size after temporary references are lost", () => {
    const [entry] = buildFileList({ sources: [source("restored")], files: [], workbooks: [] });
    expect(entry.origin).toBe("data"); expect(entry.file).toBeUndefined(); expect(entry.bytes).toBeUndefined();
    expect(entry.tables).toEqual([{ id: "restored", name: "restored", rows: 3 }]);
  });
  it("uses the project file catalog, excludes trashed tables, and ignores session copies", () => {
    const manifest = { files: [{ id: "file", name: "sales.csv", datasetIds: ["live", "trashed"], bytes: 42, savedAt: "2026-09-15T00:00:00Z" }], tables: [
      { descriptor: { datasetId: "live", source: source("live") } },
      { descriptor: { datasetId: "trashed", source: source("trashed") }, deletedAt: "2026-09-15T01:00:00Z" },
    ] } as ProjectManifest;
    const result = buildFileList({ manifest, sources: [source("session")], files: [], workbooks: [] });
    expect(result).toHaveLength(1); expect(result[0].origin).toBe("project"); expect(result[0].tables.map((table) => table.id)).toEqual(["live"]);
  });
  it("filters by associated table names and sorts without mutating the input", () => {
    const entries = buildFileList({ sources: [source("a", "销售10"), source("b", "销售2")], files: [], workbooks: [] });
    const original = structuredClone(entries);
    expect(sortFileList(entries, " 销售 ", "name").map((entry) => entry.name)).toEqual(["销售2", "销售10"]);
    expect(entries).toEqual(original); expect(sortFileList(entries, "absent", "recent")).toEqual([]);
  });
  it("handles absent sizes and uses file byte sizes accurately", () => {
    expect(fileSize(undefined)).toBe(""); expect(fileSize(23)).toBe("23 B");
    expect(fileSize(1536)).toBe("1.5 KB"); expect(fileSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});
