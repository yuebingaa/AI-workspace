# M5 收尾 2/3：参数自动重算（累计第十四批）

日期：2026-09-17。状态：源码与开发站 3001 已验收；M5 收尾三个包完成两个，剩余统一上下文选择与汇总验收。稳定站 3000 未发布。

## 冻结范围

- 以现有 Notebook 为基础，增加当前页面实例内的“参数自动重算”开关，默认关闭、不写持久定义。开启本身不运行；只由人工保存已有参数的纯值变动触发，不观察整个文档任意变化，不因初始化、重开、AI 草稿采用、字段 / 类型 / 输出改名自动执行。
- 父组件接受新定义后等待 600 ms，合并多个已保存参数；打开编辑器暂停倒计时。运行中保留原编辑锁，不建设另一套实时输入面板。关闭 / 隐藏 / 切页或项目 / 失去权限清队列并取消自动任务；手工任务不被自动开关误取消。失败 / 用户停止后不循环重试。
- 执行受影响单元和必要祖先的联合闭包，保持 Cell ID、修订和来源权限，使用现有 `action=run` API；不使用浏览器有限预览作为计算输入，不自动保存 Dataset、生成看板快照、应用 ChangeSet 或调用模型。
- 必要共享祖先允许重跑；依赖的完整内容签名相同时，不因为新的 runId 让独立分支假失效。实际共享内容变化则保守标记旧分支需重跑，不扩大自动执行范围、不承诺数据库快照隔离。仅保存有限输入见证，不新建历史结果仓库。
- 提取客户端单飞运行所有权与取消保护，所有成功 / 失败 / finally 回调都不能污染后来任务或别的页面；保留原人工运行 / 保存 / 确认链路。

## 审计与工作记录

- 已读根协作、完整运行约定、最近日志、架构 Notebook / 结果 / 参数边界、视觉和 M5 清单；追踪 Panel → 现有 API → executeNotebook，及父组件按项目 / 页面 remount、模式仅 hidden 的行为。不是全仓重新审计。
- 真实风险：原 Panel 的共享祖先全后代失效和全局 resultId 查找不适合受影响链自动重算；run 只有 React busy，无同步请求所有权，finally 无条件清 busy。分别以纯选择 / 缓存规则与独立运行控制处理，避免把整个执行器或持久格式推翻。
- 独立复核补齐：layout effect 同步环境，首次新建编辑不触发，自动传输失败只清受影响链；非文档 contextKey 变化清待执行队列，不误清正常保存。M5 最后一个“统一上下文选择 / 汇总验收”不在本批提前实施。

## 实际结构、修改与公开边界

```text
site/
├─ core/notebook/
│  ├─ parameter-recompute.ts       # 值变更识别、受影响链与必要祖先闭包
│  ├─ result-cache.ts              # 有限输入见证、失效与新鲜度
│  └─ 两个对应 .test.ts
├─ components/studio/notebook/
│  ├─ auto-run-scheduler.ts        # 显式保存队列、环境确认、600 ms 合并
│  ├─ useNotebookAutoRun.ts        # React 生命周期适配
│  ├─ run-control.ts              # 单飞租约、取消与提交资格
│  ├─ NotebookPanel.tsx           # 组合控制、调用原 API、结果展示
│  ├─ NotebookParameterEditor.tsx # 手动 / 自动模式说明
│  ├─ NotebookTextResult.tsx      # 结果失效提示
│  └─ 调度、控制与展示测试
├─ app/notebook-cells.css         # 四条局部暖白 / 灰度样式
├─ core/architecture/module-boundaries.test.ts
└─ scripts/
   ├─ verify-notebook-parameter-auto-run.mjs
   └─ test-database/verify-adventureworks.mjs
```

没有移动或删除文件。新增两份纯领域实现和对应测试、调度器 / Hook / 运行控制及三个测试文件、新浏览器脚本；修改 Panel、两个展示组件、局部样式、原架构守卫和既有实库验收。文档仅维护本报告、架构、里程碑、视觉和统一任务日志。此前未跟踪的参数 / 文本组件及实库脚本属于已有批次，本次局部扩展，不把它们全部算作本批新增。

