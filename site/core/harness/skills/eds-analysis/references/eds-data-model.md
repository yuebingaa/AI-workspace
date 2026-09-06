# EDS 派生数据模型

## 总览数据

`dataset_eds_overview` 每个日期和班次一行。关键字段：

- `input_rows`：输入明细行数。
- `matched_rows`：命中记录行数。
- `total_occurrences`：异常发生次数。
- `total_minutes`：异常累计分钟。
- `top_line` / `top_line_occurrences`：次数最多线体及次数。
- `top_issue` / `top_issue_minutes`：累计时间最长异常分类及分钟。

## 分类数据

`dataset_eds_breakdown` 的 `view` 决定数据粒度：

- `线体`：`line` 和 `category` 均表示线体，适合线体汇总排名。
- `异常分类`：`line` 为“全部线体”，`category` 表示全局异常分类。
- `线体异常分类`：`line` 是具体线体，`category` 是该线体的异常分类。

数值字段为 `occurrences` 和 `minutes`。表格可按 `view`、`line`、`category`、`occurrences`、`minutes` 多级排序。

## 工具选择

- 汇总诊断：`analyzeEdsReports`。
- 全量原始数据：先 `scanEdsRawWorkbook`，再 `queryEdsRawWorkbook`。
- 新增 EDS 图表：`createEdsBreakdownChartPreview` 或 `createEdsLineIssueChartPreview`。
- 修改 EDS 现有表格：`updateEdsTablePreview`。

线体汇总和全局异常分类不依赖 `线体异常分类` 视图。只有明确询问某条线体内部的异常构成时才检查交叉视图是否存在。
