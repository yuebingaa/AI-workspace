# Notebook 默认文档布局验收 · 2026-09-27

本批回应“没啥变化”的默认浏览截图反馈。上一批成熟编辑器、表格和图表配置保留；本次直接调整打开 Notebook 后的文档布局。源码与 3001 已生效，未发布 3000。

## 实际修改

- `NotebookPanel.tsx`：标题、分析 / 源码切换、设置及运行 / 停止固定在 Notebook 顶部；运行与保存说明集中到设置。默认显示 SQL / Python / 仓库 SQL，数据源默认显示文件、字段数与当前预览行数摘要，按需展开结果。输入标签可定位上游；来源与耗时收入运行详情。
- 新增 `NotebookOutline.tsx`、`NotebookCellMenu.tsx`：大纲只负责导航和聚焦；单元菜单复用已有 Radix Popover，移动 / 删除仍走原业务回调及影响审阅。Escape、取消删除后的焦点返回通过浏览器检查。
- `NotebookResult.tsx`、`NotebookResultTable.tsx`：图表 / 数据本地切换，默认展示图；数据表保留搜索 / 列状态。结果完整性、预览范围和 CSV 范围仍明确可见，详细导出说明折叠。普通 SQL 表格沿用直接展示。
- `app/notebook-workbench.css`：连续文档与细分隔线替代大圆角卡片，单元标题 / 输出名 / 状态并排；操作在悬停、焦点、选中时出现，运行常驻，窄容器及触摸设备保留可见入口。大纲宽 174 px，Notebook 容器不超过 980 px 时隐藏，正文获得更多空间。
- `NotebookCapabilities.test.tsx`、`NotebookResult.test.tsx`：更新菜单入口断言，补充图表视图下不完整、冲突、未知结果的警告验证。新增 `scripts/verify-notebook-document.mjs`，支持改前基线与改后完整浏览验收。

本次未安装依赖，继续复用 CodeMirror 6、TanStack Table 8、Radix 和 Recharts。展示状态不写正式文档或结果指纹。执行 API、能力开关、项目保存、Agent 整稿确认、Dataset 与看板流程保留。

`runningCellIds` 是本次请求涉及的单元集合，当前接口统一返回结果，因此单元现在显示“等待结果”，不再把全部单元同时标成“运行中”。这只是准确表达已有状态，没有实现逐单元进度事件或并行调度。

## 同一夹具的改前 / 改后

两次均使用 3001 的全新浏览器存储、十单元合成销售文档和默认分析视图，没有预设“展开源码”偏好。数据包含 8 个季度、3 个分层、24 行；通过真实 Notebook API 执行十单元。总览真实返回 records = 24、revenue = 194400、cost = 108000。

| 观察项 | 改前 | 改后 |
| --- | --- | --- |
| 标题区域实际高度 | 约 218 px | 82 px，随文档滚动固定 |
| 数据源单元，尚未运行 | 125 px | 77 px 摘要 |
| 数据源单元，已有结果 | 834 px，默认铺开表格 | 77 px，按需展开 |
| 默认 SQL | 需要点击查看 | 直接显示源码与结果 |
| 图表 | 图与数据表同时占据文档 | 默认图，通过标签查看数据 |
| 文档定位 | 连续滚动 | 大纲与输入引用跳转 |

上述尺寸来自同一 1680 px 视口的实际 DOM 测量，不是所有数据 / 标题下的固定高度保证，也不是性能基准。

改前实际截图：[运行前](../../.runtime/notebook-document-20260927/before-1790519278125/01-default-before-run.png)、[已有结果](../../.runtime/notebook-document-20260927/before-1790519278125/02-default-results.png)。[改前机器报告](../../.runtime/notebook-document-20260927/before-1790519278125/report.json)。

## 3001 本批截图验收

以下 11 张最终截图均逐张用 `view_image` 实际打开查看，原图未修改。成功、失败、取消、菜单与窄桌面布局均已检查；没有横向溢出、开发错误覆盖层或操作遮挡。[机器报告](../../.runtime/notebook-document-20260927/after-1790520125730/report.json)为通过，页面错误与禁止请求均为 0。

| 实际截图 | 场景与验收结论 |
| --- | --- |
| [01 默认打开](../../.runtime/notebook-document-20260927/after-1790520125730/01-default-before-run.png) | 数据源摘要、默认 SQL、大纲与紧凑工具栏直接可见 |
| [02 默认结果](../../.runtime/notebook-document-20260927/after-1790520125730/02-default-results.png) | 十单元真实执行成功，SQL 紧接结果，数据源保持摘要 |
| [03 图表](../../.runtime/notebook-document-20260927/after-1790520125730/03-chart-default.png) | 大纲定位图表并聚焦，默认不重复铺开数据表 |
| [04 图表数据](../../.runtime/notebook-document-20260927/after-1790520125730/04-chart-data.png) | 切换到八季度结果表，不重新执行查询 |
| [05 单元菜单](../../.runtime/notebook-document-20260927/after-1790520125730/05-cell-menu.png) | 移动 / 删除收进菜单，Escape 与取消删除恢复焦点，文档未改变 |
| [06 SQL 失败](../../.runtime/notebook-document-20260927/after-1790520125730/06-query-failed.png) | 实际无效字段查询报错；失败及下游过期可见，随后修复重跑成功 |
| [07 等待结果](../../.runtime/notebook-document-20260927/after-1790520125730/07-waiting-results.png) | 明确挂起 HTTP 回执，十单元显示等待结果，顶部停止可用 |
| [08 取消](../../.runtime/notebook-document-20260927/after-1790520125730/08-cancelled.png) | 停止挂起请求后提示取消，控制恢复；随后真实重跑通过 |
| [09 1024 px](../../.runtime/notebook-document-20260927/after-1790520125730/09-default-1024.png) | 隐藏大纲后正文、SQL 与操作可用，无页面横向溢出 |
| [09a 设置](../../.runtime/notebook-document-20260927/after-1790520125730/09a-settings-1024.png) | 1024 px 设置可访问，打开不改变参数执行开关；Escape 关闭并恢复焦点 |
| [10 滚动工具栏](../../.runtime/notebook-document-20260927/after-1790520125730/10-sticky-toolbar.png) | 滚动到文档后部，标题与运行入口仍固定在 Notebook 顶部 |