| 模块与接口 | 负责 | 不负责 |
| --- | --- | --- |
| `parameterValueChanges` / `selectParameterRecompute` | 校验文档、识别既有纯值变化、闭包选取；保留 revision / ID | 不调用 React、SQL、模型或网络；函数本身不是用户授权来源 |
| `cacheNotebookRun` / `invalidateNotebookCachedResults` / `isNotebookCachedResultFresh` | 校验原运行回执，保存直接输入 ID / 完整 SHA-256 / 完整性，递归判断可展示性 | 不将预览当输入、不制造跨请求下载凭证、不积累历史 rows |
| `NotebookAutoRunScheduler` / `useNotebookAutoRun` | 显式保存、父组件接收、合并 / 暂停 / 清队列；layout effect 同步环境 | 不监听任意文档变化来推导执行授权；不持久化开关 |
| `createNotebookRunControl` | 同步租约、取消后禁止采用、旧 finally 不释放新任务 | 不控制服务进程、不改变后端预算、不假定所有传输都及时停止 |
| 原 Notebook API / 执行器 | 当前权限、真实 SQL / Python / 转换、回执与原限额 | 本批不新增接口或改变返回 / 工具格式 |
| Agent / Harness / Model / Tool | 继续原契约和已验证工具，AI 草稿仍先试运行再确认 | 本批不改策略、模型适配、SSE、预算或记忆；不会触发自动重算 |
| Dataset / SQL / Dashboard | 原来源、连接与只读规则；Dataset / 看板仍由用户显式保存和确认 | 本批不做自动保存、连接写入、结果仓库或看板实时刷新 |

缓存仍只有当前页面实例一份。跨 runId 等价必须原 / 新直接输入都是完整表且具有相同完整内容 SHA-256；仅预览相同、无引用或截断结果不放宽。共享祖先内容实变使旧独立分支过期，但不自动执行那个分支。手动运行保留原全后代显式失效规则。

## 验证记录

修改前基线为 1,996 项应用 / 14 项 Node 通过，187 个应用测试文件通过，原有一文件 / 三项跳过。新增 85 项：纯选择 / 缓存 49，调度 / SSR 25，运行控制 10，架构守卫 1。没有删除失败测试或增加跳过。

| 实际命令 / 检查 | 本次结果 |
| --- | --- |
| `npm test -- --reporter=dot --maxWorkers=2` | 最终 2,081 应用 / 14 Node 通过，192 文件通过、一文件 / 三项原有跳过；`tests-closeout.log` |
| `npm run typecheck` | 最终退出 0；早期三条新测试类型错误已修，失败日志保留 |
| `npx --no-install eslint`，本批 14 个 TS / TSX，`--max-warnings 0` | 退出 0，未关闭规则或全仓格式化 |
| `npm run build` | 最终退出 0，`build-closeout.log`；保留既有大于 500 kB 的 chunk 提示，不调整阈值，不等于发布 |
| `npm run docs:agent:sync` / `docs:agent:check` | 正文与变更记录同步，148 源码指纹通过 |
| `npm run docs:agent:test` | 1 / 1，通过 |
| `node --test scripts/test-database/adventureworks.test.mjs scripts/test-database/bind-dev-adventureworks.test.mjs` | 11 / 11，通过；只测试隔离工具，不启停数据库 |
| `node scripts/test-database/verify-adventureworks.mjs --runtime-dir <已验证专用实例绝对路径> --evidence-dir <新证据目录>` | 10 / 10，15 条查询回执；两次通过，最终 `adventureworks-final` |
| `node scripts/verify-notebook-parameter-auto-run.mjs` | 最终 9 组 / 17 张图 / 10 次真实 Notebook HTTP 通过 |

测试日志集中在 [本批检查目录](../../.runtime/hex-auto-recompute-2026-09-17/)。浏览器证据在下节单独链接；不将旧批次或前两轮图充当最终源码验收。

早期失败：`it.each` 的数组被展开，造成空 / 单 ID 用例的类型不正确，空用例还有意外 TypeError 也能通过的问题；改为具名参数对象，并加强为精确业务拒绝断言。另一条是测试工厂返回宽 Cell 联合，改为参数 Cell 精确类型。两个新测试文件 49 项与最终类型复查通过；生产逻辑没有因类型问题放宽。首轮整体应用测试已通过，仍不把它当成类型检查通过。

补充检查：两脚本 `node --check`、本批路径的 `git diff --check`、21 个源码 / 样式 / 脚本 / 文档 UTF-8、替换字符 / 尾空白及 267 个现存本地文档链接核验通过。曾尝试在一次性检查中直接导入 `postcss`，本仓没有该顶层依赖，故未执行独立 CSS 解析器；没有为此安装依赖，CSS 以实际成功构建与浏览器截图验收，不冒称额外解析通过。

## 真实数据库与浏览器证据

实库继续使用之前确认归属的本机只读 PostgreSQL，不恢复 SQL dump、不连接生产环境、不改连接配置。前后确认 owner、进程、回环监听、数据库与 reader 身份；12 秒 statement timeout、只读、无 TEMP / 公共 CREATE / 写权限保持。凭据只在进程内读取，报告不写真实私密路径或值。

原九项全部保留；新增参数 2 → 3、共享订单聚合 → 本地 SQL → 受控文本，输出 `Scaled orders 94395.`，与独立参考订单数 31,465 对照。只执行 factor / summary / scaled / scaled_note，独立结果仍为原运行；共享 summary 的完整签名相同。两次各 10 项通过，最终 [实库报告](../../.runtime/hex-auto-recompute-2026-09-17/adventureworks-final/report.json)。该链使用真实 API 函数和执行器但不启动 HTTP 监听；浏览器使用合成本地 SQL，不能合称“浏览器已直连 PostgreSQL 自动重算验收”。

