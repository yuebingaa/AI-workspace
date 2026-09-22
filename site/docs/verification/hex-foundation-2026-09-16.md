# Hex 对齐首批实施：可靠性与真实 PostgreSQL 输出链路

日期：2026-09-16。状态：**首批实施完成，开发站真实链路验收通过；未发布稳定站，后续里程碑未全部完成**。

## 选定范围

承接 [里程碑方案](../architecture/hex-alignment-roadmap.md)，本批完成 M0 基线、M1 的工具契约与 Notebook 预算切片，以及真实数据库到输出的纵向验收。提前落实 M2 中连接配置 / 凭据适配的边界。不是宣称 M0–M7 已全部完成；参数 Cells、通用结果仓库、拓扑调度、能力卸载等后续范围不混入本批。

用户指定使用现有 AdventureWorks PostgreSQL schema/data 文件。仅恢复到本轮新建、可辨识归属的本机隔离测试实例，不修改原 SQL，不连接生产库，不使用真实付费模型，不发布 3000。

## 修改前基线

- 分支：`feature/eds-analysis-dashboard`；开始时已有 210 条 Git 状态记录，均保留为用户原有工作，不清理、提交或推送。
- 已完整阅读运行约定与 Agent 架构；三个受管网站服务健康、重启计数均为 0。
- `npm run docs:agent:check`：128 个源码文件指纹一致。
- `npm test -- --reporter=dot --maxWorkers=2`：136 个测试文件、1,137 项通过，1 文件 / 3 项原有跳过；随后 14 项 Node 工具测试通过。
- `npm run typecheck -- --incremental false`：通过。

## 有界工作清单

| 项目 | 实施与验收记录 |
| --- | --- |
| 工具生成与校验契约一致性 | 先复现 6 个失败；新增 12 个契约回归，相关 6 文件 / 75 项通过 |
| Notebook 工具预算与分段诊断 | 仅 Notebook 工具默认 35 秒；相关 7 文件 / 158 项通过，真实离线 Python 6 项通过 |
| 连接配置与凭据适配 | 新增私有连接文件读取，环境兼容、作用域与凭据轮换复查；初轮 5 文件 / 33 项测试通过 |
| AdventureWorks 实例 | 已真实恢复并核对 68 张表 / 68 个主键 / 90 个外键、6 张核心表行数及 reader 拒写；工具 9 项单测通过 |
| 数据库到 Notebook / 表格 / 图表 / 保存重开 | 服务端真实 8 项通过；修复既有标签偏移后，浏览器最终 10 项通过，9 张截图保留并实际复核 |
| 架构 / 类型 / 离线回归 / 构建与开发站验收 | 1,178 项应用测试通过 / 3 项原有跳过，14 项既有工具测试及 11 项数据库工具测试通过；类型、36 文件严格 lint、构建、130 文件架构检查通过 |

## 测试数据库准备边界

