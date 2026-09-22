import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProjectStore, ProjectError } from "./store";
import { projectState, projectUpload } from "../test-fixture";

const prefix = "agentcanvas-file-diagnostics-";
let root: string, store: LocalProjectStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), prefix));
  store = LocalProjectStore.create(join(root, "project"), "文件诊断合成项目");
});
afterEach(() => {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), prefix))) throw new Error("Unsafe fixture cleanup");
  rmSync(root, { recursive: true, force: true });
});
const manifestPath = () => join(store.root, "agentcanvas.project.json");
const manifestBytes = () => readFileSync(manifestPath());
function expectDiagnostic(operation: () => unknown, message: string, status = 409) {
  let caught: unknown;
  try { operation(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ProjectError);
  if (!(caught instanceof ProjectError)) throw new Error("Expected a bounded project diagnostic");
  expect(caught.status).toBe(status);
  expect(caught.message).toContain(message);
  expect(caught.message).not.toContain(root);
  expect(caught.message).not.toContain("private-synthetic-payload");
}

describe("local project file diagnostics and safe restore", () => {
  it.each(["missing", "changed"] as const)("does not unarchive a %s table when restore fails", async (fault) => {
    const uploaded = store.putTable(await projectUpload()), id = uploaded.dataset.datasetId;
    store.deleteTable(id);
    const entry = store.read().tables[0], path = join(store.root, "tables", entry.file);
    const original = readFileSync(path), before = manifestBytes();
    if (fault === "missing") renameSync(path, join(root, "table-backup.json"));
    else writeFileSync(path, "corrupt synthetic table");

    expect(() => store.restoreTable(id)).toThrow();
    expect(manifestBytes()).toEqual(before);
    expect(store.read().tables[0].deletedAt).toBeTruthy();
    expect(store.getTable(id)).toBeNull();
    if (fault === "missing") renameSync(join(root, "table-backup.json"), path);
    else writeFileSync(path, original);
    expect(store.restoreTable(id)).toEqual(uploaded);
    expect(store.read().tables[0].deletedAt).toBeUndefined();
    expect(store.read().tables[0].descriptor.datasetId).toBe(id);
  });

  it("locates a missing active table without dropping its definitions or references", async () => {
    const uploaded = store.putTable(await projectUpload()), id = uploaded.dataset.datasetId;
    const state = projectState(uploaded);
    state.dataProduct.notebooks = { page: { name: "保留的分析", revision: 1,
      cells: [{ id: "source", kind: "data", title: "原数据", sourceDataSourceId: id, outputName: "input" }] } };
    store.saveState(state, 0);
    const entry = store.read().tables[0], path = join(store.root, "tables", entry.file), before = manifestBytes();
    renameSync(path, join(root, "table-backup.json"));
    expectDiagnostic(() => store.getTable(id), `项目文件缺失：tables/${entry.file}`);
    expect(manifestBytes()).toEqual(before);
    expect(new LocalProjectStore(store.root).read().state?.dataProduct.notebooks).toEqual(state.dataProduct.notebooks);
    renameSync(join(root, "table-backup.json"), path);
    expect(store.getTable(id)).toEqual(uploaded);
  });

  it("a missing original does not prevent reading the separately stored data table", async () => {
    const uploaded = store.putTable(await projectUpload());
    const file = store.saveOriginal("synthetic.csv", Buffer.from("category,amount\nAlpha,10"), uploaded.dataset.datasetId);
    const before = manifestBytes();
    renameSync(join(store.root, "files", file.file), join(root, "original-backup.csv"));
    expectDiagnostic(() => store.getOriginal(file.id), `项目文件缺失：files/${file.file}`);
    expect(store.getTable(uploaded.dataset.datasetId)).toEqual(uploaded);
    expect(manifestBytes()).toEqual(before);
  });

  it.each(["missing", "changed"] as const)("keeps a %s original in trash until its bytes can be verified", async (fault) => {
    const uploaded = store.putTable(await projectUpload()), bytes = Buffer.from("category,amount\nAlpha,10");
    const file = store.saveOriginal("synthetic.csv", bytes, uploaded.dataset.datasetId);
    store.archiveOriginal(file.id);
    const path = join(store.root, "files", file.file), before = manifestBytes();
    if (fault === "missing") renameSync(path, join(root, "original-backup.csv"));
    else writeFileSync(path, "private-synthetic-payload");
    expectDiagnostic(() => store.restoreOriginal(file.id), `files/${file.file}`);
    expect(manifestBytes()).toEqual(before);
    if (fault === "missing") renameSync(join(root, "original-backup.csv"), path);
    else writeFileSync(path, bytes);
    store.restoreOriginal(file.id);
    expect(store.getOriginal(file.id).bytes).toEqual(bytes);
  });

  it.each(["table", "result"] as const)("refuses invalid %s payloads even when the recorded digest matches, before unarchiving", async (kind) => {
    const uploaded = store.putTable(await projectUpload(), kind), id = uploaded.dataset.datasetId;
    store.deleteTable(id);
    const manifest = store.read(), entry = manifest.tables[0], bytes = Buffer.from('{"private-synthetic-payload":true}');
    writeFileSync(join(store.root, "tables", entry.file), bytes);
    entry.sha256 = createHash("sha256").update(bytes).digest("hex"); entry.bytes = bytes.length;
    writeFileSync(manifestPath(), JSON.stringify(manifest));
    const before = manifestBytes();
    expectDiagnostic(() => store.restoreTable(id), `数据表格式无效：tables/${entry.file}`);
    expect(manifestBytes()).toEqual(before);
    expect(store.read().tables[0].deletedAt).toBeTruthy();
  });

  it("reports invalid JSON without echoing stored content or changing the active table", async () => {
    const uploaded = store.putTable(await projectUpload());
    const manifest = store.read(), entry = manifest.tables[0], bytes = Buffer.from("{private-synthetic-payload");
    writeFileSync(join(store.root, "tables", entry.file), bytes);
    entry.sha256 = createHash("sha256").update(bytes).digest("hex"); entry.bytes = bytes.length;
    writeFileSync(manifestPath(), JSON.stringify(manifest));
    const before = manifestBytes();
    expectDiagnostic(() => store.getTable(uploaded.dataset.datasetId), `数据表格式无效：tables/${entry.file}`);
    expect(manifestBytes()).toEqual(before);
  });

  it("locates unsafe non-file resources without following them or changing the catalog", async () => {
    const uploaded = store.putTable(await projectUpload()), entry = store.read().tables[0];
    const path = join(store.root, "tables", entry.file), before = manifestBytes();
    renameSync(path, join(root, "table-backup.json")); mkdirSync(path);
    expectDiagnostic(() => store.getTable(uploaded.dataset.datasetId), `tables/${entry.file}`, 400);
    expect(manifestBytes()).toEqual(before);
  });

  it.each(["tables", "files"] as const)("identifies a missing %s directory without creating empty replacement storage", (folder) => {
    const before = manifestBytes(), path = join(store.root, folder);
    renameSync(path, join(root, `${folder}-backup`));
    expectDiagnostic(() => store.read(), `项目数据目录不可用：${folder}/`);
    expect(existsSync(path)).toBe(false); expect(manifestBytes()).toEqual(before);
    renameSync(join(root, `${folder}-backup`), path);
    expect(store.read().stateRevision).toBe(0);
  });
});
