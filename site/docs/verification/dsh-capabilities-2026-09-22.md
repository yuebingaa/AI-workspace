# DSH 受控 Notebook 能力接入（2026-09-22）

## 本批完成边界

在上一批可切换 DSH 的基础上，复用现有 Excel 原件、Python 沙箱和数据库只读查询链。只开放任务已授权的 Notebook 业务工具，不新增主机文件、终端或任意网络插件，不升级 SDK / 核心依赖，不发布 3000 或调用收费模型。正式文档与看板继续等待人工采用。

已检查入口为 `app/api/ai/harness/handler.ts`、`core/agent-engines/server/`、`core/harness/server/notebook-tool-bridge.ts`、原件与 Notebook 工具注册，以及 Notebook / connections 既有运行器；并非全仓重新审计。

工作清单：

- [x] 扩展桥接端口与闭合工具白名单，保留默认 CSV 试点兼容。
- [x] 引擎上下文 / Input Inspector / 能力透传及设置范围说明。
- [x] 离线测试：真实运行与提交、授权、能力关闭、撤权、取消和来源隔离。
- [x] 实际官方 SDK + 脚本模型验证；数据库为替身，真实 Python 已验证。
- [x] 3001 新截图、架构 / 视觉 / 任务记录与整体验证。

## 起始基线

分支 `feature/eds-analysis-dashboard`；355 条既有工作区修改，均保留，不提交或推送。`npm test -- --maxWorkers=2`：2623 项通过、3 项原有跳过，Node 工具 26 项通过；日志 `.runtime/dsh-capabilities-baseline.log`。本批记录前保留任务日志副本，用于最终确认历史前缀未被改写。

## 已落地的职责与目录

```text
site/
├─ core/agent-engines/server/
│  ├─ executor.ts                  # 选择完整引擎，注入已有服务端端口
│  ├─ dsh-engine.ts                # DSH 上下文、事件与真实草稿回执
│  ├─ selection.ts                 # 进程选择 / 租约，热更新保留状态
│  ├─ tool-broker.ts               # 任务级白名单、授权与取消传输
│  └─ dsh-capabilities.test.ts     # 新增数据库链与边界测试
├─ core/harness/server/notebook-tool-bridge.ts
│                                  # 复用业务工具，任务来源 / 文件 / 能力保护
├─ runtime/dsh/
│  ├─ policy.mjs                  # 必需与可选工具闭合白名单
│  └─ controlled-plugin.mjs        # SDK 仅注册当前任务公开的工具
├─ app/api/ai/harness/dsh-capabilities.route.test.ts
│                                  # 新增真实 handler / multipart / SSE 测试
├─ components/studio/AgentEngineSettings.tsx
└─ scripts/
   ├─ dsh-capabilities-fixture.ts   # 新增官方 SDK + 实际计算组合
   ├─ verify-dsh-capabilities.mjs   # 新增隔离验收入口
   └─ verify-dsh-settings-browser.mjs
```

桥新增 `profile: "notebook"`，默认 `csv` 仍服务旧试点。新增四个窄端口 `rawWorkbook / notebookCapabilities / pythonRuntimeInfo / connectionInspector`，由原 HTTP 组装点经 executor 注入；没有新写一套解析、Python 或数据库实现。支持已选多来源和零 Dataset 的附件 / 数据库起点，原 Data ID 与来源仍受保护。

DSH 的 Agent / 执行循环只依赖模型驱动和工具目录；工具桥仍复用现有 Schema、权限、Notebook DAG 与业务校验。Dataset 原有授权和行数据归属不变；SQL 查询与数据库 SDK 继续归 `core/connections`，Python 归 `core/notebook/server`。Dashboard 不直接接 SDK，表图仅来自真实 Notebook 运行，正式采用 / ChangeSet 行为不变。

四项必需工具不变，按任务条件增加 `getKernelPackagesInfo`、`inspectEdsRawWorkbook`、`readEdsRawRows`、`inspectConnectionSchema`。SDK 与 broker 均校验实际目录集合，不能因为工具属于可选名单就跨任务调用。未加入 DSH 任意插件配置、Shell、主机文件或通用网络工具。