开发站最终证据：[浏览器报告](../../.runtime/hex-parameter-auto-run-2026-09-17/browser-1789614110313/report.json)。9 组覆盖：默认手动、开启不执行、纯值触发且只提交闭包、合并与编辑暂停、非法 / 取消 / 同值 / 新建 / 结构变化不触发、关开关清队列、真实 SQL 失败及下游阻断 / 无循环重试、迟到回执拒绝、本地演示角色、跨页面 / 项目 / 重开默认关闭。共 10 个真实 HTTP 回执：9 success、1 预期 SQL CAST failure；其中一个 success 是刻意延迟且已取消、不被 UI 采用，不能写成 9 次 UI 成功展示。

| 场景 | 最终实际截图 |
| --- | --- |
| 1024 px 开启但不执行，说明必要上游重跑 | [开关](../../.runtime/hex-parameter-auto-run-2026-09-17/browser-1789614110313/02a-enabled-without-execution-1024.png) |
| 保存变动后，编辑期间暂停 | [等待说明](../../.runtime/hex-parameter-auto-run-2026-09-17/browser-1789614110313/05a-visible-paused-setting-1024.png) |
| 更新结果 18，独立分支仍为 17 | [共享祖先](../../.runtime/hex-parameter-auto-run-2026-09-17/browser-1789614110313/04-shared-ancestor-independent-result-1440.png) |
| 真实 SQL 失败，不借旧结论 | [失败](../../.runtime/hex-parameter-auto-run-2026-09-17/browser-1789614110313/09-real-failure-no-retry-loop-1024.png) |
| 取消后真实迟到响应未采用 | [取消](../../.runtime/hex-parameter-auto-run-2026-09-17/browser-1789614110313/11-late-response-ignored-1440.png) |

最终 17 图逐张由验收代理实际查看；主代理另看上表五图。三轮浏览器均通过，前两轮分别因补充取景 / layout 同步，以及最终边界加固后重新截图而保留，不声称它们就是最后版本。连接目录 7 次 GET 使用明确空替身；单次取消探针只忽略该请求传输 AbortSignal 并延迟它的真实 Response，不伪造计算结果。页面异常、违规请求、非预期 HTTP 错误、真实模型调用均 0；未修改用户项目。没有手机或真实模型自主生成验收。

## 后续修改位置、保留项与工作区

- 变更自动触发策略：先改 scheduler / 参数纯选择与其测试，UI Hook 仅适配；变更结果等价 / 新鲜度：改 `result-cache.ts`，不能以预览比较替代完整签名。
- 替换模型服务仍在原 `core/ai/server/harness-composition.ts` 及模型适配，Agent/Harness 契约不因本批变化；替换数据库仍在 `core/connections/server/drivers/` 与 query 用例，SQL 方言 / 权限 / 取消差异仍需专门适配。替换图表渲染沿用已有 Notebook / Dashboard 边界，本批未重建这些模块。
- 不实现完整响应式 Notebook、修改任意代码自动执行、持续输入控件、持久 / 全局开关、并行调度或远端参数模板。只支持人工保存既有参数纯值；实际需要的上游可能包含数据库查询 / Python，这会消耗原有执行预算。
- 没有通用持久结果缓存或数据库事务快照。文件变动仍依赖既有文件元数据与来源版本指纹，并非给所有原件新建内容哈希。完整共享签名变化可能使未执行的兄弟分支过期，此时需显式运行。
- 本批新增自动分支浏览器覆盖 SQL / 文本；Python 及图表走原 API / 执行器且参与全量回归，没有单独新增“自动参数 → 真实 Python / 图表”的浏览器场景。本地演示角色检查不等于新增多用户授权系统。
- 当前分支 `feature/eds-analysis-dashboard`、HEAD `df5bbae`；保留原有大量未提交 / 未跟踪内容，无提交、推送、合并、切分支、清理或生产操作。新模块将来提交需连同消费者一起纳入；`.runtime` 验收与合成项目按既有规则忽略，本次未删除。根 `TASK-LOG.md` 也被原规则忽略，本次仍正常追加本地记录，没有擅自更改 Git 跟踪策略。
- 仅源码与 3001 验收，未发布 3000；完整构建不会替换稳定站。前后 `site:status` 的 supervisor / PID / worker / revision / 启动时间 / 重启次数完全相同，三服务健康；数据库前后只读核对一致。追加日志前的 323,630 字节历史前缀 SHA-256 核验通过，追加后再核验；见统一 [任务记录](../../../TASK-LOG.md)。

剩余边界明确：M5 仅剩冻结的第三包“统一上下文选择与汇总验收”；M2–M4 保留项、M6 / M7 仍独立核对，不把本批完成写成所有里程碑完成。
