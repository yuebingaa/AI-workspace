import { describe, expect, it } from "vitest";
import { createExecutionState } from "@/core/changesets";
import { executeChartBinding, executeMetricBinding, executeTableBinding } from "@/core/data";
import { buildHarnessContextSelection, executeHarnessTool, resolveHarnessPageDataSourceIds } from "@/core/harness";
import type { EdsAnalysisResponse } from "./contracts";
import { analyzeEdsWorkbook } from "./analysis";
import { createSyntheticEdsFixture } from "@/fixtures/eds-synthetic";
import { demoFixtureResult } from "@/fixtures/demo-product";
import {
  createEdsAuditSummary,
  createEdsWorkspaceRuntime,
  createEdsWorkspaceSnapshot,
  createEdsWorkspaceSnapshotForResults,
  EDS_BREAKDOWN_DATA_SOURCE_ID,
  EDS_OVERVIEW_DATA_SOURCE_ID,
  EDS_WORKSPACE_PAGE_ID,
  getEdsWorkspaceReports,
  installEdsWorkspaceInDataProduct,
  installEdsWorkspaceInExecution,
  selectEdsWorkspaceReport,
} from "./workspace";

function result(): EdsAnalysisResponse {
  const fixture = createSyntheticEdsFixture();
  const analysis = analyzeEdsWorkbook(fixture.sourceSheets);
  return {
    summary: analysis.summary,
    issueSummary: analysis.issueSummary,
    lineSummary: analysis.lineSummary,
    configuration: analysis.configuration,
    comparison: analysis.comparison,
    exportArtifact: {
      id: "workspaceartifact1",
      status: "ready",
      fileName: "private-source-name.xlsx",
      downloadUrl: "/api/exports/workspaceartifact1",
      rowCount: 30,
      fieldCount: 20,
      sizeBytes: 9_999,
      createdAt: "2026-09-04T03:00:00.000Z",
      expiresAt: "2026-09-04T03:10:00.000Z",
    },
    warnings: ["private-warning"],
  };
}

function fixtures() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return structuredClone(demoFixtureResult.data);
}

function shiftResults(): [EdsAnalysisResponse, EdsAnalysisResponse] {
  const white = result();
  white.summary.date = "2026-09-03";
  white.summary.shift = "白班";
  const night = structuredClone(white);
  night.summary.shift = "夜班";
  night.summary.inputRows += 100;
  night.exportArtifact.fileName = "private-night.xlsx";
  night.exportArtifact.downloadUrl = "/api/exports/private-night";
  return [white, night];
}

function child(page: ReturnType<typeof installEdsWorkspaceInDataProduct>["appSpec"]["pages"][number], id: string) {
  const visit = (node: typeof page.root): typeof page.root | undefined => {
    if (node.id === id) return node;
    for (const nested of node.children ?? []) {
      const found = visit(nested);
      if (found) return found;
    }
  };
  return visit(page.root);
}

