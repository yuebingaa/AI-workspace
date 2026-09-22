# Hex 第六批：显式依赖调度

日期：2026-09-16。范围：M3 中“显示顺序与依赖执行分离”及相关调用链。源码、离线检查、实库兼容回归与 3001 新截图验收完成；3000 未发布。

## 选定范围与基线

此前 `validateNotebook` 只允许引用显示在前的输出，`cellsToRun` 逆向扫描页面取祖先；图表上移到数据前会失败。搜索来源、Harness 草稿、增量试运行和失败诊断也有显示序假设，必须一起接线，不能仅改排序算法。

本批保留现有九类 Cell、数据格式、预算、权限、执行端口与确认机制；不加入自动重算、持久内核、结果仓库或参数。M2 的完整执行 / 编辑注册经审计仍不机械引入，本批在已有端口上推进独立调度切片，不宣称 M2 / M3 全部完成。

基线：分支 `feature/eds-analysis-dashboard`、HEAD `df5bbae`，保留前五批全部未提交内容。修改前实际执行 `npm test -- --reporter=dot --maxWorkers=2`：152 文件 / 1,397 项应用通过、1 文件 / 3 项既有跳过，另 14 项 Node 通过。证据在 `.runtime/hex-dependency-scheduling-2026-09-16/tests-baseline.log`。稳定 / 开发 / 截图服务健康，沿用已有进程，未启停。

## 实际模块结构

```text
core/notebook/
  graph.ts                          # 全图校验、稳定拓扑、祖先闭包、无环输入候选
  graph.test.ts                     # 新增：调度与无效图回归
  dependency-state.test.ts          # 新增：重排、内容指纹与原子编辑
  search.ts / search.test.ts        # 拓扑累积来源，显示序检索，原始源码按 ID 对应
  server/dependency-execution.test.ts # 新增：真实 DuckDB / 端口 / 来源 / Tool 回归
core/harness/
  notebook.ts / notebook.test.ts    # 授权与字段校验沿拓扑，草稿显示序不改
  notebook-cell-tools.ts            # 运行前计算预期回执序，不信任可变产物
  notebook-diagnostics.ts           # 验证拓扑回执，按 ID 关联失败状态和源码
components/studio/notebook/
  NotebookPanel.tsx                 # 共用结构候选，不截取前方单元
  NotebookCellEditor.tsx            # availableInputs 与短说明；原控件保留
  NotebookCellEditor.test.tsx       # 新增：前向选项、禁止环、禁用、提示范围
scripts/
  verify-dependency-scheduling.mjs   # 新增：隔离项目 / 实际 HTTP / 浏览器截图
  fixtures/dependency-scheduling.mjs # 新增：合成数据与独立预期
```

没有移动 / 删除源码、改锁文件、升级依赖或迁移数据。新增架构回归约束 graph / search 不依赖 UI、Harness 或服务端适配。

## 行为与边界

- `validateNotebook` 仍返回显示顺序，校验完整文档。重复 ID / 输出、缺失、非表输出、自引用和循环分别报错；重复输入继续由原 Schema 拒绝。循环提示中的未调度单元可能包含被环阻断的后继，不把它们全部称为环成员。
- `cellsToRun` 使用稳定 Kahn 拓扑：每次从可运行节点中选显示位置最前者。原本合法的依赖序保持；目标运行只执行目标及祖先，但其他分支有非法依赖仍拒绝整个文档。30 单元上限不变。
- `notebookDependencyCandidates` 按显示序返回有输出且不形成环的候选。移动仍递增 revision、保留采用标记；纯线性显示重排不改变目标内容指纹，上游内容变化依旧使相关结果失效。独立分支重排可能引发保守的指纹失效，没有引入新缓存复用。
- 搜索按拓扑计算完整源 / 连接 / 文件血缘，按显示顺序返回项目及邻居。原始源码按对应 ID / 位置保留；合法标识 trim 兼容和未修剪的存储源码都有测试。
- Harness 草稿保留 `cells` / `lineage` 显示序、给出真实 `executionOrder`。原来源、连接授权、字段、模型版本及成功采用门槛保留。Analysis Plan 自身明确的顺序编译协议没有放宽；本批乱序用于手工 / 无 Plan 增量编辑，不支持任意重排既定计划。
- 增量工具在运行前重新计算预期 ID，不能用伪装 `artifact.executionOrder` 骗过验证。诊断同样重算顺序，不因显示重排错配错误 / Python timing；保留失败优先、同状态显示序、20,000 字符和最终授权检查。
- 仍是显式、串行、手工触发的调度，不分析 SQL / Python 文本中的隐藏依赖，不提供隐式变量、跨次 Python 全局状态或后台自动执行。

