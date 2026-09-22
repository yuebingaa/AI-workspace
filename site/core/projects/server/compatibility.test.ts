import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { STUDIO_STORAGE_VERSION } from "@/core/repository/studio-repository";
import { LocalProjectStore, ProjectCompatibilityError } from "./store";
import { projectState, projectUpload } from "../test-fixture";
import type { ProjectManifest } from "../contracts";

let root: string, store: LocalProjectStore;
const manifestPath = () => join(store.root, "agentcanvas.project.json");
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentcanvas-compatibility-test-"));
  store = LocalProjectStore.create(join(root, "project"), "Synthetic compatibility");
});
afterEach(() => {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "agentcanvas-compatibility-test-"))) throw new Error("Unsafe fixture cleanup");
  rmSync(root, { recursive: true, force: true });
});
function persistFixture(value: unknown) {
  const bytes = JSON.stringify(value);
  writeFileSync(manifestPath(), bytes, "utf8");
  return Buffer.from(bytes);
}
function unsupported(manifest: ProjectManifest) {
  const state = manifest.state ?? projectState();
  return { ...manifest, state: { ...state, dataProduct: { ...state.dataProduct, notebooks: {
    ...state.dataProduct.notebooks, future: { name: "private fixture name", revision: 1, cells: [{ id: "future_cell", kind: "pivot", title: "private fixture title", payload: { secret: "not echoed" } }] },
  } } } };
}
describe("local project compatibility refusal", () => {
  it("reports unknown cells on both fresh and previously opened stores without writing", () => {
    store.saveState(projectState(), 0);
    const bytes = persistFixture(unsupported(store.read()));
    for (const candidate of [store, new LocalProjectStore(store.root)]) {
      expect(() => candidate.read()).toThrow(ProjectCompatibilityError);
      try { candidate.read(); } catch (error) {
        expect(error).toMatchObject({ status: 409, compatibility: { code: "project_incompatible", reason: "notebook-cells", total: 1, cells: [{ notebookIndex: 1, cellIndex: 1, kind: "pivot" }] } });
        expect(String(error)).not.toMatch(/private|secret|not echoed/);
      }
    }
    expect(readFileSync(manifestPath())).toEqual(bytes);
    expect(readdirSync(store.root).sort()).toEqual(["agentcanvas.project.json", "files", "tables"]);
  });
  it.each(["workspace-version", "project-format"] as const)("reports %s without rewriting it to current format", (reason) => {
    store.saveState(projectState(), 0);
    const manifest = store.read();
    const value = reason === "workspace-version" ? { ...manifest, state: { ...manifest.state, version: STUDIO_STORAGE_VERSION + 1 } }
      : { ...manifest, format: "agentcanvas-local-project-v2" };
    const bytes = persistFixture(value);
    expect(() => store.read()).toThrow(ProjectCompatibilityError);
    try { store.read(); } catch (error) { expect(error).toMatchObject({ status: 409, compatibility: { reason } }); }
    expect(readFileSync(manifestPath())).toEqual(bytes);
  });
  it("blocks all edit paths after an external incompatible change and retains table/original bytes", async () => {
    const table = store.putTable(await projectUpload());
    const file = store.saveOriginal("synthetic.csv", Buffer.from("category,amount\nAlpha,10"), table.dataset.datasetId);
    const state = projectState(table), revision = store.saveState(state, 0), compatible = store.read();
    const tablePath = join(store.root, "tables", compatible.tables[0].file), filePath = join(store.root, "files", file.file);
    const tableBytes = readFileSync(tablePath), fileBytes = readFileSync(filePath);
    const bytes = persistFixture(unsupported(compatible));
    const extra = await projectUpload();
    const actions = [
      () => store.saveState(state, revision),
      () => store.renameTable(table.dataset.datasetId, "should not replace"),
      () => store.archiveOriginal(file.id),
      () => store.restoreOriginal(file.id),
      () => store.deleteTable(table.dataset.datasetId),
      () => store.restoreTable(table.dataset.datasetId),
      () => store.putTable(extra),
      () => store.saveOriginal("additional.csv", Buffer.from("a\n1"), table.dataset.datasetId),
    ];
    for (const action of actions) {
      expect(action).toThrow(ProjectCompatibilityError);
      expect(readFileSync(manifestPath())).toEqual(bytes);
      expect(readFileSync(tablePath)).toEqual(tableBytes);
      expect(readFileSync(filePath)).toEqual(fileBytes);
      expect(readdirSync(join(store.root, "tables"))).toEqual([compatible.tables[0].file]);
      expect(readdirSync(join(store.root, "files"))).toEqual([file.file]);
      expect(readdirSync(store.root).sort()).toEqual(["agentcanvas.project.json", "files", "tables"]);
    }
  });
  it("clears per-load diagnostics after external restoration and allows normal revision-checked saves", () => {
    const state = projectState(); store.saveState(state, 0);
    const compatible = readFileSync(manifestPath());
    persistFixture(unsupported(store.read()));
    expect(() => store.saveState(state, 1)).toThrow(ProjectCompatibilityError);
    writeFileSync(manifestPath(), compatible);
    expect(store.read().stateRevision).toBe(1);
    state.dataProduct.name = "restored fixture";
    expect(store.saveState(state, 1)).toBe(2);
    expect(store.read().state?.dataProduct.name).toBe("restored fixture");
    expect(() => store.saveState(state, 1)).toThrow(/另一窗口/);
  });
  it("retains strict known-cell validation, malformed JSON and unrelated errors", () => {
    const manifest = store.read();
    const state = projectState();
    const invalidKnown = { ...manifest, state: { ...state, dataProduct: { ...state.dataProduct, notebooks: {
      invalid: { name: "invalid", revision: 0, cells: [{ kind: "python", code: 123 }] },
    } } } };
    for (const value of [invalidKnown, { ...manifest, format: "foreign-product-v2" }]) {
      const bytes = persistFixture(value);
      expect(() => store.read()).toThrow();
      expect(() => store.read()).not.toThrow(ProjectCompatibilityError);
      expect(readFileSync(manifestPath())).toEqual(bytes);
    }
    writeFileSync(manifestPath(), "{private-invalid-json");
    expect(() => store.read()).toThrow();
    expect(() => store.read()).not.toThrow(ProjectCompatibilityError);
  });
  it("does not retain a previous compatibility error on subsequent generic failures", () => {
    persistFixture(unsupported(store.read()));
    expect(() => store.read()).toThrow(ProjectCompatibilityError);
    writeFileSync(manifestPath(), "{invalid");
    expect(() => store.read()).toThrow();
    expect(() => store.read()).not.toThrow(ProjectCompatibilityError);
  });
});
