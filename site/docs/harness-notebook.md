# Harness Analysis Planner 与 Notebook 协议

Harness 会先把明确的分析目标编译成经过校验的 Analysis Plan，再根据同一计划生成 Notebook 草稿。两种产物都属于单次任务结果，不会修改正式 `AppSpec`。

## 执行链路

完整 Notebook 请求的工具顺序为：

```text
createAnalysisPlan -> createNotebookDraft -> notebookRunner -> Verifier -> 等待用户采用
```

如果用户明确只要分析方案、暂时不要 Notebook，Harness 只调用 `createAnalysisPlan`，通过 Verifier 后直接完成任务。

`createAnalysisPlan` 和 `createNotebookDraft` 都是 `readOnly` 工具。计划存放在单次 Harness 任务的内存中；Notebook 草稿必须携带该任务生成的 `analysisPlanId`，并保持计划中的步骤 ID、类型、顺序、依赖、数据源、语义模型版本和展示配置。这样可以防止模型在规划后悄悄改口径。

## Analysis Plan 产物

成功任务会在 `task.analysisPlanArtifact` 返回计划，其中包含：

- 分析目标和待回答问题；
- 有序步骤及步骤依赖；
- 表格、图表和叙述等交付物；
- 数据源 ID；
- 语义查询使用的模型 ID 和版本；
- 明确写出的假设。

计划支持以下步骤：

| `kind` | 作用 | 是否产生表格数据 |
| --- | --- | --- |
| `data` | 引用当前工作界面的数据源 | 是 |
| `semanticQuery` | 按选中的语义模型和版本定义查询口径 | 是 |
| `sql` | 描述后续 SQL 转换目标 | 是 |
| `table` | 声明要展示的上游字段 | 否 |
| `chart` | 声明图表类型、分类字段和数值字段 | 否 |
| `text` | 声明分析说明的目标 | 否 |

Analysis Plan 的 SQL 步骤只保存 `transformation`，例如“按 region 分组并将 amount 求和为 revenue”。实际 SQL 由后续 Notebook 草稿提供，并在编译时校验依赖和执行结果。

## Notebook 草稿

成功的 Notebook 任务会在 `task.notebookArtifact` 返回草稿。Notebook 支持 `data`、`semanticQuery`、`sql`、`table`、`chart` 和 `text` 单元，并保存稳定的 `executionOrder`、`lineage`、`sourceDataSourceIds` 和 `analysisPlanId`。

服务端会校验：

- 步骤和单元 ID 不重复；
- 依赖只能引用排在前面的表格输出；
- 数据源属于当前工作界面；
- 语义模型及版本与本次请求一致；
- 维度、指标、表格字段和图表字段真实存在；
- Notebook 与 Analysis Plan 的步骤数量、顺序和依赖一致；
- Notebook 至少包含一个 `data` 单元。

当调用方提供 `notebookRunner` 时，Harness 会在交付草稿前试运行 Notebook。当前本地执行器使用 DuckDB 执行基于 Dataframe 的只读 `SELECT` / `WITH` SQL，并将完成的单元、行列统计和错误写入 `executionEvidence`。Python 单元还没有进入当前协议。

## UI 接入边界

Notebook 页面可以读取 `task.analysisPlanArtifact` 显示目标、问题和执行步骤，再读取 `task.notebookArtifact` 渲染 Cell、血缘和试运行结果。用户采用草稿后，才由 Notebook 自己的持久化流程保存文档。

Harness 不会自动把这些产物写入浏览器工作区、发布页面或正式 `AppSpec`。本次协议实现也不包含页面改动。