describe("EDS 派生汇总工作区", () => {
  it("只提取可持久化汇总，不保存原始表名、验收差异、警告或下载令牌", () => {
    const input = result();
    input.summary.sourceSheets = ["PRIVATE_RAW_SHEET_CANARY"];
    const snapshot = createEdsWorkspaceSnapshot(input, () => new Date("2026-09-04T03:30:00.000Z"));
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.generatedAt).toBe("2026-09-04T03:30:00.000Z");
    expect(snapshot.summary).toMatchObject({ date: "2026-08-25", shift: "白班" });
    expect(serialized).not.toContain("PRIVATE_RAW_SHEET_CANARY");
    expect(serialized).not.toContain("private-source-name.xlsx");
    expect(serialized).not.toContain("workspaceartifact1");
    expect(serialized).not.toContain("private-warning");
    expect(serialized).not.toContain("comparison");
    expect(serialized).not.toContain("sourceSheets");
  });

  it("生成双数据源与真实绑定页面，并保持重复生成幂等", () => {
    const data = fixtures();
    const snapshot = createEdsWorkspaceSnapshot(result(), () => new Date("2026-09-04T03:30:00.000Z"));
    const first = installEdsWorkspaceInDataProduct(data.dataProduct, snapshot);
    const second = installEdsWorkspaceInDataProduct(first, snapshot);
    const runtime = createEdsWorkspaceRuntime(snapshot);
    const page = second.appSpec.pages.find((candidate) => candidate.id === EDS_WORKSPACE_PAGE_ID)!;
    const metric = child(page, "eds_metric_occurrences");
    const lineChart = child(page, "eds_chart_lines");
    const table = child(page, "eds_summary_table");

    expect(second.appSpec.pages.filter((candidate) => candidate.id === EDS_WORKSPACE_PAGE_ID)).toHaveLength(1);
    expect(second.appSpec.dataSources.filter((source) => [EDS_OVERVIEW_DATA_SOURCE_ID, EDS_BREAKDOWN_DATA_SOURCE_ID].includes(source.id))).toHaveLength(2);
    expect(second.datasets.filter((source) => [EDS_OVERVIEW_DATA_SOURCE_ID, EDS_BREAKDOWN_DATA_SOURCE_ID].includes(source.id))).toHaveLength(2);
    expect(runtime.rowsByDataSourceId[EDS_OVERVIEW_DATA_SOURCE_ID]).toHaveLength(1);
    expect(runtime.rowsByDataSourceId[EDS_BREAKDOWN_DATA_SOURCE_ID]).toHaveLength(24);
    if (!metric || metric.type !== "MetricCard" || !lineChart || lineChart.type !== "BarChart" || !table || table.type !== "DataTable") {
      throw new Error("EDS 页面组件缺失");
    }
    expect(executeMetricBinding(metric.props.binding, second.appSpec.dataSources, runtime).rawValue).toBe(snapshot.summary.totalOccurrences);
    expect(executeChartBinding(lineChart.props.binding, second.appSpec.dataSources, runtime).labels).toHaveLength(10);
    expect(executeTableBinding(table.props.binding, second.appSpec.dataSources, runtime).rows).toHaveLength(24);
  });

  it("同时保存多个班次并按当前班次过滤看板数据", () => {
    const data = fixtures();
    const results = shiftResults();
    const white = createEdsWorkspaceSnapshotForResults(results, 0, () => new Date("2026-09-04T03:30:00.000Z"));
    const night = selectEdsWorkspaceReport(white, 1);
    const reports = getEdsWorkspaceReports(night);
    const product = installEdsWorkspaceInDataProduct(data.dataProduct, night);
    const runtime = createEdsWorkspaceRuntime(night);
    const page = product.appSpec.pages.find((candidate) => candidate.id === EDS_WORKSPACE_PAGE_ID)!;
    const metric = child(page, "eds_metric_input");
    const table = child(page, "eds_summary_table");

    expect(reports.map((report) => report.summary.shift)).toEqual(["白班", "夜班"]);
    expect(night.summary).toEqual(reports[1].summary);
    expect(runtime.rowsByDataSourceId[EDS_OVERVIEW_DATA_SOURCE_ID]).toHaveLength(2);
    expect(runtime.rowsByDataSourceId[EDS_BREAKDOWN_DATA_SOURCE_ID]).toHaveLength(48);
    expect(product.appSpec.dataSources.find((source) => source.id === EDS_OVERVIEW_DATA_SOURCE_ID)?.rowCount).toBe(2);
    expect(product.appSpec.dataSources.find((source) => source.id === EDS_BREAKDOWN_DATA_SOURCE_ID)?.rowCount).toBe(48);
    if (!metric || metric.type !== "MetricCard" || !table || table.type !== "DataTable") throw new Error("EDS 页面组件缺失");
    expect(executeMetricBinding(metric.props.binding, product.appSpec.dataSources, runtime).rawValue).toBe(results[1].summary.inputRows);
    expect(executeTableBinding(table.props.binding, product.appSpec.dataSources, runtime).rows).toHaveLength(24);
    expect(JSON.stringify(night)).not.toContain("private-night.xlsx");
    expect(JSON.stringify(night)).not.toContain("/api/exports/private-night");
  });

  it("把派生数据源同步进正式态、预览和历史，避免后续撤销丢失 EDS 上下文", () => {
    const data = fixtures();
    const snapshot = createEdsWorkspaceSnapshot(result());
    const base = createExecutionState(data.dataProduct.appSpec);
    const execution = installEdsWorkspaceInExecution({
      ...base,
      preview: { appSpec: base.present, changeSetId: "preview_x", operationIds: ["op_x"] },
      history: [{ appSpec: base.present, changeSetId: "history_x", requiredRole: "editor" }],
    }, snapshot);

    expect(execution.present.pages.some((page) => page.id === EDS_WORKSPACE_PAGE_ID)).toBe(true);
    expect(execution.preview?.appSpec.pages.some((page) => page.id === EDS_WORKSPACE_PAGE_ID)).toBe(true);
    expect(execution.history[0].appSpec.pages.some((page) => page.id === EDS_WORKSPACE_PAGE_ID)).toBe(true);
  });

  it("EDS 页面让 Harness 初始上下文和字段检查读取派生值", async () => {
    const data = fixtures();
    const snapshot = createEdsWorkspaceSnapshot(result());
    const product = installEdsWorkspaceInDataProduct(data.dataProduct, snapshot);
    const runtime = createEdsWorkspaceRuntime(snapshot);
    const request = {
      idempotencyKey: "request_eds_workspace_context",
      instruction: "检查 EDS 分析字段和示例值，不要修改页面。",
      pageId: EDS_WORKSPACE_PAGE_ID,
      dataSourceId: EDS_OVERVIEW_DATA_SOURCE_ID,
      appSpec: product.appSpec,
      recipes: product.recipes,
      edsWorkspace: snapshot,
      role: "editor" as const,
    };
    const selection = buildHarnessContextSelection(request, [], 1);
    const fieldResult = await executeHarnessTool("inspectFields", {
      dataSourceId: EDS_OVERVIEW_DATA_SOURCE_ID,
      fields: ["total_occurrences", "total_minutes", "template_version"],
    }, { request, dataRuntime: runtime, now: () => 1, id: () => "eds_context" });
    const serialized = JSON.stringify(fieldResult.data);

    expect(resolveHarnessPageDataSourceIds(request)).toEqual([EDS_OVERVIEW_DATA_SOURCE_ID, EDS_BREAKDOWN_DATA_SOURCE_ID]);
    expect(selection.toolNames).toEqual(["analyzeEdsReports"]);
    expect(JSON.stringify(selection.context)).toContain(EDS_OVERVIEW_DATA_SOURCE_ID);
    expect(JSON.stringify(selection.context)).toContain(EDS_BREAKDOWN_DATA_SOURCE_ID);
    expect(serialized).toContain(String(snapshot.summary.totalOccurrences));
    expect(serialized).toContain(snapshot.configuration.templateVersion);
    expect(serialized).not.toContain("sourceSheets");
  });

  it("审计正文包含完整派生线体/异常摘要与版本，并声明不含原始行", () => {
    const snapshot = createEdsWorkspaceSnapshot(result());
    const summary = createEdsAuditSummary(snapshot);

    expect(summary).toContain("派生汇总（不含原始行）");
    expect(summary).toContain(snapshot.configuration.templateVersion);
    expect(summary).toContain(snapshot.configuration.ruleVersion);
    expect(snapshot.lineSummary.every((item) => summary.includes(item.label))).toBe(true);
    expect(snapshot.issueSummary.every((item) => summary.includes(item.label))).toBe(true);
    expect(summary).not.toContain(".xlsx");
  });

  it("多班次审计正文同时记录各班次派生汇总且不包含下载信息", () => {
    const snapshot = createEdsWorkspaceSnapshotForResults(shiftResults(), 1);
    const summary = createEdsAuditSummary(snapshot);

    expect(summary).toContain("2份派生汇总（不含原始行）");
    expect(summary).toContain("2026-09-03 白班");
    expect(summary).toContain("2026-09-03 夜班");
    expect(summary).not.toContain("private-night.xlsx");
    expect(summary).not.toContain("/api/exports/");
  });
});
