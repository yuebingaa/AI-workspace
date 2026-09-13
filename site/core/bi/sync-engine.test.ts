import { describe, expect, it } from "vitest";
import { executeChartBinding, executeMetricBinding } from "@/core/data/query-runtime";
import type { DataSourceField } from "@/core/models/data-binding";
import {
  BiSyncEngine,
  BiSyncValidationError,
  testBiConnection,
  type BiConnector,
  type BiPullRequest,
  type BiPullResult,
} from "./index";

const fields: DataSourceField[] = [
  { name: "order_id", label: "订单编号", type: "string", aggregatable: false, supportedAggregations: ["none", "count", "countDistinct"] },
  { name: "region", label: "区域", type: "string", aggregatable: false, supportedAggregations: ["none", "count", "countDistinct"] },
  { name: "revenue", label: "收入", type: "number", aggregatable: true, supportedAggregations: ["none", "sum", "average", "count", "min", "max"] },
];

class ScriptedBiConnector implements BiConnector {
  readonly kind = "synthetic-bi";
  readonly requests: BiPullRequest[] = [];

  constructor(private readonly pulls: BiPullResult[]) {}

  async testConnection() {
    return { ok: true as const, checkedAt: "2026-09-09T01:00:00.000Z", serviceName: "Synthetic BI", latencyMs: 8 };
  }

  async pullDataset(request: BiPullRequest): Promise<BiPullResult> {
    this.requests.push(structuredClone(request));
    const next = this.pulls.shift();
    if (!next) throw new Error("synthetic BI response queue exhausted");
    return structuredClone(next);
  }
}

const request = {
  connectionId: "connection_synthetic_01",
  externalDatasetId: "sales-overview",
  dataSourceId: "dataset_bi_sales_overview_01",
};

function initialSnapshot(): BiPullResult {
  return {
    status: "snapshot",
    version: "v1",
    observedAt: "2026-09-09T01:00:01.000Z",
    datasetName: "销售总览",
    fields,
    rows: [
      { order_id: "A-001", region: "华东", revenue: 100 },
      { order_id: "A-002", region: "华南", revenue: 200 },
    ],
  };
}

describe("BI 平台同步内核", () => {
  it("验证连接并把首次全量快照交给现有指标和图表查询层", async () => {
    const connector = new ScriptedBiConnector([initialSnapshot()]);
    expect(await testBiConnection(connector)).toMatchObject({ ok: true, serviceName: "Synthetic BI", latencyMs: 8 });

    const engine = new BiSyncEngine();
    const result = await engine.synchronize(connector, request);
    expect(result).toMatchObject({ status: "updated", mode: "snapshot", dataset: { version: "v1" } });
    expect(result.dataset.source).toMatchObject({ sourceType: "bi", rowCount: 2, columnCount: 3 });
    expect(connector.requests[0]).toMatchObject({ externalDatasetId: "sales-overview", previousVersion: null });

    const binding = {
      dataSourceId: request.dataSourceId,
      field: "revenue",
      aggregation: "sum" as const,
      groupBy: null,
      filters: [],
      sort: [],
      limit: 20,
      format: { style: "number" as const },
    };
    expect(executeMetricBinding(binding, [result.dataset.source], engine.runtime(request.dataSourceId)).rawValue).toBe(300);
    expect(executeChartBinding(
      { ...binding, groupBy: "region", sort: [{ field: "revenue", direction: "desc" as const }] },
      [result.dataset.source],
      engine.runtime(request.dataSourceId),
    )).toMatchObject({ labels: ["华南", "华东"], values: [200, 100] });
  });

  it("携带版本游标跳过未变化数据，再应用增量更新与删除", async () => {
    const connector = new ScriptedBiConnector([
      initialSnapshot(),
      { status: "not-modified", checkedAt: "2026-09-09T01:00:05.000Z" },
      {
        status: "delta",
        baseVersion: "v1",
        version: "v2",
        observedAt: "2026-09-09T01:00:10.000Z",
        primaryKey: "order_id",
        upserts: [
          { order_id: "A-002", region: "华南", revenue: 250 },
          { order_id: "A-003", region: "华北", revenue: 300 },
        ],
        deletedKeys: ["A-001"],
      },
    ]);
    const engine = new BiSyncEngine();
    await engine.synchronize(connector, request);
    const unchanged = await engine.synchronize(connector, request);
    const updated = await engine.synchronize(connector, request);

    expect(unchanged).toMatchObject({ status: "unchanged", dataset: { version: "v1" } });
    expect(updated).toMatchObject({ status: "updated", mode: "delta", dataset: { version: "v2" } });
    expect(updated.dataset.rows).toEqual([
      { order_id: "A-002", region: "华南", revenue: 250 },
      { order_id: "A-003", region: "华北", revenue: 300 },
    ]);
    expect(connector.requests.map((item) => item.previousVersion)).toEqual([null, "v1", "v1"]);

    const metric = executeMetricBinding({
      dataSourceId: request.dataSourceId,
      field: "revenue",
      aggregation: "sum",
      groupBy: null,
      filters: [],
      sort: [],
      limit: 20,
      format: { style: "number" },
    }, [updated.dataset.source], engine.runtime(request.dataSourceId));
    expect(metric.rawValue).toBe(550);
  });

  it("拒绝错误基线或错误字段类型，并保留最后一个有效版本", async () => {
    const connector = new ScriptedBiConnector([
      initialSnapshot(),
      {
        status: "delta",
        baseVersion: "stale-version",
        version: "v2",
        observedAt: "2026-09-09T01:00:10.000Z",
        primaryKey: "order_id",
        upserts: [{ order_id: "A-003", region: "华北", revenue: 300 }],
        deletedKeys: [],
      },
      {
        status: "snapshot",
        version: "v3",
        observedAt: "2026-09-09T01:00:20.000Z",
        datasetName: "销售总览",
        fields,
        rows: [{ order_id: "A-009", region: "华东", revenue: "错误数值" }],
      },
    ]);
    const engine = new BiSyncEngine();
    await engine.synchronize(connector, request);

    await expect(engine.synchronize(connector, request)).rejects.toThrow(/基线版本不匹配/);
    expect(engine.get(request.dataSourceId)?.version).toBe("v1");
    await expect(engine.synchronize(connector, request)).rejects.toBeInstanceOf(BiSyncValidationError);
    expect(engine.get(request.dataSourceId)?.version).toBe("v1");
  });
});
