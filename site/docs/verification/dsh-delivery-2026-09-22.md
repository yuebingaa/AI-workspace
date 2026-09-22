# DSH 应用交付闭环（2026-09-22）

## 目标与边界

用户明确要求本日完成可使用的分析与应用层修改，并授权真实模型费用。本批从第四批失败继续，不以离线通过替代真实交付。范围固定为：DSH独立执行保护、浏览器等待 / 当前Notebook上下文、阻碍新隔离项目的目录容量、真实模型实库与浏览器采用 / 看板修改 / 保存重开验收。

仍保留数据库只读、原严格工具Schema、真实试运行 / 提交和人工采用 / 看板确认。不更换SDK、升级依赖、删除既有项目、自动发布3000或提交Git。真实收费任务按证据逐个执行，不盲目循环；费用与覆盖边界分开记录。

## 本轮实际修改

- `core/agent-engines/server/execution-policy.ts`：DSH独立默认和硬上限24工具 / 总180秒 / 单工具35秒。可信环境 `DSH_MAX_TOOL_CALLS`、`DSH_TOTAL_EXECUTION_TIMEOUT_MS`、`DSH_TOOL_CALL_TIMEOUT_MS`只能收紧，非法值拒绝；浏览器 / 模型不能修改。原Harness6工具 / 90秒保持。
- `dsh-engine.ts` / `executor.ts` / `app/api/ai/harness/handler.ts`：同一个捕获的引擎租约下固定策略；初始context与工具回执提供剩余预算，仍由引擎计数。原超时 / 取消 / 授权 / SDK回收与唯一草稿验收不变。
- `core/harness/contracts.ts` / `client.ts`：可选、校验上限185秒的 `task_started.clientTimeoutMs`。DSH由最早的真实服务端开始事件传入；默认SSE等待按**原请求开始时刻**调整，仅一次，重复事件不能续命。显式更短timeout不覆盖，原Harness无此事件仍95秒。非流式JSON客户端仍保留原95秒；主站使用SSE。
- `components/studio/workspace/notebook-context-selection.ts` / `StudioWorkspace.tsx`：AI工作台与Notebook视图都携带当前文档 / 来源，不再要求隐含的手选Cell操作；看板视图仍为显式选择才附Notebook。只传定义与来源引用，不新增读取权限。
- `core/projects/server/store.ts`：最近项目登记由100提升到1000，专用索引字节上限512KiB提升到5MiB，集中常量。解决实际登记100已满不能创建隔离项目的问题；保留全部登记 / 项目文件，不自动淘汰、迁移或改变权限。
- `runtime/dsh/driver.mjs` / `core/agent-engines/server/dsh-driver.ts`：网站首次任务在模型启动前失败。独立Node可加载而网站动态导入失败，生产就绪诊断返回 `sdk_import/module_not_found`；证据不能定位具体传递包。改用 Node24 `createRequire(capturedManifest)` 加载固定SDK同步ESM图，载体修订4，生产GET实际恢复 `ready`，后续真实HTTP任务通过。不设置备用执行器、不升级包或重启服务。新增就绪检查只加载/校验SDK，不构造、不读取凭据、不启动子进程或模型；有限阶段/错误码进入设置DTO，原始异常不返回。未来SDK若新增顶层await需重新验证。
- 独立验收gateway增加显式 `delivery` 档位：最多26请求 / 单请求200KB / 总4MB / 每次4096输出Token / 超时。原smoke8请求默认不变；只影响验收脚本，不将费用保护当网站模型配额。`verify-dsh-adventureworks.mjs`补保存每次草稿定义和脱敏类型 / 状态回执（公开样例，不含结果原始行），避免失败证据缺失。最终结果依然逐值对独立参考，不要求模型中间从不犯错。

## 已执行的真实模型验收

### AdventureWorks 只读实库

`node scripts/verify-dsh-live.mjs --confirm-paid-model --runtime-dir <owned-runtime> --delivery`：本轮一次任务，[报告通过](../../.runtime/dsh-live-model-1790057771854/report.json)。官方SDK、真实deepseek-flash、真实PostgreSQL reader，12工具 / 10模型请求；中间3次cellSearch失败可恢复，2次真实Notebook运行后严格提交，最终 `awaitingConfirmation`。生成 SQL / 表格 / 趋势图的38月31,465订单与独立参考逐值一致、血缘和正式文档保护通过，未授权表查询仍拒绝。

