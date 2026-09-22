# Hex 第七批：完整结果保存与有限预览

日期：2026-09-16。选定范围：M3 请求内完整结果交付、Dataset / 看板保存接线及预览完整性展示。源码、离线 / 实库兼容及 3001 浏览器验收完成；3000 未发布。

## 问题、基线与范围

执行器原本已把完整表保留在当前请求供下游计算，但 Data 仅返回 100 行、其他单元 1,000 行展示预览。API 和 UI 均根据预览的 `table.truncated` 拒绝保存，误伤了已经计算完整的 Python / DataRecipe 结果。新增 API 红测实际得到 400（1 失败、9 通过），证明 1,324 行完整结果不能保存，不是只做文件搬迁。

开始时分支 `feature/eds-analysis-dashboard`、HEAD `df5bbae`，保留前六批和既有未提交修改。修改前实际执行 `npm test -- --reporter=dot --maxWorkers=2`：156 文件 / 1,444 项应用通过，1 文件 / 3 项既有跳过，另 14 项 Node 通过。日志在 `.runtime/hex-result-access-2026-09-16/tests-baseline.log`。已有 3000 / 3001 / 3198 健康，无启停或发布。

只解决预览和完整结果在本次保存中的边界。保留 API / wire / 存储格式、权限、原运行预算、看板确认与手动重算；不实现全局缓存、持久结果句柄、远端完整分页、参数、自动重算或新模型。

## 实际模块与改动

```text
core/notebook/
  result-access.ts                 # 新增纯完整表发布端口
  result-availability.ts           # 新增纯完整性 / 预览数 / 保存可用性判断
  execution-contracts.ts           # 可选 publishResult 依赖
  server/runtime.ts               # 接线，可不提供
  server/execution.ts             # 成功、清理和取消复查后交付目标完整表
  server/result-capture.ts         # 单请求保存缓冲、引用匹配、复制和释放
  result-availability.test.ts
  server/result-capture.test.ts
  server/result-publication.test.ts
app/api/notebook/run/route.ts      # 保存读取本次完整表，finally 释放
app/api/notebook/run/route.test.ts # 实际 Python / DataRecipe 全量保存及限制回归
components/studio/notebook/
  NotebookPanel.tsx               # 独立运行身份与统一保存按钮判断
  NotebookResult.tsx              # 完整结果 / 当前预览 / 本地分页说明
  NotebookResult.test.tsx         # 结果范围展示回归
core/architecture/module-boundaries.test.ts # 新端口独立、执行器不依赖捕获实现
scripts/verify-result-access.mjs   # 新隔离项目真实 HTTP / 浏览器验收
scripts/fixtures/result-access.mjs # 1,324 行合成输入及独立预期
```

没有移动 / 删除旧源码、变更锁文件、增加依赖或迁移数据。通用表仍由 Dataset 维护；SQL、模型、Harness 和 Dashboard 原适配入口继续复用。

## 关键行为与边界

- `NotebookResultPublisher` 是同步可选端口；执行器仅发布显式目标的完整表，整条目标链成功、回执校验及 Python close 成功、取消复查通过才交付。未注入的普通运行 / Harness 不增加保存捕获预算。
- `createNotebookResultCapture` 属于单个已授权请求，绑定 cell / revision / 人工或 AI 模式，完整规范化引用匹配当前 run；一次赋值、写入和读取隔离、取消 / 释放后拒绝，50,000 行及 UTF-8 4 MiB 上限。不是多用户权限系统，引用不是 bearer token，也没有按字符串 ID 全局查表入口。
- 保存仍重新执行目标及祖先；API 从 capture 读取完整表，保持 CSV 描述创建后恢复类型、敏感字段继承、项目保存和来源。整体响应仍限制 4 MiB，看板仍最多 500 行；空结果、真正被 SQL 查询上限截断的结果继续拒绝，失败不新增 Dataset。
- 普通 run 仍返回有限预览；显式保存沿用原响应中的有界完整 `snapshot.rows`，并非零传输的持久句柄。大表仍在单请求内物化，不宣称无限数据、磁盘溢写或流式全量支持。
- UI 通过 enclosing run 的独立 runId / revision / accessMode 与 cell 引用核对。完整 1,324 / 预览 1,000 可保存为 Dataset，但不能超过看板 500 行；Data 本身按钮仍禁用。无引用的旧非截断结果兼容，有引用但矛盾则拒绝猜测；本地分页只翻已有预览。
- Agent 策略、模型供应商、SQL 驱动、工具名称 / 参数、看板确认均未改变。将来更换请求内保存实现主要替换 capture 适配与 API 组装；持久仓库需要另行定义项目授权、有效期、分页与回收，不能直接把 resultId 当下载凭证。

