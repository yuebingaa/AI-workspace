---
name: data-visualization
description: 为 DataCanvas Harness 选择、生成、修改和校验数据图表。用于看板、趋势、分类比较、组成占比、图表类型与图表样式请求。
metadata:
  version: "1.0.0"
  runtime: datacanvas-harness
  source-openai: https://github.com/openai/role-specific-plugins/tree/main/plugins/data-analytics/skills/visualize-data
  source-anthropic: https://github.com/anthropics/claude-tag-plugins/tree/main/claude-tag-data-viz/skills/graphing
---

# 数据可视化

为用户的问题选择最简单、可读且不误导的图表，并通过当前 Harness 的受控工具生成待确认预览。

## 工作方式

1. 先明确分析问题、指标、分类或时间维度，以及图表要表达的一句话结论。
2. 当前网页交互图只允许 `bar`、`line`、`area`、`pie`、`donut`。只有工具 Schema 明确开放的类型才可生成。
3. EDS 看板优先使用 `createEdsBreakdownChartPreview` 或 `createEdsLineIssueChartPreview`，让服务端生成日期、班次、视图、线体、排序和格式绑定。
4. 修改已有图表时使用受控属性更新；新增图表时使用唯一节点 ID。所有页面写操作只能生成 ChangeSet 预览，等待用户确认。
5. 生成后核对标题、单位、排序、真实数据绑定、标签可读性、颜色语义和窄屏布局。

## 边界

- 不编造字段、数值、筛选条件或组件能力。
- 不把少量数据强行画成复杂图，也不为了图表多样性牺牲可读性。
- 饼图和环形图只接受非负组成数据；分类很多时优先排序柱状图或明确的 Top N。
- 暂不支持的图表类型应说明能力边界，并在不改变用户分析目标时建议最接近的已支持类型。
- Matplotlib 只用于用户明确要求的 PNG/SVG 静态导出，不替代网页中的 Recharts 交互图。

需要选择具体图表或执行 QA 时，读取 [references/chart-selection.md](references/chart-selection.md)。
