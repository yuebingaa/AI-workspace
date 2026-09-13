import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { LocalProjectStore, checkedProjectPath } from "./store";
import { projectState, projectUpload } from "../test-fixture";
import { datasetUploadResponseSchema } from "@/core/datasets/contracts";
import { MemoryDatasetRepository } from "@/core/datasets/server/dataset-repository";
import { INITIAL_WORKSPACE_PAGE_ID, datasetsForWorkspace } from "@/core/workspaces";
import { synchronizeUploadedDatasetProduct } from "@/core/datasets/workspace-state";
import { loadStudioStateSafely } from "@/core/repository/studio-repository";
import { createExecutionState } from "@/core/changesets";
import type { AppNode } from "@/core/models";
import { projectDatasetReferences } from "../references";

let testRoot: string;
let store: LocalProjectStore;
const owner = { tenantId: "test-local", ownerId: "local" };
beforeEach(() => { testRoot = mkdtempSync(join(tmpdir(), "agentcanvas-project-test-")); store = LocalProjectStore.create(join(testRoot, "project"), "合成数据项目"); });
afterEach(() => {
  if (dirname(resolve(testRoot)) !== resolve(tmpdir()) || !testRoot.startsWith(join(tmpdir(), "agentcanvas-project-test-"))) throw new Error("Unsafe fixture cleanup");
  rmSync(testRoot, { recursive: true, force: true });
});

