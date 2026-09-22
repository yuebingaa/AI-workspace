import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import { PROJECT_HEADER, projectSessionSchema } from "@/core/projects/contracts";
import { projectByHandle } from "@/core/projects/server/store";
import { projectState, projectUpload } from "@/core/projects/test-fixture";
import { INITIAL_WORKSPACE_PAGE_ID } from "@/core/workspaces";
import type { StudioPersistedState } from "@/core/repository/studio-repository";

const origin = "http://127.0.0.1:3001", prefix = "agentcanvas-semantic-delete-api-";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), prefix));
  vi.stubEnv("STUDIO_LOCAL_STATE_DIR", join(root, "state"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), prefix))) throw new Error("Unsafe fixture cleanup");
  rmSync(root, { recursive: true, force: true });
});
function request(handle?: string, body?: unknown, requestOrigin = origin) {
  return new Request(`${origin}/api/projects`, { method: body === undefined ? "GET" : "POST",
    headers: { origin: requestOrigin, ...(handle ? { [PROJECT_HEADER]: handle } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function setup() {
  const response = await POST(request(undefined, { action: "create", path: join(root, "project"), name: "Semantic deletion fixture" }));
  expect(response.status).toBe(200);
  const session = projectSessionSchema.parse(await response.json()), store = projectByHandle(session.handle);
  const uploaded = store.putTable(await projectUpload()), state = projectState(uploaded);
  state.dataProduct.semanticLayer = { selectedByWorkspace: { [INITIAL_WORKSPACE_PAGE_ID]: "model_amount" }, models: [{
    id: "model_amount", version: 1, name: "金额口径", description: "", sourceDatasetId: uploaded.dataset.datasetId,
    dimensions: [{ key: "category", label: "分类", field: "category", description: "" }],
    measures: [{ key: "total", label: "合计", field: "amount", aggregation: "sum", description: "" }],
  }] };
  state.dataProduct.notebooks = { [INITIAL_WORKSPACE_PAGE_ID]: { name: "合成分析", revision: 1, cells: [
    { id: "data_input", kind: "data", title: "原始表", sourceDataSourceId: uploaded.dataset.datasetId, outputName: "source_data" },
    { id: "semantic_query", kind: "semanticQuery", title: "分类汇总", inputCellId: "data_input", modelId: "model_amount", modelVersion: 1,
      dimensions: ["category"], measures: ["total"], limit: 10, outputName: "totals" },
  ] } };
  store.saveState(state, 0);
  const saved = store.read().state!;
  const manifestPath = join(session.path, "agentcanvas.project.json"), beforeBytes = readFileSync(manifestPath);
  return { session, store, saved, manifestPath, beforeBytes, uploaded };
}
function withoutModel(state: StudioPersistedState) {
  const candidate = structuredClone(state);
  candidate.dataProduct.semanticLayer = { models: [], selectedByWorkspace: {} };
  return candidate;
}

describe("semantic model deletion through project save", () => {
  it("rejects deleting a referenced model without changing exact manifest bytes", async () => {
    const { session, store, saved, manifestPath, beforeBytes, uploaded } = await setup();
    const candidate = withoutModel(saved), beforeCandidate = structuredClone(candidate);
    const response = await POST(request(session.handle, { action: "save", state: candidate, stateRevision: 1 }));
    expect(response.status).toBe(409);
    const body = await response.text();
    expect(body).toContain("语义模型"); expect(body).toContain("model_amount");
    expect(body).not.toContain(root.replaceAll("\\", "\\\\"));
    expect(readFileSync(manifestPath)).toEqual(beforeBytes);
    expect(store.read().stateRevision).toBe(1);
    expect(store.getTable(uploaded.dataset.datasetId)).toEqual(uploaded);
    expect(candidate).toEqual(beforeCandidate);
  });

  it("allows explicit removal of referencing cells and model together, preserving data and dashboard", async () => {
    const { session, store, saved, uploaded } = await setup();
    const candidate = withoutModel(saved);
    candidate.dataProduct.notebooks![INITIAL_WORKSPACE_PAGE_ID].cells = candidate.dataProduct.notebooks![INITIAL_WORKSPACE_PAGE_ID].cells.filter((cell) => cell.kind !== "semanticQuery");
    expect((await POST(request(session.handle, { action: "save", state: candidate, stateRevision: 1 }))).status).toBe(200);
    const reopened = projectSessionSchema.parse(await (await GET(request(session.handle))).json());
    expect(reopened.manifest.stateRevision).toBe(2);
    expect(reopened.manifest.state?.dataProduct.semanticLayer?.models).toEqual([]);
    expect(reopened.manifest.state?.dataProduct.notebooks).toEqual(candidate.dataProduct.notebooks);
    expect(reopened.manifest.state?.appSpec).toEqual(saved.appSpec);
    expect(reopened.manifest.state?.changeHistory).toEqual(saved.changeHistory);
    expect(store.getTable(uploaded.dataset.datasetId)).toEqual(uploaded);
  });

  it("does not confuse a same-ID revision update with model deletion", async () => {
    const { session, saved } = await setup();
    const candidate = structuredClone(saved);
    candidate.dataProduct.semanticLayer!.models[0].version += 1;
    expect((await POST(request(session.handle, { action: "save", state: candidate, stateRevision: 1 }))).status).toBe(200);
  });

  it("still blocks removal when the referencing cell has an older model version", async () => {
    const { session, store, saved } = await setup();
    const updated = structuredClone(saved); updated.dataProduct.semanticLayer!.models[0].version = 2;
    store.saveState(updated, 1);
    const before = store.read();
    expect((await POST(request(session.handle, { action: "save", state: withoutModel(updated), stateRevision: 2 }))).status).toBe(409);
    expect(store.read()).toEqual(before);
  });

  it("preserves compatibility for an already-missing model on unrelated saves", async () => {
    const { session, store, saved } = await setup();
    // A newly supplied legacy project can already contain a missing model; do not
    // rewrite it or treat an unrelated edit as a request to repair old definitions.
    const legacy = structuredClone(saved);
    const query = legacy.dataProduct.notebooks![INITIAL_WORKSPACE_PAGE_ID].cells.find((cell) => cell.kind === "semanticQuery")!;
    query.modelId = "legacy_missing_model";
    store.saveState(legacy, 1);
    const candidate = withoutModel(legacy); candidate.dataProduct.name = "Unrelated metadata edit";
    expect((await POST(request(session.handle, { action: "save", state: candidate, stateRevision: 2 }))).status).toBe(200);
    expect(store.read().state?.dataProduct.notebooks).toEqual(legacy.dataProduct.notebooks);
  });

  it("checks save revision before deletion and never discards concurrent state", async () => {
    const { session, saved, manifestPath, beforeBytes } = await setup();
    const response = await POST(request(session.handle, { action: "save", state: withoutModel(saved), stateRevision: 0 }));
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("另一窗口");
    expect(readFileSync(manifestPath)).toEqual(beforeBytes);
  });

  it("retains same-origin enforcement before accessing model references", async () => {
    const { session, saved, manifestPath, beforeBytes } = await setup();
    const response = await POST(request(session.handle, { action: "save", state: withoutModel(saved), stateRevision: 1 }, "https://not-local.invalid"));
    expect(response.status).toBe(403); expect(await response.text()).not.toContain("model_amount");
    expect(readFileSync(manifestPath)).toEqual(beforeBytes);
  });
});
