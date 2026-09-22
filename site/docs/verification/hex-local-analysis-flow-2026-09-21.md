# M7 首批：本地 CSV 分析闭环验收

日期：2026-09-21。状态：本批分层验收完成，未发布 3000。首次上传存在下述脚本失败与分段恢复，不能称为单次完整 UI 导入通过。

## 冻结范围

本批进入已实现能力的整体验收，不扩展新的 Cell、连接或模型能力：

1. 在 3001 通过手工界面完成合成 CSV 导入、Data / 数字参数 / SQL / 表格 / 图表创建与真实计算。
2. 核对参数修改、失败不覆盖已有结果、看板快照取消 / 确认 / 撤销，以及项目保存重开后不自动执行。
3. 用固定模型替身验证 Agent 通过真实工具和本地 SQL 完成同类分析，保持草稿采用与上下文边界；不调用真实模型或外部数据库。
4. 仅修复上述路径内预期明确、可测试的缺陷。保留现有模块、API、存储与确认机制，不借验收搬动大量源码。

新截图使用已核对归属的隔离合成项目，保留原资源和所有已有定义；项目登记已到上限，不清理登记、不提升限额。新增内容严格限制在本批专用页、Notebook、合成 CSV 与必要结果快照中。复跑与边界以实际脚本和最终报告为准，不宣称每次都重新导入或创建。

## 本批外与后续验收

合成 Excel、EDS、语义模型及只读数据库的纵向回归，以及最终交付 / 替换说明仍分别验收。未知单元可编辑打开、任意未来格式、全部适配代码卸载、实时发布 App、真实模型生成质量不是本批完成条件；不因进入 M7 而抹去 M2–M6 已记录的保留项。

## 实际模块与边界

本包新增回归，不更换技术栈、不新增生产接口或包装层：

- `core/harness/server/notebook-continuity.integration.test.ts`：从 CSV 解析和内存 Dataset 仓库进入真实 Harness / Notebook 工具；通过现有 `HarnessModel` 端口注入固定决策，SQL 由本地运行时实际计算。
- `scripts/verify-local-analysis-flow.mjs`：固定隔离项目上的手工浏览器验收。仅创建本批页 / Notebook、一个 CSV 与最多两个结果快照；保留历史项目内容。
- 架构正文与路线图同步本批证据归属和 M6 有限范围收尾，不把分包结果冒充 M7 全项完成。

Agent 测试首轮生成 SQL / 表 / 图并得到 East 150、South 80，显式调用现有 `adoptNotebookDraft` 后，第二轮重新运行得到 East 300、South 160。两轮 `runId` 不同，原步骤、请求、正式 AppSpec 与原数据不变；第二稿仍待采用，过期 revision 拒绝采用。相同会话的历史确实进入模型上下文，新会话不继承，历史不作为新工具证据。

测试 CSV 额外包含三个合成敏感值，以真实经过 pending 拒绝及 masked 授权；上下文 / 回执 / 结果检查不含原值。手工 CSV 不含敏感列。网络被拒绝且调用数为零；这不是实际供应商模型的规划质量或可靠性评测。

## 验证记录

| 检查 | 本次实际结果 |
| --- | --- |
| 修改前 `npm test -- --maxWorkers=2` | 235 文件、2,495 应用 + 26 Node 通过；原 1 文件 / 3 项跳过保留 |
| 最终 `npm test -- --maxWorkers=2` | 236 文件、2,497 应用 + 26 Node 通过；原 1 文件 / 3 项跳过未增加 |
| 新集成 + 相邻工具 / Notebook / SSE / 会话仓库回归 | 5 文件 / 30 项通过；其中新增 2 项合计 4 次真实本地 Notebook 执行 |
| `npm run test:eval` | 25 项通过，包含既有 11 个固定离线场景 |
| `npm run typecheck` | 最终通过；初次恰遇新增测试编辑中的两项类型错误，已修复，非原有失败 |
| 新测试严格 ESLint | 通过，不放宽断言、类型或忽略规则 |
| `npm run build` | 通过；保留已有客户端 chunk 体积提示，不发布或启动构建产物 |
| 架构守卫 / 指纹 / 检查器 | 32 项模块边界、167 文件同步 / 检查、检查器 1 项通过；仅测试变化不改变生产源码指纹 |

