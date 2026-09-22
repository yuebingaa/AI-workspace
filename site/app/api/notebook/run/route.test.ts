import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { datasetUploadResponseSchema, type DatasetUploadResponse } from "@/core/datasets/contracts";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { applyChangeSet, createExecutionState, previewChangeSet } from "@/core/changesets";
import { executeChartBinding } from "@/core/data/query-runtime";
import { notebookDashboardPreview } from "@/core/notebook/dashboard";
import type { NotebookDocument, NotebookRun } from "@/core/notebook/contracts";
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
async function wideResultDocument(columnCount: number): Promise<NotebookDocument> {
  const fields = Array.from({ length: columnCount }, (_, index) => `field_${index}`);
  const uploaded = await parseCsvUpload({ stream: new Response(`${fields.join(",")}\n${fields.map((_, index) => index).join(",")}`).body!, originalFileName: "synthetic-wide.csv", mimeType: "text/csv" });
  mocks.get.mockImplementation(async (_identity, id) => id === uploaded.dataset.datasetId ? { descriptor: uploaded.dataset, rows: uploaded.rows } : null);
  return { name: "宽表结果", revision: 0, cells: [
    { id: "source", title: "输入", kind: "data", outputName: "input", sourceDataSourceId: uploaded.dataset.datasetId },
    { id: "transform", title: "保留完整字段", kind: "transform", inputCellId: "source", outputName: "result", steps: [{ id: "keep", type: "selectFields", fields }] },
  ] };
}
function document(id: string, sql: string): NotebookDocument {
  return { name: "API test", revision: 0, cells: [
    { id: "source", title: "输入", kind: "data", outputName: "input", sourceDataSourceId: id },
    { id: "sql", title: "SQL", kind: "sql", inputCellIds: ["source"], outputName: "result", sql },
  ] };
}
describe("local Notebook API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NOTEBOOK_PYTHON_ENABLED", "true");
    mocks.put.mockImplementation(async (_identity, payload) => datasetUploadResponseSchema.parse(payload));
  });
  afterEach(() => vi.unstubAllEnvs());
  it("Python 原件结果保存为 Dataset 时记录代码 / 文件来源并重新确认 AI 使用", async () => {
    const form = new FormData();
    form.append("file", new File(["station,seconds\nEDS,60\nCoat,120"], "raw.csv"));
    const code = "result = pd.read_csv(files['raw.csv']).assign(minutes=lambda df: df.seconds / 60)";
    form.set("payload", JSON.stringify({ pageId: "test", action: "dataset", targetCellId: "python", document: { name: "Python 来源", revision: 4, cells: [
      { id: "python", title: "处理", kind: "python", inputCellIds: [], fileNames: ["raw.csv"], outputName: "result", code },
    ] } }));
    const response = await POST(new Request("http://127.0.0.1:3001/api/notebook/run", { method: "POST", body: form }));
    const payload = await response.json() as { snapshot: DatasetUploadResponse };
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.snapshot.rows.map((row) => row.minutes)).toEqual([1, 2]);
    expect(payload.snapshot.dataset.aiAccessPolicy).toBe("pending");
    const lineage = payload.snapshot.dataset.provenance?.lineage;
    expect(lineage).toMatchObject({ sourceFiles: [{ name: "raw.csv", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }], complete: true });
    expect(JSON.parse(lineage!.steps[0].definition)).toMatchObject({ kind: "python", code });
    expect(mocks.put).toHaveBeenCalledTimes(1);
  }, 30_000);
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
  it("refuses a 31-column table snapshot before saving instead of silently dropping the last field", async () => {
    const doc = await wideResultDocument(31);
    const response = await POST(request({ pageId: "test", document: doc, action: "snapshot", targetCellId: "transform" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("最多 30 列") } });
    expect(mocks.put).not.toHaveBeenCalled();
  }, 15_000);
  it("saves all 30 fields at the dashboard table boundary", async () => {
    const doc = await wideResultDocument(30);
    const response = await POST(request({ pageId: "test", document: doc, action: "snapshot", targetCellId: "transform" }));
    expect(response.status).toBe(200);
    const payload = await response.json() as { snapshot: DatasetUploadResponse };
    expect(payload.snapshot.dataset.source.fields).toHaveLength(30);
    expect(payload.snapshot.rows).toEqual([Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field_${index}`, index]))]);
    expect(mocks.put).toHaveBeenCalledTimes(1);
  });
  it.each([
    { sql: "SELECT 'East' AS region, amount FROM input", message: "看板图表需要唯一分类，请先聚合，不会自动合并重复分类" },
    { sql: "SELECT region, NULL::DOUBLE AS amount FROM input", message: "当前看板图表不支持空数值，请先在 SQL 中明确处理 NULL" },
  ])("preserves the rejected chart error and avoids storing its result: $message", async ({ sql, message }) => {
    const uploaded = await source();
    const doc = document(uploaded.dataset.datasetId, sql);
    doc.cells.push({ id: "chart", title: "Chart", kind: "chart", inputCellId: "sql", chartType: "bar", categoryField: "region", valueFields: ["amount"] });
    const response = await POST(request({ pageId: "test", document: doc, action: "snapshot", targetCellId: "chart" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { message } });
    expect(mocks.put).not.toHaveBeenCalled();
  }, 15_000);
  it("still saves all 100 typed columns as a Dataset", async () => {
    const doc = await wideResultDocument(100);
    const response = await POST(request({ pageId: "test", document: doc, action: "dataset", targetCellId: "transform" }));
    expect(response.status).toBe(200);
    const payload = await response.json() as { snapshot: DatasetUploadResponse };
    expect(payload.snapshot.dataset.source.fields).toHaveLength(100);
    expect(payload.snapshot.rows).toEqual([Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field_${index}`, index]))]);
    expect(mocks.put).toHaveBeenCalledTimes(1);
  }, 15_000);
  it("saves a complete Dataset independently of dashboard limits and records its run provenance", async () => {
    const uploaded = await source();
    const doc = document(uploaded.dataset.datasetId, "SELECT i AS value FROM range(700) t(i)");
    const response = await POST(request({ pageId: "test", document: doc, action: "dataset", targetCellId: "sql" }));
    expect(response.status).toBe(200);
    const payload = await response.json() as { run: { runId: string }; snapshot: DatasetUploadResponse };
    expect(payload.snapshot.rows).toHaveLength(700);
    expect(payload.snapshot.dataset.provenance).toMatchObject({ kind: "notebook", runId: payload.run.runId, cellId: "sql", revision: 0, connectionIds: [] });
    expect(payload.snapshot.dataset.provenance?.lineage).toMatchObject({ complete: true, rowCount: 700, sourceDatasetIds: [uploaded.dataset.datasetId], accessMode: "user" });
    expect(payload.snapshot.dataset.provenance?.lineage?.steps.map((step) => step.cellId)).toEqual(["source", "sql"]);
    expect(JSON.parse(payload.snapshot.dataset.provenance!.lineage!.steps[1].definition).sql).toBe(doc.cells[1].kind === "sql" ? doc.cells[1].sql : "");
    expect(mocks.put).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("saves all 1324 complete transform rows while the run response remains a 1000-row preview", async () => {
    const uploaded = await parseCsvUpload({ stream: new Response("seq,amount\n" + Array.from({ length: 1324 }, (_, i) => `${i + 1},1`).join("\n")).body!,
      originalFileName: "synthetic-complete.csv", mimeType: "text/csv" });
    mocks.get.mockImplementation(async (_identity, id) => id === uploaded.dataset.datasetId ? { descriptor: uploaded.dataset, rows: uploaded.rows } : null);
    const doc: NotebookDocument = { name: "完整计算结果", revision: 9, cells: [
      { id: "source", title: "原数据", kind: "data", sourceDataSourceId: uploaded.dataset.datasetId, outputName: "input" },
      { id: "transform", title: "完整数据处理", kind: "transform", inputCellId: "source", outputName: "complete_rows", steps: [{ id: "keep", type: "limit", count: 2000 }] },
    ] };
    const before = structuredClone(uploaded);
    const response = await POST(request({ pageId: "test", document: doc, action: "dataset", targetCellId: "transform" }));
    const payload = await response.json() as { run: NotebookRun; snapshot: DatasetUploadResponse };
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.run.cells[0].table?.rows).toHaveLength(100);
    expect(payload.run.cells[1].table?.rows).toHaveLength(1000);
    expect(payload.run.cells[1].table?.truncated).toBe(true);
    expect(payload.run.cells[1].resultRef).toMatchObject({ complete: true, rowCount: 1324, accessMode: "user", revision: 9 });
    expect(payload.snapshot.rows).toEqual(uploaded.rows);
    expect(payload.snapshot.rows.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(1324);
    expect(payload.snapshot.dataset.provenance?.lineage).toMatchObject({ complete: true, rowCount: 1324, accessMode: "user" });
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(uploaded).toEqual(before);
  }, 15_000);

  it("keeps the 500-row dashboard limit on complete transform results, before any dataset write", async () => {
    const uploaded = await parseCsvUpload({ stream: new Response("value\n" + Array.from({ length: 700 }, (_, i) => String(i)).join("\n")).body!,
      originalFileName: "synthetic-dashboard-limit.csv", mimeType: "text/csv" });
    mocks.get.mockImplementation(async () => ({ descriptor: uploaded.dataset, rows: uploaded.rows }));
    const doc: NotebookDocument = { name: "完整但不能放看板", revision: 0, cells: [
      { id: "source", title: "原数据", kind: "data", sourceDataSourceId: uploaded.dataset.datasetId, outputName: "input" },
      { id: "transform", title: "处理", kind: "transform", inputCellId: "source", outputName: "complete_rows", steps: [{ id: "keep", type: "limit", count: 2000 }] },
    ] };
    const response = await POST(request({ pageId: "test", document: doc, action: "snapshot", targetCellId: "transform" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("最多 500 行") } });
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("saves the complete real Python output without replacing typed values with its preview", async () => {
    const doc: NotebookDocument = { name: "完整 Python 结果", revision: 2, cells: [
      { id: "python", title: "Python 计算", kind: "python", inputCellIds: [], fileNames: [], outputName: "result",
        code: "result = pd.DataFrame({'seq': range(1, 1325), 'code': ['001'] * 1324, 'missing': [None] * 1324})" },
    ] };
    const response = await POST(request({ pageId: "test", document: doc, action: "dataset", targetCellId: "python" }));
    const payload = await response.json() as { run: NotebookRun; snapshot: DatasetUploadResponse };
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.run.cells[0].table?.rows).toHaveLength(1000);
    expect(payload.run.cells[0].table?.truncated).toBe(true);
    expect(payload.run.cells[0].resultRef).toMatchObject({ complete: true, rowCount: 1324 });
    expect(payload.snapshot.rows).toHaveLength(1324);
    expect(payload.snapshot.rows[1323]).toEqual({ seq: 1324, code: "001", missing: null });
    expect(payload.snapshot.dataset.provenance?.lineage).toMatchObject({ complete: true, rowCount: 1324 });
    expect(mocks.put).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("still refuses saving actually truncated SQL instead of relabelling its preview complete", async () => {
    const uploaded = await source();
    const response = await POST(request({ pageId: "test", document: document(uploaded.dataset.datasetId, "SELECT i FROM range(2000) t(i)"), action: "dataset", targetCellId: "sql" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("未截断") } });
    expect(mocks.put).not.toHaveBeenCalled();
  }, 15_000);

  it("uses the server capability gate: disabled Python fails, its dependent blocks, and independent SQL still runs", async () => {
    vi.stubEnv("NOTEBOOK_PYTHON_ENABLED", "off");
    const doc: NotebookDocument = { name: "Capability gate", revision: 0, cells: [
      { id: "python", title: "Python", kind: "python", inputCellIds: [], fileNames: [], outputName: "python_result",
        code: "python_result = pd.DataFrame({'value': [1]})" },
      { id: "python_table", title: "Python result", kind: "table", inputCellId: "python", columns: ["value"] },
      { id: "parameter", title: "Input", kind: "parameter", outputName: "input_value", parameter: { type: "number", value: 7 } },
      { id: "sql", title: "Independent SQL", kind: "sql", inputCellIds: ["parameter"], outputName: "sql_result",
        sql: "SELECT value FROM input_value" },
    ] };
    const response = await POST(request({ pageId: "test", document: doc }));
    const payload = await response.json() as { run: NotebookRun };
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.run.status).toBe("failure");
    expect(payload.run.cells.find((cell) => cell.cellId === "python")).toMatchObject({
      status: "failure",
      error: "Python Notebook 能力已通过服务器配置关闭",
    });
    expect(payload.run.cells.find((cell) => cell.cellId === "python_table")).toMatchObject({ status: "blocked" });
    expect(payload.run.cells.find((cell) => cell.cellId === "parameter")).toMatchObject({ status: "success" });
    expect(payload.run.cells.find((cell) => cell.cellId === "sql")).toMatchObject({ status: "success" });
  }, 15_000);

  it("rejects an invalid server capability value explicitly", async () => {
    vi.stubEnv("NOTEBOOK_PYTHON_ENABLED", "sometimes");
    const response = await POST(request({ pageId: "test", document: { name: "Invalid config", revision: 0, cells: [] } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining("NOTEBOOK_PYTHON_ENABLED 配置无效") },
    });
  });
});
