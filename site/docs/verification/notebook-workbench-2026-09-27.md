# Notebook 成熟组件与交互改造验收

日期：2026-09-27。用户授权优先使用成熟组件改善 Notebook。当前网站已经接入代码编辑、交互表格和字段选择组件；独立 marimo 样板只验证了原生运行与编辑器打开，尚未接入网站。以下记录本批实际工作，不将此前研究建议、其他并行任务或目标参考图作为本批完成结果。

## 实现与模块边界

| 模块 | 本次实现 | 文件 |
| --- | --- | --- |
| 代码编辑 | CodeMirror 6 的 SQL / Python / JSON 语法、行号、折叠、搜索替换、撤销和补全；SQL 只提供已选上游表字段；保留长度与禁用约束 | `components/ui/code-editor.tsx`、`components/studio/notebook/NotebookSource.tsx`、`NotebookCellEditor.tsx` |
| 结果表格 | TanStack Table 8 的当前预览搜索、分页、列显隐及列宽，Radix 列设置弹层；保留自有字段读取、原排序及 CSV 完整性校验 | `components/studio/notebook/NotebookResultTable.tsx`、`NotebookResult.test.tsx` |
| 图表配置 | 独立配置组件，复用 Radix/cmdk 的 SearchSelect 与 Recharts；左侧选类型和字段，右侧即时预览；分类与最多四个数值字段，五种原有图表类型 | `components/studio/notebook/NotebookChartEditor.tsx`、`NotebookCellEditor.tsx` |
| 页面组织 | 代码编辑与结果上下排列，图表编辑时由独立面板接管预览；运行设置收入折叠区，默认行为不变；暖白、黑白灰与现有视觉变量 | `components/studio/notebook/NotebookPanel.tsx`、`app/notebook-workbench.css`、`app/layout.tsx` |
| 依赖 | `codemirror@6.0.2`、`@codemirror/state@6.7.6`、`view@6.43.13`、`autocomplete@6.20.3`、`lang-sql@6.10.0`、`lang-python@6.2.1`、`lang-json@6.0.2`、`@tanstack/react-table@8.21.3`；复用已有 Radix/cmdk/Recharts | `package.json`、`pnpm-lock.yaml` |
| 可重跑验收 | 3001 隔离项目真实 SQL / 保存 / 草稿交互；原生 marimo 独立样板及临时进程验收 | `scripts/verify-notebook-workbench.mjs`、`scripts/verify-marimo-notebook-pilot.mjs`、`scripts/fixtures/marimo-notebook-pilot.py` |