首次新测试失败是固定指令未明确指定增量单元编辑，现有路由选择了整稿计划工具；测试改成明确“检查现有单元并添加单元”，据实验证增量路径，没有修改产品意图路由。中途类型检查暴露测试的类型导入和可选 trace 两项问题，修正为所属契约导入及保留四项严格状态断言；完整重跑后通过。不把测试自身修正记成产品 Bug 修复。

浏览器脚本最终 `node --check scripts/verify-local-analysis-flow.mjs` 及脚本 / 新测试严格 ESLint 均通过。日志前缀为 `.runtime/m7-local-flow-`；服务与数据资源仅使用本机隔离测试目标。

## 3001 浏览器证据

命令：`node scripts/verify-local-analysis-flow.mjs`。最终[第六轮报告](../../.runtime/hex-local-analysis-flow-2026-09-21/browser-1789983948538/report.json)包含 9 个场景记录、9 张新图、8 次真实 Notebook HTTP 执行（其中 2 次保存快照），`lifecycleCompleted=true`，console / page / route / 禁止请求均为零。已有页、CSV 与五个 Cell 的七项首次创建操作明确标为复用 / 跳过；编辑、执行与快照后半链实际完成，不能把 skipped 当作本轮首次创建证明。

| 场景 | 实际结论与截图 |
| --- | --- |
| 五类单元真实结果 | Data / 数字参数 / SQL / 表 / 图共五步，实际本地 SQL 得到 150 / 80；[结果图](../../.runtime/hex-local-analysis-flow-2026-09-21/browser-1789983948538/02-five-cells-real-results-1440.png) |
| 参数与失效 | 金额下限由 0 改 100，先标失效且请求数不增；显式运行后只剩 East=100，不伪造 South=0；[1024 图](../../.runtime/hex-local-analysis-flow-2026-09-21/browser-1789983948538/03-parameter-explicit-rerun-1024.png) |
| 快照预览 / 取消 | 实际保存表快照，预览可查本次来源；取消保持正式看板空白、结果表留存；[预览](../../.runtime/hex-local-analysis-flow-2026-09-21/browser-1789983948538/04-table-preview-unconfirmed-1440.png)、[取消](../../.runtime/hex-local-analysis-flow-2026-09-21/browser-1789983948538/05-cancel-keeps-blank-dashboard-1440.png) |
| 确认图快照 | 第二份真实快照绑定独立 Dataset，正式图为 150 / 80；[确认](../../.runtime/hex-local-analysis-flow-2026-09-21/browser-1789983948538/06-confirmed-persistent-chart-1440.png) |
| 真实 SQL 失败 | 查询不存在字段，SQL 失败、表 / 图阻断；旧正式看板和快照表不变，随后恢复合法 SQL；[失败](../../.runtime/hex-local-analysis-flow-2026-09-21/browser-1789983948538/07-real-sql-failure-1440.png) |
| 刷新与显式重开 | 清空瞬时结果；新标签从项目入口重新打开同一目录 / 句柄，五定义与 150 / 80 快照保持，零自动运行；[刷新](../../.runtime/hex-local-analysis-flow-2026-09-21/browser-1789983948538/08-refresh-no-automatic-execution-1024.png)、[重开图](../../.runtime/hex-local-analysis-flow-2026-09-21/browser-1789983948538/09-new-tab-reopens-saved-chart-1024.png) |
| 最后撤销 | 只撤销本批图表 ChangeSet，原 CSV、两份结果表和五步定义保留，存在 undone 审计；[最终空看板](../../.runtime/hex-local-analysis-flow-2026-09-21/browser-1789983948538/10-final-undo-retains-data-1024.png) |

最终图实际逐张查看；主代理另复核参数、确认图、SQL 失败、重开和撤销五图。界面保持原暖白 / 灰阶规则，不做视觉改版。1024 输入框辅助说明仍会换行，未据此扩展本批范围。