## 验证记录

| 本次实际命令 | 结果 |
| --- | --- |
| 修改前 `npm test -- --reporter=dot --maxWorkers=2` | 1,444 项应用 + 14 项 Node 通过，3 项既有跳过 |
| 最终同一全量命令 | 160 文件 / 1,508 项应用通过，1 文件 / 3 项既有跳过；另 14 项 Node 通过，exit 0 |
| `npm run typecheck -- --incremental false` | 官方 typegen + tsc 通过，exit 0 |
| `node node_modules/eslint/bin/eslint.js <本批 17 个源代码 / 测试 / 脚本文件> --max-warnings=0` | 通过；不是全仓 lint |
| `npm run build` | 通过，exit 0；既有大 chunk 提示保留 |
| `node --check scripts/verify-result-access.mjs` 及 `scripts/fixtures/result-access.mjs` | 两脚本通过 |
| `npm run docs:agent:sync` / `check` / `test` | 正文及变更记录已维护，140 文件指纹一致，检查器 1 项通过 |
| `git -c core.safecrlf=false diff --check` | 通过；本批新文件另检查 UTF-8 / 尾空白 / 最终换行 |

新增 64 项：捕获 23、执行发布 12、可用性 20、结果展示 4、API 4、架构边界 1。API、可用性 / 展示、捕获先复现失败后通过；执行发布测试在接线后编写，不将全部新增测试描述为先红后绿。API 用真实 Python 创建 1,324 行并保存末行，字符串 `001` 与 NULL 不变；真实 DuckDB 超限拒绝。执行替身覆盖 Python close 失败、关闭期间取消、日志 / Schema 失败、迟到结果、AI 脱敏及普通运行不受保存捕获 4 MiB 限制影响。引用身份、请求间隔离、释放、50,000 行及 UTF-8 字节数均有断言。

本批日志：[基线](../../.runtime/hex-result-access-2026-09-16/tests-baseline.log)、[API 红测](../../.runtime/hex-result-access-2026-09-16/api-red.log)、[首次 API 绿测](../../.runtime/hex-result-access-2026-09-16/api-green.log)、[最终全量](../../.runtime/hex-result-access-2026-09-16/tests-final.log)、[类型](../../.runtime/hex-result-access-2026-09-16/typecheck-final.log)、[严格代码检查](../../.runtime/hex-result-access-2026-09-16/lint.log)、[构建](../../.runtime/hex-result-access-2026-09-16/build.log)。Windows PowerShell 对构建 stderr 的大 chunk 警告附带 `NativeCommandError` 格式，但实际 exit 0、构建阶段完成；没有忽略真正构建失败。

### 原数据库链路兼容

完整重读 `scripts/test-database/README.md`、验收及共享脚本，确认既有 v3 隔离库归属 / 状态后运行：

`node scripts/test-database/verify-adventureworks.mjs --runtime-dir <已有隔离库目录> --evidence-dir .runtime/hex-result-access-2026-09-16/adventureworks-chain`

本批[实库报告](../../.runtime/hex-result-access-2026-09-16/adventureworks-chain/report.json) 8 / 8 通过。只读 reader 的 10 表 / 107 字段、31,465 订单、38 月及 10 地区独立核对；PG → DuckDB → 表 / 图 → Dataset 来源 / 重开 → 看板预览 / 确认 / 撤销通过；实际截断、未授权表、取消后重试保留。脚本模型驱动四次真实工具，等待用户采用。数据库前后 PID 28212、端口 55432 和 ready 不变，未启停 / 恢复 / 写库 / 改网站连接配置。