本次最终订单计数显式转整数用于图表，收入分保留bigint字符串；不为绘图牺牲收入精度。两次定义 / 结果字段状态保留在该目录 `run-receipt-1.json`、`run-receipt-2.json`。这条链是终端生产适配器验收，尚不包括浏览器数据库查询 / 采用；浏览器另一条真实CSV链单独记录。

[usage回执](../../.runtime/dsh-live-model-1790057771854/model-usage.json)：10次HTTP200，只完整观察8份usage，输入60,773 / 输出1,035Token，`usageComplete=false`。仅观察部分按峰时未命中价估约US$0.0194739，不是完整费用、费用上限或账单；[官方价格](https://api-docs.deepseek.com/quick_start/pricing/)本轮核查峰时输入0.30 / 输出1.20美元每百万Token。SDK提前结束部分响应流会令usage缺失，不能据最终任务通过称用量完整。

### 3001 真实浏览器应用链

由 `scripts/verify-dsh-delivery-browser.mjs` 在新隔离公开合成CSV项目执行。脚本无参数只准备项目，显式 `--allow-paid-model <prepared-directory>` 才发送一次真实 `/api/ai/harness/stream`；收费尝试写入自有标记，不自动重试。仅过滤无项目范围的最近项目/连接目录以避免截图泄露其他项目，外部字体为空；模型、流事件、数据、Notebook运行与保存没有替身。

第一次公开任务在SDK启动前失败，保留[失败截图](../../.runtime/dsh-delivery-browser-2026-09-22/browser-1790057893202/failure.png)。无新SDK会话目录和模型事件，不能据此估算费用；正式Notebook/看板没有变化。就绪诊断与原生加载修复后，主代理单独允许在新项目执行第二次公开任务，没有无条件重试循环。

第二次[真实HTTP事件与草稿](../../.runtime/dsh-delivery-browser-2026-09-22/browser-1790058457963/real-public-task.json)通过：`deepseek-flash`，6次模型调用 / 5次工具；一次cellSearch失败后纠正，edit / run / submit成功，服务端严格验证后 `awaitingConfirmation`。人工采用后任务变为 `completed`，再通过真实HTTP Notebook运行验证 East=150 / South=80。快照审阅取消不改正式看板，第二次审阅确认后写入；可视化编辑标题“地区销售额 · 已确认交付”经预览和确认保存（stateRevision18），数据绑定保留。

首次脚本的最后一步在1024宽度使用 `innerText` 等待被响应式布局隐藏的保存状态而超时，保留[原报告false](../../.runtime/dsh-delivery-browser-2026-09-22/browser-1790058457963/report.json)，不把它改成通过。当时实际保存已完成、图表正确，无页面或路由异常。只修验收读取为 `textContent`，以 `--verify-reopen <prepared-directory>` 恢复**最后的新浏览器重开**，[最终重开报告通过](../../.runtime/dsh-delivery-browser-2026-09-22/browser-1790058457963/reopen-report.json)：Notebook与看板定义完全一致，快照文件摘要及150/80逐值一致，零新增模型/Notebook执行，DSH revision7 / activeTasks0。不是重新跑整条收费链，也不是服务重启验收。

本目录01～09及failure共10张新图均由验收代理实际查看；主代理另复看首次SDK失败、真实模型结果、未确认快照、修改后看板和1024重开。主要证据：

- [真实模型待采用](../../.runtime/dsh-delivery-browser-2026-09-22/browser-1790058457963/02-real-model-result-1440.png)
- [真实Notebook表图结果](../../.runtime/dsh-delivery-browser-2026-09-22/browser-1790058457963/04-real-notebook-results-1440.png)
- [快照等待确认](../../.runtime/dsh-delivery-browser-2026-09-22/browser-1790058457963/05-unconfirmed-snapshot-1440.png) / [取消保留正式看板](../../.runtime/dsh-delivery-browser-2026-09-22/browser-1790058457963/06-cancel-keeps-formal-dashboard-1440.png)
- [修改标题后保存](../../.runtime/dsh-delivery-browser-2026-09-22/browser-1790058457963/08-title-edit-confirmed-1440.png) / [1024新页面重开](../../.runtime/dsh-delivery-browser-2026-09-22/browser-1790058457963/09-new-tab-reopened-1024.png)

浏览器任务没有完整provider usage，不捏造Token或总费用；实库gateway的局部估价不包括本条网站任务。

## 现在如何使用

打开 `http://127.0.0.1:3001`，当前引擎已是DSH。在本地项目导入数据，在Notebook建立数据来源步骤，回到AI工作台描述汇总、表格和图表要求。AI生成并验证草稿后，进入Notebook审阅、采用、运行；图表加入看板仍需审阅并确认。看板可视化编辑后确认应用，等本地保存完成；重新打开项目可继续修改。本轮验证的看板标题修改是**现有可视化编辑器操作**，不是宣称DSH已支持任意自然语言修改AppSpec。

源码默认启动仍为原版Harness，选择是本进程状态；重启后如需DSH应在设置重新选择。没有发布3000或新便携包。Excel原件 / Python的既有离线组合证据仍有效，但本轮收费浏览器闭环只覆盖CSV，数据库走独立真实适配器验收。

## 实际边界与替换入口

```text
core/agent-engines/server/   # 引擎选择、租约、DSH调度、独立执行保护
core/harness/               # 兼容任务/事件契约、浏览器SSE、现有业务工具桥
runtime/dsh/                # 官方SDK安装与原生加载、受控插件、任务子进程
components/studio/workspace/# 当前Notebook上下文、人工采用/看板确认入口
core/projects/server/       # 本地项目与登记容量，不负责模型执行
```

更换模型服务仍从 `dsh-driver.ts` 的可信模型配置和 `runtime/dsh/controlled-plugin.mjs` 模型适配入手；更换执行器从现有引擎注册/调度入口接入原任务与草稿契约；数据库继续通过现有Notebook runner / 查询端口，本批没有另造数据库实现。工具桥承担业务校验与提交，DSH不得跳过它直接写AppSpec或数据库。未来调整执行保护集中在 `execution-policy.ts`，相应保持事件及浏览器最大等待一致；这些接口降低替换成本，不保证任意SDK、SQL方言或Agent零改动替换。

## 验证 / 保留事项

工作区基线 `feature/eds-analysis-dashboard`，371条既有状态保留，三服务与任务日志先做基线。收尾状态376条（未跟踪目录按Git折叠口径），没有自动提交、推送、切分支或清理文件。本轮仅创建带拥有者标记的隔离合成项目，保留中途失败记录，不操作用户已有业务数据。服务PID / worker / revision / 启动时间 / 重启数 / stable release与基线一致，三服务健康；设置为 `dsh / revision7 / activeTasks0`、本地SDK `ready`。

本轮针对客户端22项、上下文44项、DSH策略/引擎/路由64项、本地项目32项通过。独立SDK/安装/就绪/网关/入口/架构77项通过（含官方SDK子进程11项、就绪8项）；这些离线验证不消耗真实模型费用。严格ESLint29文件通过，类型修复后相关3文件再次通过；`npm run build`及之后正规 `npm run typecheck`通过。类型检查曾发现本轮4项错误，修为工具观察对象守卫和窄环境字典后通过，没有关闭类型检查或改成any；该有效回执结构未改变，收费浏览器不再重复运行。构建仍有既有大chunk提示。

架构正文和变更记录已更新，`npm run docs:agent:sync` / `check`为188文件指纹一致。类型修复后再次完整执行 `npm test -- --maxWorkers=2`：**251文件 / 2,731应用 + 26Node通过**，原1文件 / 3项跳过，无新增跳过。差异检查通过。本报告关联日志为 `.runtime/dsh-delivery-final-tests.log`、`dsh-delivery-final-node.log`、`dsh-delivery-build.log`、`dsh-delivery-typecheck.log`及`dsh-delivery-lint.log`。独立代理另做只读边界复核，未发现本轮阻断回归，但不把审查算作执行测试。

仍不支持DSH语义模型、图片、EDS专属工作区和任意外部工具；当前项目含这些上下文会明确拒绝，不静默回退。一次请求最多10来源、公开请求180KB、Notebook运行120KB / 手动40秒、快照500行 / 30列等原边界保持，本批不证明所有历史大型项目可直接通过。不移除旧SDK风险安装或宣称新audit，3000尚未发布。