Excel bytes 只留在 handler 的 runner 闭包；模型初始上下文只增加 Input Inspector 元数据、准确但不可信的附件标识和能力状态。原件内容经有限工具或 Python 计算读取，不能宣称原件自动受 Dataset 脱敏。Python 缺策略默认关闭；数据库只用服务端回填的 AI 授权连接，查询仍经过既有只读、超时、限行和撤权检查。

设置增加三张只读能力卡，不提供安装 / 卸载。开发站发现全局选择实例保留旧目录方法，已修复为热更新仅刷新实现原型，不替换选择、修订或活动租约；新增重载测试确认旧 release 仍正确释放同一任务计数。

## 本次验证

| 实际命令 / 范围 | 结果 | 边界与证据 |
| --- | --- | --- |
| `npm test -- --maxWorkers=2` | 248 文件 / 2671 项通过；原 1 文件 / 3 项跳过；Node 工具 26 项通过 | `.runtime/dsh-capabilities-final-tests.log`，比基线新增 48 项应用测试 |
| 桥定向测试 | 53 / 53，其中新增 25 项 | 多来源真实 SQL、文件清单、能力关闭、来源与连接范围、撤权、取消；包含在全量中 |
| 新引擎 / HTTP 集成 | 17 / 17 | 真正 multipart、SSE、Python、DuckDB；数据库驱动为替身，包含在全量中 |
| `node --test runtime/dsh/driver.test.mjs` | 10 / 10 | 真官方 SDK 子进程；本地模拟 SSE / 脚本模型，不产生模型费用 |
| `node scripts/verify-dsh-capabilities.mjs` | 两条组合通过 | [最终组合报告](../../.runtime/dsh-capabilities-1790043792183/report.json) |
| `node scripts/verify-dsh-embedding.mjs` | 原 CSV 与取消回归通过 | [本批重新运行的报告](../../.runtime/dsh-embedding-1790043801875/report.json)，不是复用上一批结果 |
| `npm run typecheck` | 通过 | `.runtime/dsh-capabilities-typecheck.log`，包含正规路由类型生成 |
| `npx eslint` 本批 20 个 TS / TSX / MJS 文件，`--max-warnings=0` | 通过 | `.runtime/dsh-capabilities-lint.log`，未全仓格式化 |
| `npm run build` | 通过 | `.runtime/dsh-capabilities-build.log`；保留既有大 chunk 提示，不代表已发布 |
| `npm run docs:agent:sync`、`docs:agent:check`、`docs:agent:test` | 184 文件指纹一致，检查器测试通过 | 更新了正文、变更记录与视觉规范，不仅同步指纹 |
| `git diff --check` | 退出码 0 | 存在原工作区 LF/CRLF 提示；未跟踪文件另经类型、lint 和实际内容复核 |

官方 SDK 组合一：合成 XLSX 的 60 + 120 秒，经实际原件工具、Pyodide pandas/openpyxl、DuckDB、本地表格与图表得到 **3 分钟**，核对附件 SHA-256 与血缘，交付 `awaitingConfirmation`，正式文档未改。

组合二：官方 SDK → Schema 工具 → warehouseSql → 真实 DuckDB → 表图 **150 / 80** → 待采用。Schema 与数据库查询端口是明确替身，`realPostgres:false`。本轮只读检查既有测试端口 55432 无监听，未启动、恢复或迁移 PostgreSQL，因此不能声称 AdventureWorks 实库链已验收。HTTP 集成另外覆盖服务端连接权限回填、项目范围与 AI 关闭；API 身份不交给模型。

原 CSV 组合回归还验证真实子进程取消、Notebook signal 中止、driver 回收后才返回、无可采用草稿及唯一 SSE completed。没有以模型最终文字替代成功运行 / 提交证据。

实施中修正的检查问题：测试工具目录顺序预期、嵌套血缘对象的测试匹配方式、桥工具名的精确类型，以及新验收脚本的 XLSX 函数签名与幂等键格式。构建后直接 `tsc` 发现临时生成路由类型不完整，运行现有 `npm run typecheck` 正规重建后通过；未关闭类型检查或弱化业务断言。

