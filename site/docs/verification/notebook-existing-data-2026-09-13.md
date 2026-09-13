# 已有数据的 Notebook 与 Agent 验收

日期：2026-09-13。结论：手动计算与保存操作通过，但快照看板存在分类标签错位；本轮两个真实 Agent 用例均未通过，整体验收未通过。本次新增验收脚本与记录，没有修改产品运行代码或发布稳定站。

## 数据与执行范围

使用开发站 `http://127.0.0.1:3001` 和已有模型配置 `deepseek-flash`。未读取或输出模型密钥，未改变模型、连接或数据授权配置。外部连接目录为空，因此本次不包含 PostgreSQL / Databricks 实机联调。

- 已有零售示例：`fixtures/retail-orders.ts`，48 行、14 列，2025 年 1–12 月、4 个地区。这是项目原有示例，不是用户真实销售数据。当前工作台隐藏旧演示页面，脚本仅在隔离浏览器的测试状态中将该已有数据关联到空白工作界面。
- 已有项目导入表：21 行、15 列，12 个未命名字段、1 个全空字段（`field_8`）。沿用 `exclude-sensitive-samples`，未重新授权敏感样本。报告不包含原文件名、人员信息或原始数据行。

## 手动链路：通过

执行已有数据 → 本地 DuckDB SQL → DataRecipe 分组与排序 → 柱状图 → 可选 Dataset 保存 → Dashboard 快照预览与确认。

SQL 为 `SELECT region, revenue FROM retail_orders`；DataRecipe 按 `region` 汇总 `revenue` 为 `total_revenue` 并降序排列。预期值由脚本直接遍历已有原始行计算，独立于 SQL 和 DataRecipe 执行器。

| 地区 | 汇总收入 |
| --- | ---: |
| 华东 | 1,248,600 |
| 华南 | 896,420 |
| 华北 | 672,180 |
| 西部 | 430,800 |
| 合计 | 3,248,000 |

本轮 8 项浏览器操作检查通过：读取已有 48 行；SQL / 配方与四根图形柱的结果匹配独立计算；Dataset 可重新读取并携带来源；重跑配方使旧图表失效；刷新后定义保留且重跑结果一致；Notebook 与 Dataset 保存不改看板页面；生成独立快照预览；仅在隔离浏览器中确认预览，测试看板增加一个图表。浏览器未捕获页面异常。已检查 [Notebook 截图](../../.runtime/notebook-existing-2026-09-13T14-53-27-850Z/chart.png) 与 [看板截图](../../.runtime/notebook-existing-2026-09-13T14-53-27-850Z/dashboard-applied.png)。这些操作通过不代表视觉验收通过，见下方错位问题。

已有导入表通过真实 SQL 统计全部行数和各字段空值数，与原始行的独立计数逐列一致。只读复核前后，项目清单、数据内容和授权设置的摘要一致。仅清理验收脚本创建的临时结果 Dataset，不删除已有项目或表。

## 看板视觉：未通过

Notebook 图表的分类与柱形对齐，但转换成 Dashboard 快照后，四根柱形中心分别比对应标签中心偏右 25.25、69.75、114.25、158.75 像素。截图观察后增加 DOM 测量，确认不是截图时的尺寸过渡。数字仍正确，分类显示可能误导阅读。

当前 `components/data-components/BarChart.tsx` 的绘图区最小宽度为 520，而四个自定义标签按每个 84 像素排列，总宽度为 336；两者未使用相同的分类间距。本轮仅定位和记录，没有修改该组件。报告保留 `dashboardVisual.passed=false`。

## 真实 Agent：未通过

| 用例 | 实际观察 | 结论 |
| --- | --- | --- |
| 根据已有零售数据生成 SQL → DataRecipe → 柱状图 Notebook | 语义路由和动态规划执行后，在首次业务工具调用前触发 `contextBudgetExceeded`；压缩后仍超过单次 10,000 字符限制，没有产出 Notebook 草稿 | 未通过 |
| 检查已有导入表的字段质量，并说明能否用于地区销售分析 | `inspectDataset` 和 `inspectFields` 成功；随后调用 `transformSpreadsheetData` 失败，最终为 `protocolViolation`，没有形成合格的质量结论或图表 | 未通过 |

首个用例的公开回执显示 `requiresVisualVerification=true`，前置感知描述了一个空白看板，未体现测试浏览器已经关联的 Notebook 数据；动态规划沿用了该感知。应优先检查 Notebook 与看板感知范围，以及计划、工具目录和证据如何共同占用上下文预算。这是根据本轮事件提出的排查方向，尚未证明全部根因或实施修复。第二个用例需要检查只读字段检查的路由和工具门控，以及缺少业务字段时的结束行为。

首个完整回执记录耗时约 12.6 秒、Harness 模型调用计数 2、业务工具计数 0；第二个约 8.9 秒、模型计数 6、业务工具计数 3。这些计数来自对应回执，不能当作本轮所有请求（含感知与中止尝试）的总账单。

手动验收的 Notebook 由测试脚本准备，明确不算 Agent 生成成功。后续手动复测复用本轮失败回执，没有为了跑通浏览器检查再次调用模型。

## 证据与复测

- 真实零售 Agent 回执：`.runtime/notebook-existing-2026-09-13T14-45-15-104Z/agent-task.json`。
- 最终手动浏览器验收：`.runtime/notebook-existing-2026-09-13T14-53-27-850Z/report.json`，`manualPassed=true`、`dashboardVisual.passed=false`、总体 `passed=false`。
- 已有导入表真实 Agent：`.runtime/existing-project-check-2026-09-13T14-46-43-828Z/report.json`。
- 已有导入表只读复核：`.runtime/existing-project-check-2026-09-13T14-49-46-793Z/report.json`，`localPassed=true`、总体 `passed=false`。

新增脚本 `scripts/notebook-existing-data-acceptance.mjs` 与 `scripts/notebook-existing-project-check.mjs`。真实调用需显式设置 `EXISTING_DATA_LIVE=1`；亦可分别用 `EXISTING_DATA_AGENT_RECORD` / `EXISTING_PROJECT_AGENT_RECORD` 指向已观察到的本地回执，避免重复调用。复用失败回执仍返回失败，不将手动通过折算为完整通过。脚本不纳入默认离线测试。

前几次运行修正了测试脚本的工作界面选择、SSE 结果读取和失效图表定位；这些不算产品功能通过。其中一次 SSE 回执读取失败导致浏览器请求中止，没有完整模型计量。最终脚本从页面实际持久化的任务结果读取完整回执，并在截图前等待图表尺寸稳定。

本轮未运行全量应用测试、类型检查和构建：没有改动应用实现、依赖或配置；采用真实接口、浏览器、独立数值核对、脚本语法检查及文档维护检查。稳定站未发布或重启，Agent 上述问题保留待修复。
