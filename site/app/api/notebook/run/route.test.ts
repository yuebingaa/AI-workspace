import { beforeEach, describe, expect, it, vi } from "vitest";
import { datasetUploadResponseSchema, type DatasetUploadResponse } from "@/core/datasets/contracts";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { applyChangeSet, createExecutionState, previewChangeSet } from "@/core/changesets";
import { executeChartBinding } from "@/core/data/query-runtime";
import { notebookDashboardPreview } from "@/core/notebook/dashboard";
import type { NotebookDocument } from "@/core/notebook/contracts";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/core/datasets/server/dataset-repository", () => ({ datasetRepository: mocks }));
function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3001/api/notebook/run", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
async function source() {
  const uploaded = await parseCsvUpload({ stream: new Response("region,amount\nEast,150\nSouth,80").body!, originalFileName: "synthetic.csv", mimeType: "text/csv" });
  mocks.get.mockImplementation(async (_identity, id) => id === uploaded.dataset.datasetId ? { descriptor: uploaded.dataset, rows: uploaded.rows } : null);
  return uploaded;
}
function document(id: string, sql: string): NotebookDocument {
  return { name: "API test", revision: 0, cells: [
    { id: "source", title: "输入", kind: "data", outputName: "input", sourceDataSourceId: id },
    { id: "sql", title: "SQL", kind: "sql", inputCellIds: ["source"], outputName: "result", sql },
  ] };
}
describe("local Notebook API", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.put.mockImplementation(async (_identity, payload) => datasetUploadResponseSchema.parse(payload)); });
  it("rejects cross-origin, non-JSON, forged identity and client-supplied rows", async () => {
    expect((await POST(request({}, { origin: "https://untrusted.example" }))).status).toBe(403);
    expect((await POST(request({}, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await POST(request({ pageId: "test", document: { name: "empty", revision: 0, cells: [] }, userId: "admin", rows: [{ secret: 1 }] }))).status).toBe(400);
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.put).not.toHaveBeenCalled();
  });
  it("rejects expired or unknown sources without executing", async () => {
    mocks.get.mockResolvedValue(null);
    const response = await POST(request({ pageId: "test", document: document("dataset_upload_missing1234567890", "SELECT * FROM input") }));
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("过期") } });
  });
  it("preserves typed snapshot strings, booleans and null despite CSV inference", async () => {
    const uploaded = await source();
    const doc = document(uploaded.dataset.datasetId, "SELECT '001' AS code, NULL::VARCHAR AS missing, '' AS blank, true AS flag, 123.4500000001::DECIMAL(20,10) AS exact FROM input LIMIT 1");
    const response = await POST(request({ pageId: "test", document: doc, action: "snapshot", targetCellId: "sql" }));
    expect(response.status).toBe(200);
    const payload = await response.json() as { snapshot: DatasetUploadResponse };
    expect(payload.snapshot.rows).toEqual([{ code: "001", missing: null, blank: "", flag: true, exact: "123.4500000001" }]);
    expect(payload.snapshot.dataset.source.quality?.nullCellCount).toBe(1);
    expect(mocks.put).toHaveBeenCalledTimes(1);
  }, 15_000);
  it("creates a real chart snapshot and requires ChangeSet confirmation", async () => {
    const uploaded = await source();
    const doc = document(uploaded.dataset.datasetId, "SELECT region, amount AS revenue FROM input");
    const chart = { id: "chart", title: "真实结果", kind: "chart" as const, inputCellId: "sql", chartType: "bar" as const, categoryField: "region", valueFields: ["revenue"] };
    doc.cells.push(chart);
    const response = await POST(request({ pageId: "page_home", document: doc, action: "snapshot", targetCellId: "chart" }));
    expect(response.status).toBe(200);
    const payload = await response.json() as { snapshot: DatasetUploadResponse };
    const { product } = semanticFixture(); const app = structuredClone(product.appSpec);
    app.dataSources.push(payload.snapshot.dataset.source);
    const changeSet = notebookDashboardPreview(app.pages[0], chart, payload.snapshot, "test_snapshot");
    const state = createExecutionState(app);
    const preview = previewChangeSet(state, changeSet, "editor");
    expect(preview.present.pages).toEqual(app.pages); expect(preview.preview).not.toBeNull();
    const applied = applyChangeSet(state, changeSet, "editor");
    expect(applied.present.pages).not.toEqual(app.pages);
    const op = changeSet.operations[0];
    if (op.type !== "addNode" || op.node.type !== "BarChart") throw new Error("Expected chart operation");
    const result = executeChartBinding(op.node.props.binding, app.dataSources, { rowsByDataSourceId: { [payload.snapshot.dataset.datasetId]: payload.snapshot.rows } });
    expect(result.values).toEqual([150, 80]);
    expect(op.node.props.binding.aggregation).toBe("none");
  }, 15_000);
  it("does not store oversized or truncated snapshots", async () => {
    const uploaded = await source();
    const response = await POST(request({ pageId: "test", document: document(uploaded.dataset.datasetId, "SELECT i FROM range(2000) t(i)"), action: "snapshot", targetCellId: "sql" }));
    expect(response.status).toBe(400); expect(mocks.put).not.toHaveBeenCalled();
  }, 15_000);
  it("saves a complete Dataset independently of dashboard limits and records its run provenance", async () => {
    const uploaded = await source();
    const doc = document(uploaded.dataset.datasetId, "SELECT i AS value FROM range(700) t(i)");
    const response = await POST(request({ pageId: "test", document: doc, action: "dataset", targetCellId: "sql" }));
    expect(response.status).toBe(200);
    const payload = await response.json() as { run: { runId: string }; snapshot: DatasetUploadResponse };
    expect(payload.snapshot.rows).toHaveLength(700);
    expect(payload.snapshot.dataset.provenance).toMatchObject({ kind: "notebook", runId: payload.run.runId, cellId: "sql", revision: 0, connectionIds: [] });
    expect(mocks.put).toHaveBeenCalledTimes(1);
  }, 15_000);
});