CodeMirror 仅持有编辑选择与撤销历史，保存文本仍由单元草稿持有；确认改名时显式只读，不能依赖 fieldset 自动禁用 contenteditable。TanStack 的可变表格对象全部留在禁用 React Compiler 自动记忆的适配组件内；没有通过移除领域校验来接入组件。实现参考：[CodeMirror 扩展](https://codemirror.net/docs/extensions/)、[动态配置](https://codemirror.net/examples/config/)、[TanStack React 适配](https://tanstack.com/table/v8/docs/framework/react/react-table)、[React Compiler 兼容说明](https://tanstack.com/table/latest/docs/framework/react/guide/react-compiler)。

图表草稿只消费当前有效上游字段及新鲜结果，沿用 `projectPresentationTable` 验证。预览标明未保存、最多绘制前 100 行，不调用执行器、不写缓存、不生成成功回执；取消丢弃配置，保存后需要实际运行。没有上游结果时保留手动字段兼容入口。CSV 仍导出当前已返回预览的全部行和全部列，保留排序；搜索 / 隐藏列不会裁剪导出或改变 Dataset，界面直接说明该范围。

正式 Notebook 定义、revision、执行器、数据连接、Agent SSE / 工具及整体确认 / 撤销规则没有更换。只读源码 / 差异展示仍使用现有组件。本批没有实现按分类字段分系列、堆叠、分面、拖动字段或逐单元 Agent 确认。

## 3001 实际浏览器验收

脚本 `node scripts/verify-notebook-workbench.mjs` 最终通过；[机器报告](../../.runtime/notebook-workbench-20260927/browser-1790517306398/report.json)。使用全新浏览器存储及脚本创建的隔离项目，导入 72 行合成销售数据，真实本地 SQL 汇总为 24 个季度；首行 revenue 5,400、cost 3,000、accounts 3。只允许验收项目路径，未读取用户项目或调用外部数据库 / 收费模型。7 组场景完成，0 页面错误、0 禁止请求。

Agent 两轮输出通过明确的合成 SSE 提供，页面使用实际官方 DSH 会话组件，并调用真实 Notebook SQL 预览接口。首轮确认将面积图保存为折线图；第二轮柱状图建议被撤销，保存定义仍为折线图。这证明网页草稿审阅与真实执行 / 保存衔接，不证明真实模型生成质量。运行取消场景为故意挂起 HTTP 请求后取消，不将其当作服务器长查询已中断的证明。

以下 12 张都是本轮最终代码在 3001 生成的实际截图，已逐张通过 `view_image` 查看；没有用 Hex 图片、设计稿或早期截图替代。1680 / 1024 px 没有页面横向溢出，字段选择、预览及主要操作可见。

| 页面 / 场景 | 本次截图 | 验收结论 |
| --- | --- | --- |
| SQL 搜索替换 | [搜索栏](../../.runtime/notebook-workbench-20260927/browser-1790517306398/01a-sql-search-panel.png) | 中文提示与复选框排列正常，不再受原表单 label 样式撑开 |
| SQL 编辑 | [编辑器](../../.runtime/notebook-workbench-20260927/browser-1790517306398/01-sql-editor-1680.png) | 行号、语法着色、中文注释插入 / 撤销、选中上游表补全；改名确认期间编辑器只读 |
| 结果表搜索与列设置 | [表格操作](../../.runtime/notebook-workbench-20260927/browser-1790517306398/02-table-filter-columns-1680.png) | 搜索匹配 1 / 24 行，显示 3 / 4 列；实际下载 CSV 仍含 24 行数据和全部字段；另检查两页分页、键盘调整列宽及重置 |
| 结果表无匹配 | [空搜索](../../.runtime/notebook-workbench-20260927/browser-1790517306398/03-table-no-match.png) | 空状态与清除入口可见，原数据未被修改 |
| 图表字段与预览 | [图表配置](../../.runtime/notebook-workbench-20260927/browser-1790517306398/04-chart-builder-1680.png) | 字段可搜索，两个数值系列即时绘制；取消配置不写入文档，保存后实际执行成功 |
| 图表缺少数值字段 | [校验失败](../../.runtime/notebook-workbench-20260927/browser-1790517306398/05-chart-required-error.png) | 保存被拒绝，友好提示可见，草稿保留可继续修改 |
| 最小桌面宽度 | [1024 px 图表配置](../../.runtime/notebook-workbench-20260927/browser-1790517306398/06-chart-builder-1024.png) | 字段区与预览可用，未新增手机端支持承诺 |
| 实际 SQL 失败 | [失败状态](../../.runtime/notebook-workbench-20260927/browser-1790517306398/07-sql-failure.png) | 无效列导致真实失败，下游没有将旧表格当成新成功；恢复正确 SQL 后运行通过 |
| 挂起请求取消 | [取消状态](../../.runtime/notebook-workbench-20260927/browser-1790517306398/08-run-cancelled.png) | 取消反馈及控件恢复；请求挂起为明确验收夹具 |
| 保存并重开 | [重开项目](../../.runtime/notebook-workbench-20260927/browser-1790517306398/09-reopened-chart-dataset.png) | Dataset 通过原真实接口保存；刷新同一项目后 SQL / 图表可重跑 |
| Agent 草稿待确认 | [待确认预览](../../.runtime/notebook-workbench-20260927/browser-1790517306398/10-agent-pending-confirmation.png) | 合成建议触发真实 SQL 预览，正式定义在确认前不变 |
| 第二轮撤销 | [撤销后](../../.runtime/notebook-workbench-20260927/browser-1790517306398/11-agent-preview-undone.png) | 第二轮建议撤销，第一轮已确认的折线图与文档仍保留 |

## marimo 独立试跑与路线决定

`node scripts/verify-marimo-notebook-pilot.mjs` 使用 uv 隔离环境、Python 3.12 与固定 `marimo 0.25.0 / pandas 2.3.3 / duckdb 1.4.2 / altair 5.5.0 / pyarrow 23.0.1 / sqlglot 30.19.0`。样板包含 12 行合成销售数据、最低销售额参数、SQL 季度聚合与面积图。脚本实际计算得到四行季度合计 `[59000, 118000, 177000, 236000]`，合计 590,000；浏览器实际打开编辑器并捕获 [1440 px 截图](../../.runtime/marimo-notebook-pilot-20260927/browser-1790517149013/01-marimo-editor.png)，已实际查看；[机器报告](../../.runtime/marimo-notebook-pilot-20260927/browser-1790517149013/report.json)。

此图显示编辑器和单元源码，不用它冒充浏览器运行全部单元或参数响应式往返验收；计算结论来自独立脚本执行。没有适配现有项目、DSH、数据库连接、Dataset / 看板或旧文档迁移。临时回环服务端口为 57588，验收后已结束自己的进程树，不占网站固定端口、不进入网站生产依赖。此前建议的完整迁移样板仍未完成，不能据这次基础试跑判定 marimo 不可用或全面迁移已经验证。

本批采用局部成熟组件作为网站交付范围，先让当前业务链获得可用改善；marimo 保留独立评估入口。尚未估计全面迁移成本、上游改动量或两种路线的性能差异。

## 测试、修正与发布状态

- Notebook 定向 `pnpm exec vitest run components/studio/notebook core/notebook/table-preview.test.ts core/notebook/presentation-table.test.ts --maxWorkers=2 --reporter=dot`：25 文件 417 项通过。
- 最终 `npm test -- --maxWorkers=2 --reporter=dot`：282 文件 3,588 项通过；1 文件 3 项既有 EDS 实物测试因缺工作簿路径跳过；随后 26 项 Node 工具测试通过。[本批完整日志](../../.runtime/notebook-workbench-20260927/tests.log)。这是本批实际重跑的共享工作区测试，不能将其中并行 DSH 功能计为本批实现。
- `npm run typecheck` 通过；9 个本批 TSX / JS 文件严格 ESLint 通过，包括两个验收脚本、CodeEditor、ChartEditor、CellEditor、Source、Panel、ResultTable 与 Result 测试。未跑全仓 lint。
- `npm run build` 通过并产生 standalone 输出；[本批构建日志](../../.runtime/notebook-workbench-20260927/build.log)。仍有大于 500 kB chunk 和插件耗时提示；本批未测量加载速度或包体优化收益。
- [唯一架构文档](../architecture/agent-architecture.md)正文 / 变更记录与[视觉规范](../visual-design.md)同步，`docs:agent:sync` / `docs:agent:check` 为 240 文件指纹一致。
- 初轮专项测试仅旧结果标题精确断言失败，按实际新增的搜索 / 排序范围文案更新后通过；首轮浏览器脚本遗漏已有的输出改名确认，补完整交互后重跑；视觉复核发现 CodeMirror 搜索栏被旧表单样式影响，修正 CSS 后重新生成并查看全部最终截图。首次类型检查碰到并行设置文件更新中的导出不一致，后续实际重跑通过，未擅自改其代码。
- marimo 首轮样板声明语法及缺失 sqlglot 依赖修正后重跑通过；首次辅助服务退出遗留自己创建的 Python 子进程，经父进程 / 创建时间核对后结束该子进程，验收脚本改为仅按所持有 PID 清理自己的进程树；最终脚本正常退出。
- 起止 `npm run site:status` 均健康：稳定站 PID 17416 / worker 17248，开发站 PID 10076 / worker 7712，截图服务 PID 17576 / worker 17464，重启计数均为 0。未启停这三个服务，未发布 3000、生成新便携包、提交或推送。

源码及 3001 已生效。未做真实 Windows 中文输入法组合输入专项、收费模型 / 实库联调、手机端、网站原生 Python 执行、查询缓存 / 并行调度改造或性能基准；自动化中文插入 / 撤销不等同于完整输入法验证。共享工作区原有修改保留，任务日志只将上述本批文件修改与实际验证计入本次交付。