- 原文件位于 `artifacts/test-databases/adventureworks-pg-2026-09-14/`。只读复核确认两份 Git blob 哈希与原来源清单一致，68 个 COPY 块 / 759,240 行；COPY 顺序满足 90 个外键的父子表关系。恢复仍须保留约束并执行实际核验。
- 本机指定常见位置未发现 PostgreSQL / Docker。便携包来自 [PostgreSQL 官方 Windows 页面](https://www.postgresql.org/download/windows/) 指向的 [EDB 二进制下载](https://www.enterprisedb.com/download-postgresql-binaries)，版本 16.15-3，沿用原 SQL 的 PostgreSQL 16 主版本。
- 下载包 333,048,048 字节，自算 SHA-256 为 `5e8afffe67daf949aeeb03b74951f1ec2324e1888f73fbd036ab0e567ab004d9`；仅用于版本复现，不冒充发布方签名 / 哈希验证。主程序没有 Authenticode 签名。
- 只解压 `bin / lib / share` 与必要许可，共 1,637 个文件；包含 `tablefunc` 和 `uuid-ossp`。不安装 pgAdmin、注册系统服务、修改防火墙或网站端口。
- 实例凭据放在限制 ACL 的私有目录，网站只使用专用 reader，限定销售 / 产品的 10 张核心表。测试库管理脚本检查目录、PID、监听端口、可执行文件和集群标识，不终止其他数据库进程。
- 实例已在 `127.0.0.1:55432` 运行，数据库 `agentcanvas_adventureworks`。恢复核对订单头 31,465、订单明细 121,317、客户 19,820、产品 504、库存 1,069、员工 290 行；员工表仅恢复管理员用于计数，不授权网站 reader。reader 在显式读写事务内尝试零行 DELETE 仍被数据库以权限错误拒绝并回滚，不以只读事务开关冒充真实权限验证。
- 保留两次失败现场：首次便携二进制位于中文路径，`initdb` 后置初始化编码失败；第二次初始化成功，但 Windows 的 PostgreSQL 后代继承 stdout，导致 `pg_ctl` 已退出而启动脚本仍等 `close`。前者增加仅便携测试工具的 ASCII 路径前置检查，后者仅启动阶段等待 `exit` 并释放继承管道；恢复 `psql` 仍等待完整结束。第二次实例按归属校验安全停止后，用新目录完成第三次恢复，没有覆盖失败目录或修改 SQL。

## 主要实现与模块边界

```text
core/harness/
  tool-schema.ts              输入契约生成、无损重复定义共享、安全纠错信息
  tool-registry.ts            按授权与当前计划选择工具候选，仍用完整业务校验
  tool-budget.ts              不同操作的默认预算与显式更严上限
  runtime.ts                  既有模型 / 工具执行循环与真实事件
core/notebook/
  contracts.ts                向后兼容的可选 Python 分段 timing
  server/execution.ts         人工与 Agent 共用执行器，保持取消和依赖阻断
core/connections/
  server/local-config.ts      私有文件与环境凭据适配，不向浏览器导出
  server/query-contracts.ts   查询端口，含可替换的不透明凭据身份函数
  server/query-service.ts     授权、限流、取消、查询后配置 / 凭据复查
  server/query.ts             驱动与凭据身份的现有组装入口
  server/drivers/             PostgreSQL / Databricks 实现
scripts/test-database/        只管理自建隔离实例、开发站测试绑定及验收
```

- 工具目录与执行端共用 Zod 输入定义，保留 `dependsOn` / columns 等数量、格式、默认值和 transform 分支。`$defs` 只消除重复，不删除校验规则；业务授权、依赖存在性等仍在执行端核对。已验证的当前计划用于裁剪草稿目录，重新规划会更新候选，增量编辑不继承旧计划约束。
- `runNotebookCells` / `createNotebookDraft` 默认外层 35 秒，其余工具仍 10 秒。显式更小配置与剩余总任务期限继续限制；Notebook 内层仍 30 秒、Python 实际计算仍 10 秒。`timing` 区分准备 / 执行及错误 / 取消 / 超时，不展示模型内部推理或将浏览器关闭后果当成根因。失败代码仍仅任务内保留，不是新增可恢复草稿仓库。
- 私有文件不存在时完全保留环境配置路径；存在时合并连接并严格拒绝重复 ID。两个驱动 / 目录作用域共用凭据解析入口。查询返回前再次检查配置及凭据身份；凭据轮换不会让进行中的旧结果被当作当前授权结果。没有 OAuth、用户表或新浏览器凭据表单。
- Dataset / Dashboard 沿用既有保存、来源、预览和确认路径。没有第二套数据仓库、ChangeSet 或图表实现。连接结果仍依赖 `NotebookTable`，本批没有宣称完成所有跨模块解耦。
- 输出端额外最小修复 `components/data-components/BarChart.tsx` 与 `app/globals.css` 的分类标签定位：按 SVG 实际绘图区均分，而非固定槽宽；竖排字形居中。对应 `BarChart.test.tsx` 新增 1 / 4 / 6 / 10 / 14 分类的 5 个回归，先失败后通过；不修改数据 binding、系列颜色或其他图表类型。
- `.gitignore` 追加本轮私有连接、凭据及数据库私密日志的精确文件名，防止误放仓库后被提交。实际凭据仍在受控的仓库外运行目录；未创建浏览器配置接口，未删除或移动用户文件。

## 本轮检查（逐项追加）

- 连接适配专项：5 文件 / 33 项通过，包含新配置、凭据轮换、原连接协议及模块边界。
- Notebook 预算 / 回执专项：7 文件 / 158 项通过；真实离线 Pyodide 6 项通过，另复测 `TimeoutError` 断言。没有付费模型调用。
- 工具契约专项：6 文件 / 75 项通过；保留原有 10,000 字符预算断言，未放宽预算或弱化执行校验以通过测试。
- `npm run typecheck -- --incremental false`：修改后通过。直接 `tsc` 曾受旧 `.next` 路由生成物干扰；正式命令重新生成类型后正常，不关闭类型检查。
- 连接 10 文件、Notebook 13 文件、契约 4 文件的严格 ESLint 均通过。全量 lint 尚未在本批执行，不以专项替代全仓结果。

### 真实联调发现并修复的既有驱动故障

初轮真实 PostgreSQL 在返回流式查询结果时，`pg@8.16.3` 的 `query_timeout` 包装调用了不存在的 `Query.callback`，抛出 `queryCallback is not a function`。旧模拟只发 `row/end` 事件，没有覆盖驱动实际的 timeout 回调协议，因此之前离线基线不能证明实库可用。

修复只在 `core/connections/server/drivers/postgres.ts` 的流式配置提供错误回调，仍逐行控制字节、监听完整输出并保留超时；不是去掉 `query_timeout` 规避问题。`query.test.ts` 加入成功回调与只有回调、没有 error 事件的错误情形，先复现失败，再修复通过；相关 4 文件 / 24 项通过，驱动与测试严格 ESLint 通过。后续实库 schema、精度、Notebook 四节点与 Dataset / 项目重开已通过，完整结果见下方证据。

前两次浏览器在连接测试阶段失败，保留各自 report / 截图；受管状态显示开发站自动恢复 2 次，与实际驱动崩溃相符。最初判断为热更新干扰不充分，现以真实驱动复现为依据；没有手动重启、停站或批量结束 Node，稳定站与截图服务重启数保持 0。绑定脚本另隔离 Vite cache / env，不能将这个独立改进当作已证明的崩溃根因。

## 工作区保护与运行状态

开始时 210 条原有状态记录已按现状保留。本次进行中，另一个会话将原有进度提交为 `df5bbae`，任务日志明确其没有纳入当时并行的新契约测试；本任务没有发起该提交 / 推送，也没有覆盖或撤回它。本批实现继续保留在当前功能分支工作区。

开发站通过私有连接文件热读取 `adventureworks_local`，仅绑定显式工作区 / 验收项目，默认 `allowAi=false`。没有修改原环境文件、生产 / 云数据库或稳定站配置，也没有调用 `site:publish`。源码 `.env` / `.env.local` 未配置显式 `HARNESS_TOOL_CALL_TIMEOUT_MS`；这不是对所有后台进程继承环境的完整审计。

## 真实数据链路证据

服务端命令：

```text
node scripts/test-database/verify-adventureworks.mjs --runtime-dir <本轮隔离实例> --evidence-dir <新的证据目录>
```

最终[服务端报告](../../.runtime/aw-real-chain-20260916-a3/report.json)通过 8 项：

- 只读目录恰为 10 表 / 107 字段，完整且版本化；项目范围与默认 Agent 拒绝生效。
- 31,465 张订单、10 地区；原 `numeric` 与 `::text` 合计均为字符串 `109846381.4039`。绘图显式转换 double，不宣称 decimal → 浮点普遍无损。
- 真实 PostgreSQL 的 38 个月（2011-05 至 2014-06）进入真实 DuckDB，汇总成 4 年的表格 / 图表。月汇总先四舍五入至分，再验证整数可安全表达；该业务口径不等同于原四位小数完全无损相加。
- Notebook API 的实际实现、结果引用与上游闭包、显式 Dataset 保存、来源定义 / 目录版本、项目重开均通过。保存结果保持待确认 AI 授权，无临时 TTL。
- Dashboard 预览不改正式定义；确认后的图表 binding 数值一致，撤销恢复，项目保存后定义一致。
- 超过 1,000 行的查询明确截断，下游计算 / 保存拒绝；未授权表返回数据库 42501；取消后可正常重试。
- Harness 使用明确的模型替身选择 4 个动作，实际工具 / PostgreSQL / DuckDB 执行和验证均真实，最终 `awaitingConfirmation / passed`；没有自动采用，过期 revision 拒绝。模型 HTTP 被禁止，不是 LLM 生成质量实测。
- 9 条本地查询回执存在，未知扫描字节保持 `null`。

服务端通过不监听端口的 Vite SSR 加载真实路由实现，**不是浏览器或网络传输验收**。a1 保留驱动崩溃现场；a2 仅因测试脚本把 JSON 中缺省字段与 JS `undefined` 用严格对象相等比较而失败，改为按 JSON 持久边界比较后 a3 通过，未改产品序列化格式。

浏览器命令：

```text
node scripts/test-database/browser-adventureworks.mjs <本轮隔离实例>
```

初步[浏览器功能报告](../../.runtime/hex-foundation-2026-09-16/browser-1789553560908/report.json)通过真实连接 / 字段目录、手工 SQL、表格 / 图表、Dataset 磁盘内容及来源下载、看板预览 / 确认、刷新重开 8 项，AI 请求和页面异常均为 0。但人工查看看板截图发现竖排文字未对准柱形；最初的元素盒中心断言未覆盖实际字形位置，这份报告不能作为最终视觉通过证明。后续验收改用 `Range` 测量文字，并同时覆盖少量分类的 520px 最小绘图区情况。

测试脚本还修正了保存 SQL Dataset 后需重新执行图表的前置步骤：保存操作按目标依赖闭包重新运行，不意味着其他未执行单元有本轮结果。保留失败现场，没有为测试绕过结果新鲜度要求。

最终[浏览器报告](../../.runtime/hex-foundation-2026-09-16/browser-1789553974266/report.json)为修复后完整重跑：10 项、9 张截图通过，真实 HTTP / 数据库 / 存储 / 渲染，无查询替身，AI 请求与页面异常均为 0。十地区竖排字形偏差从 24.30–29.70px 降至最大 0.247px，四年度横排标签偏差为 0。已查看[两张看板图](../../.runtime/hex-foundation-2026-09-16/browser-1789553974266/09-reopened-two-chart-dashboard.png)、[重开后的来源记录](../../.runtime/hex-foundation-2026-09-16/browser-1789553974266/06-reopened-project-provenance.png)等最终截图，不以结构断言代替目视复核。

可在开发站 Data Browser 打开保留的演示项目：`site/.runtime/hex-foundation-2026-09-16/browser-1789553974266/project`。项目包含可重跑 Notebook、已保存结果和两张确认后的看板图。默认本地工作区也能刷新看到测试连接；其他已有项目不自动扩大授权，需用绑定脚本显式加入其 handle。

## 最终验证汇总

| 实际执行 | 结果 |
| --- | --- |
| `npm test -- --reporter=dot --maxWorkers=2` | 最终 138 文件 / 1,178 项通过，1 文件 / 3 项原有跳过；随后 14 项 Node 工具测试通过。[日志](../../.runtime/hex-foundation-2026-09-16/tests-after-chart.log) |
| `npm run typecheck -- --incremental false` | 最终通过。[日志](../../.runtime/hex-foundation-2026-09-16/typecheck-final.log) |
| `node node_modules/eslint/bin/eslint.js <本批36个TS/TSX/MJS文件> --max-warnings=0` | 最终通过；首次发现绑定脚本 1 个未使用变量，已改为实际使用项目列表后复测，不禁用规则。全仓 lint 未运行。[最终日志](../../.runtime/hex-foundation-2026-09-16/lint-final-passed.log) |
| `npm run build` | 通过并生成 standalone；保留原有大于 500 kB 的客户端 chunk 提示，未关闭警告。[日志](../../.runtime/hex-foundation-2026-09-16/build-final.log) |
| `node --test scripts/test-database/adventureworks.test.mjs scripts/test-database/bind-dev-adventureworks.test.mjs` | 11 项通过，包括 pg_ctl 继承管道、目录归属、端口、私有 ACL 前置校验与环境冲突拒绝 |
| `npm run docs:agent:sync` / `docs:agent:check` / `docs:agent:test` | 正文维护后同步，130 文件指纹一致，检查器测试通过 |
| `git diff --check`、私有值检查、原 SQL Git blob 哈希复核 | 差异检查通过；本批 43 个变更文件初次扫描未含本次数据库 reader / admin 凭据，两份原 SQL 与原哈希一致；不宣称全仓历史秘密审计 |
| `npm run site:status`、隔离库 `status` | stable / dev / capture 健康；稳定站与截图服务 PID / revision 不变、重启数 0；开发站此前自动恢复 2 次，驱动修复后没有再增长；测试库 ready、55432 运行 |

## 后续替换方式与剩余范围

- 模型：沿用 `HarnessModel` 与 `core/ai/server/harness-composition.ts` 组装；具体供应商请求仍由现有 AI 服务端适配。此批没有接新模型或证明全部模型支持相同能力。
- 数据库：驱动实现继续实现 `ConnectionDriver`，在 `server/query.ts` 组装；本地凭据改动集中在 `local-config.ts`，查询用例仅检查不透明身份。未来异步 OAuth / 用户身份需继续设计，不宣称只改配置即可获得多人隔离。
- Agent / Harness：工具 Schema 和操作预算已独立，仍使用原策略 / 运行时 / 工具注册边界；没有换框架、增加多 Agent 或重写规划器。
- 图表：数据 binding 与 Notebook → ChangeSet 配置映射保持；替换渲染实现主要涉及 `components/data-components/` 与 Notebook 结果呈现，但本批未做完整统一渲染端口。
- M0 基线、M1 可靠性和 M2 连接边界的首批完成，不等于整个 M1 / M2 或 M0–M7 完成。统计口径的产品约束、Cell 扩展注册、结果仓库、参数 Cells、任意顺序 DAG、功能禁用 / 卸载继续按里程碑推进。
- 未进行真实付费模型端到端、生产 / Databricks 实库、多人权限或长时间性能压测。数据源快照不是实时数据库看板；结果引用不是跨会话全量下载地址；失败草稿仍仅任务内。
- 本次保留自建测试项目、隔离实例、便携包和失败证据，没有清理用户工作区。数据库不注册自动启动，机器重启后须显式启动；开发站配置不自动发布到稳定站。当前功能分支修改未由本任务提交 / 推送。