还实际验证数据源结果展开、输入定位、项目重开后十单元定义保留。浏览器路由只允许自身隔离项目与必要只读接口；没有读取用户项目，没有调用收费模型或外部数据库。取消使用明确挂起回执，不冒充服务器自然超时。

## 原有编辑与 Agent 流程回归

本次重新执行已有 `verify-notebook-workbench.mjs`，七组流程通过，并重新查看本次生成的 12 张截图。使用新的隔离项目与 72 行合成数据，SQL 真实返回 24 季度汇总。[本次机器报告](../../.runtime/notebook-workbench-20260927/browser-1790519997169/report.json)，页面错误与禁止请求均为 0。

| 截图 | 检查 |
| --- | --- |
| [搜索栏](../../.runtime/notebook-workbench-20260927/browser-1790519997169/01a-sql-search-panel.png)、[SQL 编辑](../../.runtime/notebook-workbench-20260927/browser-1790519997169/01-sql-editor-1680.png) | CodeMirror 搜索 / 补全、中文插入 / 撤销；改名期间只读，真实 SQL 成功 |
| [表格筛选 / 列](../../.runtime/notebook-workbench-20260927/browser-1790519997169/02-table-filter-columns-1680.png)、[无匹配](../../.runtime/notebook-workbench-20260927/browser-1790519997169/03-table-no-match.png) | 分页、列宽与显隐；真实 CSV 下载仍包含全部已返回行和列 |
| [图表配置](../../.runtime/notebook-workbench-20260927/browser-1790519997169/04-chart-builder-1680.png)、[缺字段](../../.runtime/notebook-workbench-20260927/browser-1790519997169/05-chart-required-error.png)、[1024 px](../../.runtime/notebook-workbench-20260927/browser-1790519997169/06-chart-builder-1024.png) | 选字段即时预览、校验、取消不保存、保存后运行与窄桌面 |
| [真实 SQL 失败](../../.runtime/notebook-workbench-20260927/browser-1790519997169/07-sql-failure.png)、[取消](../../.runtime/notebook-workbench-20260927/browser-1790519997169/08-run-cancelled.png) | 失败恢复、挂起请求取消，过期数据不冒充成功 |
| [保存后重开](../../.runtime/notebook-workbench-20260927/browser-1790519997169/09-reopened-chart-dataset.png) | Dataset 真实保存、项目重开及图表重跑 |
| [Agent 待确认](../../.runtime/notebook-workbench-20260927/browser-1790519997169/10-agent-pending-confirmation.png)、[撤销](../../.runtime/notebook-workbench-20260927/browser-1790519997169/11-agent-preview-undone.png) | 明确合成的 Agent SSE 驱动真实 SQL 预览；确认才保存，撤销保留先前定义 |

这验证 UI 与现有草稿契约，没有真实模型生成，也不构成实时生成单元、完整 Hex 流程或 marimo 迁移验收。

## 检查结果与边界

- `pnpm exec vitest run components/studio/notebook core/notebook/table-preview.test.ts core/notebook/presentation-table.test.ts --maxWorkers=2 --reporter=dot`：25 文件、420 项通过。[日志](../../.runtime/notebook-document-20260927/targeted-final.log)。最终设置 Escape 处理随后通过真实浏览器及 ESLint 验证。
- 严格 ESLint：本次 8 个 TSX / 测试 / 脚本文件通过，最后设置调整后再次检查 Panel 和验收脚本通过。
- `npm run typecheck`：[最终通过](../../.runtime/notebook-document-20260927/typecheck-final.log)。
- `npm run build`：[通过](../../.runtime/notebook-document-20260927/build.log)，保留既有大 chunk 提示，没有据此宣称包体或性能提升。
- 更新[架构正文及变更记录](../architecture/agent-architecture.md)和[当前视觉规范](../visual-design.md)，执行 `docs:agent:sync` / `docs:agent:check`，245 个源码文件通过；源码指纹不替代上述行为与视觉验证。
- 第一轮旧测试要求直接显示删除按钮，按菜单入口调整断言后通过；早期验收脚本的项目状态等待与同源请求头按实际 API 规则修正。中途独立 DSH 工作产生的短暂编译 / 测试类型错误由该任务修复，本批未修改其实现；保留失败日志，不计作本批修复。修正后重新执行最终浏览器 / 类型检查。
- 本次未重跑全量 `npm test`：变更集中于 Notebook 展示，已覆盖其全部组件定向测试与上述浏览器回归；不引用上一批或并行任务的全量结果作为本次完成。未跑全仓 lint、真实模型 / 远程数据库、网站原生 Python、手机端或性能基准。
- 三个受管服务起止健康，无本次启停、发布或便携包更新；源码 / 3001 有效，稳定站 3000 保持原独立构建。未提交、推送或更改用户数据。单元增量生成、实时结果流、查询缓存和并行调度仍未在本批实施。