这是原顺序链兼容回归：加载实际 API 模块但无 HTTP 监听，不冒充浏览器数据库联调。真实模型调用为 0，Databricks 未验证，显式金额转换不宣称一般十进制无损。

### 开发站截图与实际交互

最终证据：[九组验收 / 逐图报告](../../.runtime/result-access-2026-09-16/browser-1789567233132/report.json)。新隔离项目、合成 CSV、本地 DataRecipe / DuckDB、真实 HTTP 和磁盘保存；6 次成功运行回执加 1 次强制保存拒绝请求。连接目录 GET 明确使用空目录替身，页面异常 / 禁止请求 / 模型 / 外部数据库调用均 0。

| 截图 | 实际验证 |
| --- | --- |
| `01-complete-result-preview-1440.png`、`02-complete-result-preview-1024.png` | 完整 1,324 / 预览 1,000；Dataset 可用、看板超过 500 禁用 |
| `03-data-preview-1024.png` | Data 完整 1,324 / 预览 100；原 Data 保存仍禁用 |
| `04-saved-complete-lineage-1440.png` | 保存产生新 run，磁盘保存 1,324 行及 complete 来源 |
| `05-reopened-saved-dataset-1440.png` | 项目刷新重开、Data Browser 恢复来源 |
| `06-independent-count-sum-1024.png` | 已保存 Dataset 重新成为 Data → SQL 输入，COUNT / SUM / DISTINCT / MAX 均 1,324 |
| `07-truncated-sql-disabled-1440.png`、`08-truncated-sql-disabled-1024.png` | 真正 SQL 截断为不完整，两个按钮禁用；另强制 HTTP 保存 400 无新增 |
| `09-small-complete-result-1440.png` | 显式 limit 100 的完整结果允许两种保存 |
| `10-unapplied-dashboard-preview-1440.png`、`11-cancelled-dashboard-preview-1024.png` | 看板先预览再确认；取消后正式看板仍为空，既有合成快照保留 |

11 图由验收代理逐张实际查看；主代理另查看 02 / 03 / 04 / 06 / 08 / 10 / 11，关键文案 / 按钮可见、桌面无整页横溢。本轮不做手机布局。浏览器只验看板预览取消，不冒称运行中取消截图；执行生命周期取消由离线测试和实库兼容覆盖。

两轮过程证据保留：`browser-1789567103288` 因新脚本精确文案漏原有“· 2 列”失败；只补完整预期，未弱化断言。`browser-1789567133359` 九组全通过，但 Data 截图取景遗漏页脚，改滚动目标后在第三个全新项目完整重跑。未为这些脚本问题修改产品逻辑；所有合成项目 / CSV / Dataset 保留，未删用户数据。

## 保留内容与风险

独立审计：`core/harness/tool-registry.ts` 的 `createNotebookDraft.execute` 等待可注入的内部 runner，仅拒绝顶层 failure 后写入证据，未再次校验完整 Schema、版本和拓扑回执一致性。当前网页注入的真实执行器已有 Schema 校验，客户端 / LLM 不能直接提交回执；未观察到实际误报，不称为已证实可利用漏洞。保留为未来替换内部适配器时的防御性加固项，未扩展本批。

完整动态 Cell 注册、跨请求结果仓库 / 分页、自动重算、长期大数据 / 多用户负载、真实模型质量和 Databricks 实机继续未实施 / 未验证。已有三项跳过未删改；没有以关闭检查或弱化断言通过验证。

最终分支仍为 `feature/eds-analysis-dashboard`、HEAD `df5bbae`，所有原修改和新源码 / 测试保持未提交，未 commit / push / 切分支。新增接口与消费者需一并提交，避免漏掉未跟踪文件。任务日志及 `.runtime` 证据沿用既有 Git 忽略规则，未强制纳入版本库。

`npm run site:status` 前后三服务健康，PID / workerPid / revision / 重启数相同，开发站历史两次重启未增长；稳定站仍原版本。源码 / 3001 本批启用与验收完成；构建只生成产物，不代表发布。无服务启停、生产连接、真实付费模型调用、依赖升级或凭据改动。TASK-LOG 本批之前的 276,552 字节前缀另核验未变。