## 验证与证据

| 本次实际执行 | 结果 |
| --- | --- |
| 修改前 `npm test -- --reporter=dot --maxWorkers=2` | 1,397 项应用与 14 项 Node 通过，原有 3 项跳过 |
| 最终同一全量命令 | 156 文件 / 1,444 项应用通过；1 文件 / 3 项原有跳过；另 14 项 Node 通过，exit 0 |
| `npm run typecheck -- --incremental false` | 官方 typegen + tsc 通过 |
| `node node_modules/eslint/bin/eslint.js <本批 19 个文件> --max-warnings=0` | 通过，不是全仓 lint |
| `npm run build` | exit 0，既有大 chunk 提示保留 |
| `node --check scripts/verify-dependency-scheduling.mjs` 与 fixture | 通过 |
| `npm run docs:agent:sync` / `check` / `test` | 正文及变更记录维护，137 文件指纹一致，检查器 1 项通过 |
| `git -c core.safecrlf=false diff --check` | 通过；未跟踪文件另检查 UTF-8 / 行尾 / 最终换行 |

新增 47 项：graph 14、真实执行 11、搜索 3、Harness 草稿 1、增量回执 2、诊断 8、编辑器 4、内容指纹 3、架构边界 1。先复现了顺序限制、搜索 / 草稿拒绝、合法回执被拒及伪装显示序回执被接受，再修复通过。原“前向插入应拒绝”测试按本次新行为改成显式自引用仍拒绝，并补前向插入成功；没有删除失败测试或降低校验。新增 trim 兼容样例最初误用零输入本地 SQL，被原 Schema 拒绝后改用合法 warehouseSql 元数据样例，不改输入规则。

本次日志：[基线](../../.runtime/hex-dependency-scheduling-2026-09-16/tests-baseline.log)、[最终全量测试](../../.runtime/hex-dependency-scheduling-2026-09-16/tests-final.log)、[类型检查](../../.runtime/hex-dependency-scheduling-2026-09-16/typecheck-final.log)、[严格代码检查](../../.runtime/hex-dependency-scheduling-2026-09-16/lint.log)、[构建](../../.runtime/hex-dependency-scheduling-2026-09-16/build.log)。

### 真实本地计算与原数据库链路

离线集成使用真实 DuckDB 验证乱序 Data → SQL → DataRecipe → 图表 300 / 160、合计 460，多输入顺序与连接、目标祖先 / 来源、独立分支不误跑；失败阻断、取消迟到结果与重试、非法图在端口调用前拒绝都有断言。无计划的 createNotebookDraft 以及 edit → run → submit 调用实际 Tool，不冒充真实 LLM。诊断覆盖 Python 耗时与失败状态按 ID 匹配，未重启真实 Python 内核做乱序验收。

核验已有隔离库归属与进程后，使用 reader 重跑未修改的 `scripts/test-database/verify-adventureworks.mjs`，新[实库报告](../../.runtime/hex-dependency-scheduling-2026-09-16/adventureworks-chain/report.json)八项通过：10 表 / 107 字段、31,465 订单 / 38 月 / 10 地区与独立 pg 查询核对；PostgreSQL → DuckDB → 表图 → Dataset 来源 / 重开 → 看板预览 / 确认 / 撤销兼容。精度字符串、1,000 行截断拒绝、未授权表拒绝、取消后重试保留；固定模型替身驱动四个真实工具，未自动采用。数据库进程前后不变，无恢复 / 写 SQL / 网站连接配置修改。

这是**原有顺序实库链的兼容性回归**，不是实库乱序浏览器验收。脚本加载真实 API 实现但不监听 HTTP；乱序实际 HTTP 在下节使用本地合成数据。真实模型调用为 0，Databricks 未验证，绘图的显式金额转换不宣称一般十进制无损。

