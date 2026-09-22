import type { AppPage, ChangeSet, DataBinding } from "@/core/models";
import type { DatasetUploadResponse } from "@/core/datasets/contracts";
import type { NotebookCell } from "@/core/notebook/definition";
import { NOTEBOOK_DASHBOARD_LIMITS, NOTEBOOK_DASHBOARD_MESSAGES, notebookDashboardSizeIssue, notebookDashboardSnapshotIssue } from "./dashboard-policy";

export function notebookDashboardPreview(page: AppPage, cell: NotebookCell, snapshot: DatasetUploadResponse, id: string): ChangeSet {
  const source = snapshot.dataset.source;
  const fieldName = (name: string) => snapshot.dataset.fieldMappings.find((item) => item.originalName === name)?.normalizedName ?? name;
  const mappedCell = cell.kind === "chart" ? { ...cell, categoryField: fieldName(cell.categoryField), valueFields: cell.valueFields.map(fieldName) } : cell;
  const issue = notebookDashboardSizeIssue(cell.kind, source.rowCount, source.fields.length)
    ?? notebookDashboardSnapshotIssue(mappedCell, { fields: source.fields, rows: snapshot.rows });
  if (issue) {
    // Preserve the existing preview-specific messages; the API keeps its own established wording.
    const message = issue === "rowLimit" ? "看板最多展示 500 行；请先在 SQL 中筛选或聚合，不能静默丢弃结果"
      : issue === "duplicateCategories" ? "看板图表需要唯一分类，请先在 SQL 中聚合；不会自动合并重复分类"
      : NOTEBOOK_DASHBOARD_MESSAGES[issue];
    throw new Error(message);
  }
  const binding: DataBinding = { dataSourceId: source.id, field: source.fields[0].name, aggregation: "none", groupBy: null,
    filters: [], sort: [], limit: Math.min(NOTEBOOK_DASHBOARD_LIMITS.rows, source.rowCount), format: { style: "auto" },
    ...(cell.kind === "chart" ? {} : { columns: source.fields.map((field) => ({ field: field.name, label: field.label, aggregation: "none" as const, format: { style: "auto" as const } })) }) };
  const subtitle = "Notebook 结果快照 · 步骤修改后需重新生成预览";
  if (cell.kind === "chart") {
    // The existing dashboard supports one series per chart: preserve every
    // selected series by creating separate charts, without re-aggregating it.
    const category = fieldName(cell.categoryField);
    return { id: `changeset_notebook_${id}`, title: `Notebook 图表：${cell.title}`, status: "ready",
      operations: cell.valueFields.map((field, index) => ({ id: `op_notebook_${id}_${index}`, type: "addNode", pageId: page.id, parentId: page.root.id,
        label: `添加 ${cell.title}`, description: subtitle, node: { id: `node_notebook_${id}_${index}`, type: "BarChart", props: {
          title: cell.valueFields.length > 1 ? `${cell.title} · ${field}` : cell.title, subtitle, chartType: cell.chartType,
          binding: { ...binding, field: fieldName(field), groupBy: category, columns: undefined },
        } } })) };
  }
  return { id: `changeset_notebook_${id}`, title: `Notebook 表格：${cell.title}`, status: "ready", operations: [{
    id: `op_notebook_${id}`, type: "addNode", pageId: page.id, parentId: page.root.id,
    label: `添加 ${cell.title}`, description: subtitle,
    node: { id: `node_notebook_${id}`, type: "DataTable", props: { title: cell.title, subtitle, actionLabel: "结果快照", binding } },
  }] };
}
