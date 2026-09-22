import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { JsonFileSnapshotAdapter } from "@/core/persistence/server/json-file-snapshot";
import { STUDIO_STORAGE_VERSION } from "@/core/repository/studio-repository";
import { projectState, projectUpload } from "../test-fixture";
import { LocalProjectStore, ProjectCompatibilityError } from "./store";

let root: string, store: LocalProjectStore;
const path = () => join(store.root, "agentcanvas.project.json");
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentcanvas-inspection-store-"));
  store = LocalProjectStore.create(join(root, "project"), "Inspection fixture");
});
afterEach(() => {
  vi.restoreAllMocks();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "agentcanvas-inspection-store-"))) throw new Error("Unsafe fixture cleanup");
  rmSync(root, { recursive: true, force: true });
});
function unknownManifest() {
  const manifest = store.read(), state = manifest.state ?? projectState();
  return { ...manifest, state: { ...state, dataProduct: { ...state.dataProduct, notebooks: {
    page: { name: "Fixture book", revision: 1, cells: [{ id: "future", kind: "pivot", title: "Preserved future", payload: "opaque private data" }] },
  } } } };
}
describe("standalone readonly project store inspection", () => {
  it("reads unknown placeholders without writes, changing files, or relaxing normal read/save", async () => {
    const upload = store.putTable(await projectUpload()), file = store.saveOriginal("fixture.csv", Buffer.from("category,amount\nAlpha,10"), upload.dataset.datasetId);
    const state = projectState(upload); store.saveState(state, 0);
    const manifest = unknownManifest(); writeFileSync(path(), JSON.stringify(manifest));
    const tablePath = join(store.root, "tables", manifest.tables[0].file), originalPath = join(store.root, "files", file.file);
    const before = [readFileSync(path()), readFileSync(tablePath), readFileSync(originalPath)];
    const save = vi.spyOn(JsonFileSnapshotAdapter.prototype, "save");
    expect(store.inspect()).toMatchObject({ mode: "read-only", unknownCellCount: 1 });
    expect(save).not.toHaveBeenCalled();
    expect(() => store.read()).toThrow(ProjectCompatibilityError);
    expect(() => store.saveState(state, 1)).toThrow(ProjectCompatibilityError);
    expect([readFileSync(path()), readFileSync(tablePath), readFileSync(originalPath)]).toEqual(before);
    expect(readdirSync(store.root).sort()).toEqual(["agentcanvas.project.json", "files", "tables"]);
  });
  it("keeps failure local to each read and recognizes restored contents", () => {
    const original = readFileSync(path()), value = unknownManifest();
    writeFileSync(path(), JSON.stringify(value)); expect(store.inspect().unknownCellCount).toBe(1);
    writeFileSync(path(), "{private broken json"); expect(() => store.inspect()).toThrow();
    writeFileSync(path(), original); expect(store.inspect().notebooks).toEqual([]); expect(store.read().state).toBeNull();
  });
  it("retains future-version diagnostic errors and rejects malformed current contents without payload disclosure", () => {
    const value = unknownManifest();
    writeFileSync(path(), JSON.stringify({ ...value, state: { ...value.state, version: STUDIO_STORAGE_VERSION + 1 } }));
    expect(() => store.inspect()).toThrow(ProjectCompatibilityError);
    writeFileSync(path(), JSON.stringify({ ...value, state: { ...value.state, dataProduct: { ...value.state.dataProduct, notebooks: {
      page: { name: "Invalid", revision: 1, cells: [{ id: "known", kind: "python", title: "private", code: 123 }] },
    } } } }));
    expect(() => store.inspect()).toThrow(/无法安全预览/);
    expect(() => store.inspect()).not.toThrow(/private|123/);
  });
  it("retains project-folder identity and rejects missing directories or a non-file manifest", () => {
    const original = readFileSync(path());
    renameSync(join(store.root, "files"), join(store.root, "files-preserved"));
    expect(() => store.inspect()).toThrow(/目录不可用/);
    renameSync(join(store.root, "files-preserved"), join(store.root, "files"));
    renameSync(path(), join(store.root, "preserved-manifest.json")); mkdirSync(path());
    expect(() => store.inspect()).toThrow(/普通文件/);
    expect(readFileSync(join(store.root, "preserved-manifest.json"))).toEqual(original);
    renameSync(store.root, join(root, "preserved-project")); mkdirSync(store.root);
    expect(() => store.inspect()).toThrow(/已被替换/);
  });
});