### 开发站新截图与交互

新 `node scripts/verify-dependency-scheduling.mjs` 在隔离 Edge / 新合成项目完成八组检查、七次真实 Notebook 运行、一份循环请求副本真实 HTTP 400；[本批报告](../../.runtime/dependency-scheduling-2026-09-16/browser-1789563871369/report.json)。页面异常、禁止请求、模型与远端数据库调用均为 0，目录 GET 为明确空目录替身。

| 本批截图 | 核对结果 |
| --- | --- |
| 01 初始链 | 合成 CSV、两个 SQL 和图表创建成功，独立预期 150 / 80 |
| [02 图表前置 1440](../../.runtime/dependency-scheduling-2026-09-16/browser-1789563871369/02-chart-first-1440.png) / [03 图表前置 1024](../../.runtime/dependency-scheduling-2026-09-16/browser-1789563871369/03-chart-first-1024.png) | 图表显示第一、Data 最后；真实回执 Data → SQL → 图表，血缘精确，旁支 SQL 未执行 |
| [04 SQL 后方输入](../../.runtime/dependency-scheduling-2026-09-16/browser-1789563871369/04-forward-sql-input-1440.png) / 05 图表输入 | 当前输入保留，可选后方输出；自身与具有输出的下游 SQL 不在候选；合法编辑取消不写入 |
| [06 上游失败阻断](../../.runtime/dependency-scheduling-2026-09-16/browser-1789563871369/06-forward-chart-blocked-1024.png) / 07 修复 | 真实 SQL 不存在字段导致 failure，图表 blocked 且没有旧表；修复后重跑 150 / 80 |
| 08 删除保留 | 页面最后的 Data 仍识别前三个下游，提示共删四个；选择保留不改项目 |
| [09 重开并重跑](../../.runtime/dependency-scheduling-2026-09-16/browser-1789563871369/09-reopened-and-run-1024.png) | 刷新恢复页面排序，再次真实运行仍按依赖顺序得到 150 / 80 |

全部九图由验收代理逐张实际查看，主代理另看 03 / 04 / 06 / 09；截图只覆盖当前滚动区域，完整页面顺序同时由 DOM / 项目保存与运行回执核对。循环请求只发送副本、不保存，HTTP 400 / 无 run / 项目不变；端口没有执行的结论来自独立离线 spy，不能单靠 HTTP 400 推断。

首次脚本失败目录 `browser-1789563802558` 保留：未先运行最后一个有名 SQL 输出，触发既有图表创建的真实字段前提；仅修改新脚本补先运行该 SQL 并核对 150 / 80，再用全新项目完整重跑。没有放松产品门槛或断言。两轮合成项目及其源文件 / Cell 留档，没有删除用户文件或测试数据。浏览器验收的是编辑取消 / 删除保留，不是运行中取消；运行取消由离线端口与实库回归覆盖。

## 保留与替换位置

今后调整排序策略主要在 `core/notebook/graph.ts`，UI、搜索、Harness 和执行入口共用；更换 SQL / Python 仍通过既有 `NotebookExecutionDependencies`，不将实现放到图模块。数据 / 模型 / Dashboard 渲染未重写。本轮不承诺任意新 Cell 无修改接入，也不把 resultRef 变成可跨会话读取的句柄。

独立收尾审计未发现本批新增阻断。保留的原有边界：`tool-registry.ts` 的完整 `createNotebookDraft` 路径仍信任内部 runner 的成功回执，没有像增量工具一样重算所有返回 ID / revision；默认真实 runner 本身经过图校验。本批“拒绝伪装回执”的测试结论仅指增量工具与失败诊断，不扩大到全部草稿入口，不在收尾增加新的信任模型改造。

现有工作区和新文件均保留，仍为 `feature/eds-analysis-dashboard`、HEAD `df5bbae`，未提交 / 推送 / 切换分支；仅开发站验收，稳定站未发布。前后 `site:status` 的 stable / dev / capture 均健康，进程、revision、重启数不变，dev 历史两次未增长；无服务启停。真实模型、云数据库、长期负载与多用户不在本批验收范围。任务日志追加到根 `TASK-LOG.md`，历史前缀字节哈希校验保持；日志和运行证据沿用原忽略规则，不自动入 Git。