### 五轮前置失败与证据归属

所有失败报告保留，不删除测试、不放宽业务断言。它们是验收脚本对当前接口 / 交互的假设问题，没有修改产品逻辑：

1. [第一轮](../../.runtime/hex-local-analysis-flow-2026-09-21/browser-1789983558498/report.json)：UI 实际选择 CSV 并通过真实 `/api/datasets` 保存数据表，但脚本漏放行 `/api/projects/files`，原件保存被拦。仅有[选择文件截图](../../.runtime/hex-local-analysis-flow-2026-09-21/browser-1789983558498/01-csv-import-ready-1440.png)和失败证据，不是完整上传成功。
2. [第二轮](../../.runtime/hex-local-analysis-flow-2026-09-21/browser-1789983681428/report.json)：通过严格固定句柄 / 文件名 / 原字节 / Dataset ID 的实际原件 API 补存同一 CSV，不重建表；重开时读取已导航 POST 正文失败，改为核对 POST 状态和实际 scoped GET。原件保存是明确的测试恢复，不冒充 UI 重试。
3. [第三轮](../../.runtime/hex-local-analysis-flow-2026-09-21/browser-1789983727508/report.json)：真实编辑器创建 Data / 参数 / SQL；创建表前未运行上游，产品按现有规则提示先执行。改为先实际运行 SQL 获取字段，再建表 / 图。
4. [第四轮](../../.runtime/hex-local-analysis-flow-2026-09-21/browser-1789983845099/report.json)：已创建余下单元并运行、验证参数 100 的结果；1024 下保存状态文案被响应式隐藏，脚本 `innerText` 等待错误。改为读取 DOM 状态文本并继续核对磁盘版本 / 精确保存内容，没有放弃落盘断言。
5. [第五轮](../../.runtime/hex-local-analysis-flow-2026-09-21/browser-1789983920021/report.json)：复用 SQL 编辑定位误匹配下游引用标签，改为准确的单元可访问名称，不使用随意的 `first()` 消除歧义。

本批组合证据证明真实 CSV 数据进入计算链、原件可按现有 API 保存、手工五单元及后续生命周期可用；**完整成功的单次 UI 上传与完整浏览器 Agent 生成 / 采用 / 重开 / 追问链仍需后续补测**。本包不以 API 恢复与核心 Agent 测试替代上述浏览器验收。

## 资源保护与交付状态

复用固定、已核验 SHA 的合成项目，不登记新项目、不提额度、不清理旧文件。基线 revision 127 / 37 表 / 15 原件 / 16 页；本批最终 revision 155 / 40 表 / 16 原件 / 17 页，只新增一个页 / Notebook、一个 CSV 表 / 原件、两份快照。原 52 个文件的字节 / SHA 与所有旧页、Notebook、模型、资源描述保持；100 条项目登记只允许既有条目排序变化。每轮备份起始 manifest，最终保护以独立实际校验结果记录，不从主失败字符串推断成功。

无用户文件删除；最后只撤销本批图表，未移除 CSV 或结果表。没有新依赖、API、模型、权限、持久化格式或生产代码变更。分支 `feature/eds-analysis-dashboard`，继承的未提交修改保留，本批不提交 / 推送 / 合并 / 切分支。

收尾 `npm run site:status` 三服务健康，PID / worker / revision / startedAt / restarts 和稳定 release 与本批开场一致；无启停、重启或发布。只验收 3001，不代表 3000 已启用。本包未验证真实模型、外部数据库、Python、系统重启或新电脑；不新增完整长期记忆、动态 App 或未知 Cell 可编辑能力。

## 工作记录

- 已读取协作与完整运行约定、近期日志、路线图与相关架构 / 视觉规则，并核对现有项目、参数、快照及上下文验收脚本。
- 本批开始时 3000 / 3001 / 3198 健康，未启停、重启或发布。
- 已完成基线与最终回归、独立测试 / 脚本审阅、固定模型真实工具对照及分轮浏览器验证；没有发现未处理的本次新增产品回归，未验证项与失败来源见上文。
