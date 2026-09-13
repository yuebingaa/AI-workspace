import { notebookRunRequestSchema, NOTEBOOK_LIMITS } from "@/core/notebook/contracts";
import { cellsToRun } from "@/core/notebook/graph";
import { runNotebook } from "@/core/notebook/server/runtime";
import { resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import { requestDatasetRepository, requestProject, projectErrorResponse } from "@/core/projects/server/request";
import { ProjectError } from "@/core/projects/server/store";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { executeConnectionSql } from "@/core/connections/server/query";
import { assertLocalProjectRequest, requestProjectHandle } from "@/core/projects/server/request";

export const runtime = "nodejs";
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if ((origin && origin !== new URL(request.url).origin) || (fetchSite && !["same-origin", "none"].includes(fetchSite))) return Response.json({ error: { message: "只允许当前网站运行本地查询" } }, { status: 403, headers });
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") return Response.json({ error: { message: "必须使用 JSON 请求" } }, { status: 415, headers });
  try {
    const raw = await readBoundedUtf8Body(request, 120_000, { signal: request.signal, timeoutMs: 5_000 });
    const parsed = notebookRunRequestSchema.parse(JSON.parse(raw));
    if (parsed.document.cells.some((cell) => cell.kind === "warehouseSql")) assertLocalProjectRequest(request);
    const identity = resolveDemoRequestIdentity();
    const datasetRepository = requestDatasetRepository(request);
    const ids = [...new Set(cellsToRun(parsed.document, parsed.targetCellId).flatMap((cell) => cell.kind === "data" ? [cell.sourceDataSourceId] : []))];
    if (ids.length > 10) throw new Error("第一版每个 Notebook 最多使用 10 个源数据集");
    const sources = await Promise.all(ids.map(async (id) => {
      const stored = await datasetRepository.get(identity, id);
      if (stored) return { source: stored.descriptor.source, rows: stored.rows };
      const source = demoFixtureResult.success ? demoFixtureResult.data.dataProduct.appSpec.dataSources.find((item) => item.id === id) : undefined;
      const rows = demoFixtureResult.success ? demoFixtureResult.data.dataRuntime.rowsByDataSourceId[id] : undefined;
      if (!source || !rows) throw new Error("源数据不存在或已过期，请重新导入并在 Data 单元中重新选择数据源");
      return { source, rows };
    }));
    const run = await runNotebook({ document: parsed.document, sources, semanticModels: parsed.semanticModels,
      connectionQuery: (connectionId, sql, signal) => executeConnectionSql({ connectionId, sql, signal, project: requestProjectHandle(request) }),
      targetCellId: parsed.targetCellId, signal: request.signal, userId: identity.ownerId });
    if (parsed.action !== "run") {
      const cell = parsed.document.cells.find((item) => item.id === parsed.targetCellId);
      const result = run.cells.find((item) => item.cellId === parsed.targetCellId);
      if (!cell || !result?.table || result.status !== "success" || result.table.truncated) throw new Error("只有成功且未截断的表格结果才能放入看板；请先筛选或聚合数据");
      const table = result.table;
      if (!table.rows.length) throw new Error("结果为空，不能生成看板数据快照");
      if (parsed.action === "snapshot" && table.rows.length > 500) throw new Error("看板快照最多 500 行，请先筛选或聚合数据");
      if (parsed.action === "snapshot" && cell.kind === "chart") {
        const categories = table.rows.map((row) => String(row[cell.categoryField]));
        if (new Set(categories).size !== categories.length) throw new Error("看板图表需要唯一分类，请先聚合，不会自动合并重复分类");
        if (table.rows.some((row) => cell.valueFields.some((field) => typeof row[field] !== "number" || !Number.isFinite(row[field])))) throw new Error("当前看板图表不支持空数值，请先在 SQL 中明确处理 NULL");
      }
      const encode = (value: unknown) => '"' + String(value ?? "").replaceAll('"', '""') + '"';
      const csv = [table.fields.map((field) => encode(field.name)).join(","), ...table.rows.map((row) => table.fields.map((field) => encode(row[field.name])).join(","))].join("\n");
      const uploaded = await parseCsvUpload({ stream: new Response(csv).body!, originalFileName: "notebook-result.csv", mimeType: "text/csv", signal: request.signal });
      // CSV parsing establishes a valid descriptor, not the types of an already
      // typed SQL result. Preserve leading zeroes, booleans, null and precision.
      uploaded.dataset.source.fields.forEach((field, index) => {
        field.type = table.fields[index].type;
        field.label = table.fields[index].label;
        field.supportedAggregations = field.type === "number" ? ["none", "sum", "average", "count", "countDistinct", "min", "max"] : ["none", "count", "countDistinct", "min", "max"];
      });
      uploaded.rows = table.rows.map((row) => Object.fromEntries(uploaded.dataset.source.fields.map((field, index) => [field.name, row[table.fields[index].name]])));
      for (const field of uploaded.dataset.source.fields) {
        const values = uploaded.rows.map((row) => row[field.name]);
        field.nullCount = values.filter((value) => value === null).length;
        field.nullRate = field.nullCount / uploaded.rows.length;
        field.uniqueCount = new Set(values.filter((value) => value !== null)).size;
        field.typeConflictCount = 0;
      }
      const nullCellCount = uploaded.dataset.source.fields.reduce((sum, field) => sum + (field.nullCount ?? 0), 0);
      const nullRate = nullCellCount / (uploaded.rows.length * table.fields.length);
      const duplicateRowCount = uploaded.rows.length - new Set(uploaded.rows.map((row) => JSON.stringify(row))).size;
      const anomalies = (uploaded.dataset.source.quality?.anomalies ?? []).filter((item) => item.kind === "numeric-outlier"
        && uploaded.dataset.source.fields.find((field) => field.name === item.field)?.type === "number");
      uploaded.dataset.source.quality = { nullCellCount, nullRate, duplicateRowCount, typeConflictCount: 0, anomalies };
      const anomalyRate = anomalies.reduce((sum, item) => sum + item.count, 0) / (uploaded.rows.length * table.fields.length);
      uploaded.dataset.source.qualityScore = Math.max(0, Math.round(100 - nullRate * 30 - duplicateRowCount / uploaded.rows.length * 20 - anomalyRate * 20));
      uploaded.dataset.sensitiveFields.forEach((field) => { field.label = uploaded.dataset.source.fields.find((item) => item.name === field.field)!.label; });
      uploaded.dataset.source.name = `${cell.title} · ${parsed.action === "dataset" ? "数据集" : "结果快照"}`;
      // A SQL alias can hide sensitive lineage. Conservatively carry input
      // sensitivity into every output column until per-column SQL lineage exists.
      const categories = [...new Set([...sources.flatMap((item) => item.source.fields.flatMap((field) => field.sensitiveCategories ?? [])),
        ...uploaded.dataset.sensitiveFields.flatMap((field) => field.categories)])];
      if (categories.length) {
        uploaded.dataset.source.fields.forEach((field) => { field.sensitiveCategories = categories; });
        uploaded.dataset.sensitiveFields = uploaded.dataset.source.fields.map((field) => ({ field: field.name, label: field.label, categories }));
        uploaded.dataset.aiAccessPolicy = "pending";
        uploaded.dataset.source.aiAccessPolicy = "pending";
      }
      // External SQL aliases do not establish column sensitivity. Explicitly
      // obtain dataset AI consent before sending a manually saved result to AI.
      if (cellsToRun(parsed.document, parsed.targetCellId).some((item) => item.kind === "warehouseSql")) {
        uploaded.dataset.aiAccessPolicy = "pending";
        uploaded.dataset.source.aiAccessPolicy = "pending";
      }
      if (result.resultRef) uploaded.dataset.provenance = {
        kind: "notebook", runId: run.runId, resultId: result.resultRef.resultId,
        cellId: cell.id, revision: run.revision,
        connectionIds: [...new Set(cellsToRun(parsed.document, cell.id).flatMap((item) => item.kind === "warehouseSql" ? [item.connectionId] : []))],
      };
      const serialized = JSON.stringify({ run, snapshot: uploaded });
      if (Buffer.byteLength(serialized) > NOTEBOOK_LIMITS.outputBytes * 2) throw new Error("结果快照过大");
      if (request.signal.aborted) throw new Error("请求已取消，未保存快照");
      const project = requestProject(request);
      if (project) {
        const snapshot = project.putTable(uploaded, "result");
        return Response.json({ run, snapshot }, { headers });
      }
      await datasetRepository.put(identity, uploaded);
      return new Response(serialized, { headers: { ...headers, "content-type": "application/json" } });
    }
    return Response.json({ run }, { headers });
  } catch (error) {
    if (error instanceof ProjectError) return projectErrorResponse(error);
    return Response.json({ error: { message: error instanceof Error ? error.message.slice(0, 1_000) : "Notebook 运行失败" } }, { status: 400, headers });
  }
}