describe("local project persistence", () => {
  it("creates an empty project and refuses to overwrite a nonempty folder", () => {
    expect(store.read()).toMatchObject({ state: null, tables: [], files: [], stateRevision: 0 });
    expect(() => LocalProjectStore.create(store.root, "覆盖")).toThrow(/空文件夹/);
    expect(store.read().name).toBe("合成数据项目");
  });
  it("persists rows without TTL and can reopen using a new store instance", async () => {
    const saved = store.putTable(await projectUpload());
    expect(saved.dataset).toMatchObject({ storageMode: "project", source: { ephemeral: false } });
    expect(saved.dataset.expiresAt).toBeUndefined(); expect(saved.dataset.retentionMinutes).toBeUndefined();
    expect(new LocalProjectStore(store.root).getTable(saved.dataset.datasetId)).toEqual(saved);
    expect(datasetUploadResponseSchema.safeParse(saved).success).toBe(true);
    await expect(new MemoryDatasetRepository().put(owner, saved)).rejects.toThrow();
  });
  it("preserves IDs, original bytes, Notebook and models when the folder is copied", async () => {
    const saved = store.putTable(await projectUpload()); const id = saved.dataset.datasetId;
    const original = Buffer.from("category,amount\nAlpha,10");
    const file = store.saveOriginal("原始.csv", original, id);
    const state = projectState(saved);
    state.dataProduct.notebooks = { [INITIAL_WORKSPACE_PAGE_ID]: { name: "验证 Notebook", revision: 1, cells: [{ id: "data_input", kind: "data", title: "原始表", sourceDataSourceId: id, outputName: "input" }] } };
    state.dataProduct.semanticLayer = { selectedByWorkspace: {}, models: [{ id: "model_amount", version: 1, name: "金额口径", description: "合成数据", sourceDatasetId: id,
      dimensions: [{ key: "category", label: "分类", field: "category", description: "" }],
      measures: [{ key: "total_amount", label: "合计", field: "amount", aggregation: "sum", description: "" }] }] };
    expect(store.saveState(state, 0)).toBe(1);
    const copyRoot = join(testRoot, "copied"); cpSync(store.root, copyRoot, { recursive: true });
    const copy = new LocalProjectStore(copyRoot);
    expect(copy.getTable(id)).toEqual(saved); expect(copy.getOriginal(file.id).bytes).toEqual(original);
    expect(copy.read().state?.dataProduct.notebooks).toEqual(state.dataProduct.notebooks);
    expect(copy.read().state?.dataProduct.semanticLayer).toEqual(state.dataProduct.semanticLayer);
    const manifestText = readFileSync(join(copyRoot, "agentcanvas.project.json"), "utf8");
    expect(manifestText).not.toContain(testRoot.replaceAll("\\", "\\\\"));
    expect(manifestText).not.toContain("apiKey");
  });
  it("deduplicates original bytes and tracks all associated worksheets", async () => {
    const a = store.putTable(await projectUpload()), b = store.putTable(await projectUpload());
    const bytes = Buffer.from("PKsynthetic-not-an-executed-workbook");
    const first = store.saveOriginal("合成.xlsx", bytes, a.dataset.datasetId);
    const second = store.saveOriginal("合成.xlsx", bytes, b.dataset.datasetId);
    expect(second.id).toBe(first.id); expect(store.read().files).toHaveLength(1);
    expect(second.datasetIds).toEqual([a.dataset.datasetId, b.dataset.datasetId]);
    expect(() => store.saveOriginal("../secret.csv", bytes, a.dataset.datasetId)).toThrow();
  });
  it("rejects stale workspace saves, without replacing the latest definitions", () => {
    const first = projectState(); first.dataProduct.name = "已保存版本";
    expect(store.saveState(first, 0)).toBe(1);
    const stale = projectState(); stale.dataProduct.name = "陈旧窗口";
    expect(() => new LocalProjectStore(store.root).saveState(stale, 0)).toThrow(/另一窗口/);
    expect(store.read().state?.dataProduct.name).toBe("已保存版本");
  });
  it("rejects references to data outside the project", async () => {
    const upload = await projectUpload();
    expect(() => store.saveState(projectState(upload), 0)).toThrow(/不存在/);
    const state = projectState();
    state.dataProduct.notebooks = { [INITIAL_WORKSPACE_PAGE_ID]: { name: "未知来源", revision: 1, cells: [{ id: "data_input", kind: "data", title: "缺失", sourceDataSourceId: upload.dataset.datasetId, outputName: "input" }] } };
    expect(() => store.saveState(state, 0)).toThrow(/不在当前项目/);
  });
  it("keeps the same data ID when renaming and shares tables across workspaces", async () => {
    const saved = store.putTable(await projectUpload()); store.renameTable(saved.dataset.datasetId, "新的名称");
    const renamed = store.getTable(saved.dataset.datasetId)!;
    expect(renamed.dataset.source.name).toBe("新的名称"); expect(renamed.rows).toEqual(saved.rows);
    expect(datasetsForWorkspace(projectState(renamed).dataProduct.datasets, "another_page")).toHaveLength(1);
  });
  it("archives and restores data without deleting the original or leaving invalid saved references", async () => {
    const saved = store.putTable(await projectUpload()); const id = saved.dataset.datasetId;
    const file = store.saveOriginal("synthetic.csv", Buffer.from("a\n1"), id);
    store.saveState(projectState(saved), 0);
    expect(store.deleteTable(id)).toBe(true); expect(store.getTable(id)).toBeNull();
    const manifest = store.read();
    expect(manifest.state?.appSpec.dataSources).toHaveLength(0); expect(manifest.tables[0].deletedAt).toBeTruthy();
    expect(existsSync(join(store.root, "tables", manifest.tables[0].file))).toBe(true);
    expect(store.getOriginal(file.id).bytes.toString()).toBe("a\n1");
    expect(loadStudioStateSafely({ load: () => manifest.state, save: () => {}, clear: () => {} }, manifest.state!.dataProduct).restored).toBe(true);
    expect(store.restoreTable(id)).toEqual(saved);
  });
  it("blocks deletion while a Notebook references the table", async () => {
    const saved = store.putTable(await projectUpload()), state = projectState(saved);
    state.dataProduct.notebooks = { [INITIAL_WORKSPACE_PAGE_ID]: { name: "依赖", revision: 1, cells: [{ id: "source", kind: "data", title: "数据", sourceDataSourceId: saved.dataset.datasetId, outputName: "input" }] } };
    store.saveState(state, 0);
    expect(() => store.deleteTable(saved.dataset.datasetId)).toThrow(/Notebook/);
    expect(store.getTable(saved.dataset.datasetId)).not.toBeNull();
  });
  it("preserves custom recipes when rehydrating or renaming a dataset", async () => {
    const saved = store.putTable(await projectUpload()), state = projectState(saved);
    const recipe = { ...structuredClone(saved.dataset.recipe), id: "recipe_custom", name: "我的配方" };
    state.dataProduct.recipes.push(recipe);
    state.dataProduct.recipes[0].steps = [{ id: "step_user_limit", type: "limit", count: 1 }];
    store.saveState(state, 0);
    const reopened = new LocalProjectStore(store.root).read().state!;
    const hydrated = synchronizeUploadedDatasetProduct(reopened.dataProduct, saved.dataset);
    expect(hydrated.recipes).toContainEqual(recipe);
    expect(hydrated.recipes[0].steps).toEqual([{ id: "step_user_limit", type: "limit", count: 1 }]);
  });
  it.each(["dashboard", "history", "recipe"] as const)("blocks deletion of a %s dependency", async (kind) => {
    const saved = store.putTable(await projectUpload()), state = projectState(saved), id = saved.dataset.datasetId;
    const metric: AppNode = { id: "metric_amount", type: "MetricCard", props: { label: "合计", trend: "", binding: { dataSourceId: id, field: "amount", aggregation: "sum", groupBy: null, filters: [], sort: [], limit: 1, format: { style: "number" } } } };
    if (kind === "dashboard") state.appSpec.pages[0].root.children = [metric];
    if (kind === "history") {
      const previous = structuredClone(state.appSpec); previous.pages[0].root.children = [metric];
      state.changeHistory = [{ appSpec: previous, changeSetId: "change_test", requiredRole: "editor" }]; state.appliedChangeSetIds = ["change_test"];
    }
    if (kind === "recipe") state.dataProduct.recipes.push({ ...structuredClone(saved.dataset.recipe), id: "recipe_custom", name: "自定义选择配方" });
    store.saveState(state, 0);
    expect(() => store.deleteTable(id)).toThrow(/仍被引用/);
  });
  it("protects unconfirmed preview references and still rejects bindings in an empty project", async () => {
    const saved = store.putTable(await projectUpload()), state = projectState(saved);
    const preview = structuredClone(state.appSpec);
    preview.pages[0].root.children = [{ id: "preview_metric", type: "MetricCard", props: { label: "预览", trend: "", binding: { dataSourceId: saved.dataset.datasetId, field: "amount", aggregation: "sum", groupBy: null, filters: [], sort: [], limit: 1, format: { style: "number" } } } }];
    expect(projectDatasetReferences(state, saved.dataset.datasetId, saved.dataset.recipe, preview)[0]).toMatch(/待确认预览/);
    preview.dataSources = []; expect(() => createExecutionState(preview)).toThrow();
  });
  it("enforces sensitive-data policy and ownership on the same project repository", async () => {
    const saved = store.putTable(await projectUpload("email,amount\nsynthetic@example.invalid,10")); const id = saved.dataset.datasetId;
    const repository = store.datasets(owner);
    expect(saved.dataset.aiAccessPolicy).toBe("pending");
    expect(() => repository.assertAiAccessPolicies(owner, [{ datasetId: id, policy: "pending" }])).toThrow();
    await repository.setAiAccessPolicy(owner, id, "masked");
    expect(() => repository.assertAiAccessPolicies(owner, [{ datasetId: id, policy: "masked" }])).not.toThrow();
    await expect(repository.setAiAccessPolicy(owner, id, "exclude-sensitive-samples")).rejects.toThrow();
    await expect(repository.get({ ...owner, ownerId: "someone-else" }, id)).rejects.toThrow(/所有者/);
    store.deleteTable(id);
    expect(() => repository.assertAiAccessPolicies(owner, [{ datasetId: id, policy: "masked" }])).toThrow();
  });
  it("detects externally changed files and manifests and never accepts path traversal", async () => {
    const saved = store.putTable(await projectUpload()); const entry = store.read().tables[0];
    writeFileSync(join(store.root, "tables", entry.file), "{}");
    expect(() => store.getTable(saved.dataset.datasetId)).toThrow(/外部修改/);
    const manifest = store.read(); manifest.tables[0].file = "../outside.json";
    writeFileSync(join(store.root, "agentcanvas.project.json"), JSON.stringify(manifest));
    expect(() => store.read()).toThrow();
  });
  it("rejects roots, relative paths and linked/replaced project directories", () => {
    expect(() => checkedProjectPath("relative/folder")).toThrow(); expect(() => checkedProjectPath(homedir())).toThrow();
    expect(() => checkedProjectPath("\\\\server\\share")).toThrow();
    const linked = join(testRoot, "linked"); symlinkSync(store.root, linked, process.platform === "win32" ? "junction" : "dir");
    expect(() => checkedProjectPath(linked)).toThrow(/链接|联接/);
    const replaced = join(testRoot, "original"); renameSync(store.root, replaced); mkdirSync(store.root);
    expect(() => store.read()).toThrow(/替换/);
  });
});
