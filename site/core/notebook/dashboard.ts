import type { AppPage, ChangeSet, DataBinding } from "@/core/models";
import type { DatasetUploadResponse } from "@/core/datasets/contracts";
import type { HarnessNotebookCell } from "@/core/harness/notebook-contracts";

export function notebookDashboardPreview(page: AppPage, cell: HarnessNotebookCell, snapshot: DatasetUploadResponse, id: string): ChangeSet {
  const source = snapshot.dataset.source;
  const fieldName = (name: string) => snapshot.dataset.fieldMappings.find((item) => item.originalName === name)?.normalizedName ?? name;
  const binding: DataBinding = { dataSourceId: source.id, field: source.fields[0].name, aggregation: "none", groupBy: null,
    filters: [], sort: [], limit: Math.min(500, source.rowCount), format: { style: "auto" },
    columns: source.fields.slice(0, 30).map((field) => ({ field: field.name, label: field.label, aggregation: "none", format: { style: "auto" } })) };
  const subtitle = "Notebook 结果快照 · 步骤修改后需重新生成预览";
  if (source.rowCount > 500) throw new Error("看板最多展示 500 行；请先在 SQL 中筛选或聚合，不能静默丢弃结果");
  if (cell.kind === "chart") {
    // The existing dashboard supports one series per chart: preserve every
    // selected series by creating separate charts, without re-aggregating it.
    const category = fieldName(cell.categoryField);
    const labels = snapshot.rows.map((row) => String(row[category]));
    if (new Set(labels).size !== labels.length) throw new Error("看板图表需要唯一分类，请先在 SQL 中聚合；不会自动合并重复分类");
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