## 新鲜 3001 截图

[最终浏览器报告](../../.runtime/dsh-settings-browser-2026-09-22/browser-1790043478898/report.json)：7 组 / 10 张，隔离 Edge，全部通过 `view_image` 实际查看；主代理另复看以下四图。页面异常、路由异常及禁止请求均为 0，无横向溢出。

- [1440 三组能力卡](../../.runtime/dsh-settings-browser-2026-09-22/browser-1790043478898/02b-three-plugin-cards-1440.png)：当前 DSH 与按条件开放说明。
- [明确注入的 503 失败](../../.runtime/dsh-settings-browser-2026-09-22/browser-1790043478898/06-injected-503-needs-refresh-1440.png)：错误 / 刷新提示与禁用应用；该 PATCH 未到服务端。
- [1024 三组能力卡](../../.runtime/dsh-settings-browser-2026-09-22/browser-1790043478898/07b-three-plugin-cards-1024.png)：正常纵向滚动、无横向裁切。
- [恢复初始 DSH](../../.runtime/dsh-settings-browser-2026-09-22/browser-1790043478898/08-restored-initial-1024.png)：实际 PATCH 成功状态和底部按钮。

其余图覆盖菜单、未应用选择、取消保留、真实切换与刷新。首轮 `browser-1790043378807` 的 10 图也已查看，但部分状态图未拍全底部按钮；保留为前轮证据，最终重拍通过，不修改 CSS。手工查看结论以报告 `visualReview.reviewedFiles` 为准，逐图自动占位的 `reviewed:false` 不是最终人工结论。截图仅证明设置 UI，不冒充真实模型分析、草稿采用或图表浏览器全链。

## 启用状态与工作区

源码和 3001 开发站已具备这些接线。设置复核时用户已选择 DSH（revision 3）；两轮截图各自保留初始选择，收尾为 **dsh / revision 7 / activeTasks 0**，没有强制切回原版。源码启动默认仍为 Harness，选择只保存在当前进程。三服务的健康、PID、worker、revision、启动时间、重启数及稳定版 release 与开场完全一致，未启停 / 重启 / 发布 3000。

分支仍为 `feature/eds-analysis-dashboard`，359 条工作区状态（含折叠的未跟踪目录）；保留起始 355 条修改，不提交、推送、切分支或清理。没有移动 / 删除业务文件，不改主包或隔离 SDK 锁文件。实际修改主要在上述端口、桥、白名单、设置和对应测试；新增两份测试与两份组合脚本，同步此报告、架构、视觉规范和根任务日志。

## 后续替换与剩余边界

- 替换执行内核：从 `executor.ts` 的引擎组合及 `DshDriver` 端口进入；公开 HTTP / SSE、数据授权与正式采用无需放进 SDK。
- 替换模型服务：修改 `dsh-driver.ts` 和受控 SDK provider / wire 适配，不能假设所有 provider 都支持同样工具 Schema 或图片；真实模型 API 对复杂 `$ref` 的接受度、任务选择质量与复杂恢复未验证。
- 替换数据库：在 `core/connections/server` 的既有 query service / driver 处理，保留方言、精度、只读权限、取消和截断差异；不让 DSH 直接持有数据库客户端。
- 语义模型、图片、文本 / 参数 / transform 等本批白名单外的 Cell、任意外部工具、插件安装管理、长期 DSH 会话及云 / 便携发布仍未接通。工具六次、35 秒单工具和 90 秒任务保护保留，不等于无限分析能力。
- SDK ZIP / Office 传递依赖风险沿用上一批报告，本批未重新 audit、升级或宣称修复。受控 profile 未加载相关插件，但不是操作系统安全沙箱；不得据此声称整个安装零漏洞。
- 未调用真实付费模型、未使用用户敏感数据、未做数据库写入或生产验证。下一项实库验证需已有归属明确的测试实例可用，不能用本批替身结果代替。
