import type { NotebookCell } from "@/core/notebook/definition";

type CellPresentation = {
  label: string;
  toolbarLabel: string;
  detail: string;
  sourceLabel: string;
  sourceLanguage: string;
};

// Browser presentation only: schemas, editor behavior and execution stay with
// their owners. A new canonical kind must explicitly supply its presentation.
export const notebookCellPresentation = {
  data: { label: "Data", toolbarLabel: "数据", detail: "选用已导入的数据源", sourceLabel: "配置", sourceLanguage: "数据引用" },
  semanticQuery: { label: "语义查询", toolbarLabel: "语义查询", detail: "按已有模型查询维度与指标", sourceLabel: "配置", sourceLanguage: "查询配置" },
  sql: { label: "SQL", toolbarLabel: "SQL", detail: "查询已导入的数据", sourceLabel: "SQL", sourceLanguage: "SQL" },
  warehouseSql: { label: "数据库 SQL", toolbarLabel: "数据库 SQL", detail: "查询已配置的数据库连接", sourceLabel: "SQL", sourceLanguage: "SQL" },
  python: { label: "Python", toolbarLabel: "Python", detail: "用 pandas / NumPy 处理数据", sourceLabel: "Python", sourceLanguage: "Python" },
  transform: { label: "DataRecipe", toolbarLabel: "数据处理", detail: "用 DataRecipe 筛选、计算和汇总", sourceLabel: "处理规则", sourceLanguage: "DataRecipe · JSON" },
  table: { label: "表格", toolbarLabel: "表格", detail: "选择并展示结果字段", sourceLabel: "配置", sourceLanguage: "展示配置" },
  chart: { label: "图表", toolbarLabel: "图表", detail: "将上游结果可视化", sourceLabel: "配置", sourceLanguage: "展示配置" },
  text: { label: "说明", toolbarLabel: "说明", detail: "记录问题、结论与分析口径", sourceLabel: "配置", sourceLanguage: "Markdown" },
  parameter: { label: "参数", toolbarLabel: "参数", detail: "输入文本、数值、日期或单选值", sourceLabel: "配置", sourceLanguage: "参数配置" },
} as const satisfies Record<NotebookCell["kind"], CellPresentation>;

// Product order intentionally differs from the schema's discriminator order.
export const notebookToolbarOrder = ["sql", "python", "warehouseSql", "text", "parameter", "chart", "table", "transform", "semanticQuery", "data"] as const satisfies readonly NotebookCell["kind"][];
