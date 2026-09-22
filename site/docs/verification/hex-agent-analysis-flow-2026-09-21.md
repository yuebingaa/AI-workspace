# M7 第二包：浏览器 Agent 分析与追问闭环

日期：2026-09-21—22。状态：本批回归基础设施和配方请求修复完成；浏览器 Agent 后半链未验证，M7 未完成。仅开发源码 / 3001，不发布 3000。

## 本批冻结范围

1. 完整 UI 导入一份新的合成 CSV，保留数据表与原件；不复用上一包失败上传作为成功证据。
2. 从浏览器实际请求进入隔离的固定模型替身与真实 Harness / Notebook 工具、本地 SQL 运行时，使用现有 SSE 契约回到实际界面。
3. 首稿先审阅、显式采用，再人工运行结果；保存后从项目入口重开，同会话继续追问。
4. 第二轮必须产生新的执行证据，历史只能帮助连续对话；暂不采用第二稿不得改变正式 Notebook 或看板。
5. 仅修复此路径内可确认且可回归的缺陷，不扩展新 Cell、真实模型服务、长期记忆或数据库实现。

复用已核验归属的隔离合成项目，以第一包最终状态为保护基线；最多新增本批一页 / Notebook、一份 CSV 表和原件，不生成看板快照、不登记新项目、不清理旧资源或提高上限。每轮开始前备份状态，失败只允许复用本包对象，不堆积重试文件。任何重试导致首次操作跳过必须据实记录。

## 证据边界

模型决策为确定性替身，真实工具负责计算，不伪造成功回执。浏览器 AI 传输在测试侧接线，不启用受管站的真实模型配置；如使用缓冲 SSE 响应，不声称验证了网络实时分片或运行取消时序。手工上传、原件保存、项目保存 / 重开和人工 Notebook 执行应走真实 3001 HTTP。

这不证明供应商模型的生成质量、公开 Harness HTTP 入口的全部身份 / 授权路径、进程重启后的长期上下文或已发布 App。合成 Excel、EDS / 语义 / 只读数据库纵向回归仍保留在 M7 后续，不把本批视为整个 M7 完成。

## 工作记录

- 已读取协作和完整运行约定、最近任务日志、相关架构与视觉规范，核对实际上传、Notebook 草稿审阅、会话和 SSE 实现。
- 开场 Git 分支 `feature/eds-analysis-dashboard`，331 项既有未提交状态；保留用户及前批改动，不提交 / 推送 / 切分支。
- 三受管服务健康，未启停、重启或发布。开始建立本次离线基线，并并行审计测试侧 Harness 接线和浏览器隔离守卫。
- 本次修改前 `npm test -- --maxWorkers=2` 为 236 文件 / 2,497 应用 + 26 Node 通过；原 1 文件 / 3 项跳过保留。基线 `npm run typecheck`、架构检查器测试通过；日志前缀 `.runtime/m7-agent-flow-`。
- 已独立核对目标合成项目 revision 155、40 表 / 16 原件 / 17 页 / 17 Notebook，56 个文件摘要匹配；本包固定增加对象，不修改前批定义。现有“暂不采用”是窗口内隐藏草稿，不承诺永久删除或跨刷新隐藏。
- 发送前确认现有新建会话逻辑会复用空会话。保守使用该合成项目唯一的原空会话，发送前核验无旧消息 / 草稿 / 任务；仅允许加入本批两轮，不人为制造旧消息或修改产品交互。原定“新增一个独立会话”调整为“复用固定空会话”，其余页面、文件、数据和已有非空历史保护不变。

## 实际新增边界

- `scripts/fixtures/agent-continuity.mjs`：验收专用 `createAgentContinuityRunner`，接收真实浏览器请求和可信数据读取回调；具体决策固定，其余调用真实 Harness、四个 Notebook 工具和本地 SQL。公开 Schema、任务 ID、会话 ID、当前文档与数据源严格匹配，正式 SSE 编解码后缓冲返回。
- `core/harness/server/agent-continuity-fixture.test.ts`：两项测试覆盖首轮 150 / 80、显式采用、同会话第二轮 300 / 160、新 runId / resultRef、输入不被修改、缓存不被调用者改写，以及错项目 / 页面 / 来源、伪造角色、旧版本、未采用追问与幂等冲突拒绝。
- `scripts/verify-agent-analysis-flow.mjs`：固定合成项目的实际 UI 操作；只有限定对象允许写入，受管站负责上传、原件、人工运行、保存和重开。独立工厂不用站点模型配置，Vite 无监听端口；浏览器拦截无权扩展生产 API。

验收基础设施不是另建业务执行器或替换模型服务；不改依赖、锁文件、数据格式和权限。未来更换生产模型仍走 `HarnessModel` 适配入口，本工厂仅供离线验收，不可接作生产授权入口。第 4 轮另外暴露前端请求配方数量违反既有公开契约，见下方；这是本批唯一额外产品修复范围，不放宽服务器 20 项上限。

## 本次验证与前置失败

- `vitest run core/harness/server/agent-continuity-fixture.test.ts core/harness/server/notebook-continuity.integration.test.ts core/harness/stream.test.ts --maxWorkers=1 --reporter=dot`：3 文件 / 12 项通过。开发中的 optional signal 类型和 JSON 缺省属性比较已修正，未放宽真实 SSE 回执断言。
- `npm run typecheck`、新增测试 / 工厂 / 浏览器脚本的 `eslint --max-warnings 0`、两个 MJS 的 `node --check`、`npm run build`、架构指纹同步 / 检查与检查器测试通过。构建不等于发布。
- 首次最终全量检查跨夜出现约 38,4xx 秒耗时，2 项计时相关测试超时、其余 2,497 项通过；记录 `.runtime/m7-agent-flow-final-tests.log`。未据此修改生产超时、跳过断言或直接认定产品缺陷，使用相同命令 / 参数完整重跑，最终结果另列。
- 浏览器首轮 [report](../../.runtime/hex-agent-analysis-flow-2026-09-21/browser-1789997710137/report.json) 中 Dataset 与原件两个实际 UI POST 均 201，固定 CSV 字节 / 三行数据已保存，尚未发送 Agent 请求；后续工作区保存被脚本误拒绝，因为 `synchronizeUploadedDatasetExecution` 会将新来源描述同步到历史 AppSpec。失败截图与上传前截图均已实际查看。守卫仅允许此本批来源的正常目录同步，历史其余内容继续比较；失败不冒称全链成功，不 API 补存或再上传第二份 CSV。

## 浏览器结果与明确未完成项

四轮分别保留，没有删除失败任务或通过修改请求回执伪造成功：

| 轮次 | 实际结果 | 下一步处理 |
| --- | --- | --- |
| `browser-1789997710137` | 页面创建、CSV / 原件两个 UI POST 201；历史来源目录同步被过严脚本守卫拦截 | 修正守卫，只允许本批来源描述同步 |
| `browser-1790036292297` | 复用原表 / 原件；工作区尚未接入来源，Data 下拉选项缺失 | 改用现有 Data Browser 的“用于 Notebook”入口恢复，不 API 灌定义 |
| `browser-1790036388341` | 恢复入口的图标空格定位失败，尚无任务 | 修正脚本定位，无新资源 |
| `browser-1790036438519` | 真实 UI 接入来源并保存一个 Data 单元；首个 Agent 请求违反公开 Schema，执行前被拒绝 | 保留一条 failed task / 一轮聊天；转为最小产品修复与离线回归，不重复任务 |

第 4 轮错误是 `recipes` 数组超过公开 `harnessPublicRequestSchema` 的 20 项限制。当前项目共有 40 个配方，本次 CSV 对应仅一个，但 `components/studio/workspace/assistant.ts` 原先发送 `dataProduct.recipes` 全量。fixture 使用正式 Schema，不能放宽它来掩盖真实 handler 同样会拒绝的请求。执行次数 / SQL 试跑 / 模型动作 / 网络调用均为 0；`agentRuns` 为空不表示项目没有任务，前端已保存一条失败任务。

本次实际证明：新的 CSV / 原件 UI 上传、现有表经 Data Browser 接入、人工 Data 保存、真实浏览器请求暴露契约错误，以及核心替身两轮工具 / SSE 的自动化测试。**浏览器中的首稿采用、人工 SQL 表图、保存后追问、第二稿暂不采用均未完成**，不是成功的完整浏览器 Agent 链。模型生成质量、公开 handler 授权、实时 SSE 分片 / 取消、服务重启后的长期记忆、合成 Excel / EDS / 语义 / 只读数据库仍未验证。

## 配方请求修复与模块边界

生产改动只落在以下范围，没有改模型决策、SQL、Dataset、看板或持久化格式：

```text
core/harness/
  source-scope.ts          # 新：已有来源范围规则的浏览器安全纯入口
  context-selector.ts      # 复用纯入口；保留旧公开导出
  contracts.ts             # 原 max(20) 提取共享常量，契约不变
components/studio/workspace/
  assistant.ts             # 发送前按范围选配方；相关超限明确早失败
  assistant.test.ts        # 新增 7 项真实请求组装回归
scripts/
  fixtures/agent-continuity.mjs
  verify-agent-analysis-flow.mjs
core/harness/server/
  agent-continuity-fixture.test.ts
```

`resolveHarnessPageDataSourceIds` 从原 `context-selector.ts` 提取，Notebook 取其 `sourceIds`，普通任务取当前来源、指令点名来源与页面绑定来源；未知 ID 被过滤。新文件只有类型依赖，浏览器不导入整个执行侧上下文选择器。旧导出兼容现有调用者，仅当其全部迁移后才清理，不在本批批量搬迁。

前端按来源筛选 `recipe.sourceDatasetId`，仍保持原顺序且保留全部相关配方。`MAX_HARNESS_REQUEST_RECIPES` 共享原 20 项上限；相关配方超过 20 则明确报错，在任务创建、清草稿、取消预览和持久化前返回。空范围发送空配方列表。选择元数据不授予访问权限，服务端身份 / 掩码 / 工具授权保持原逻辑；原 40 个项目配方没有删除、截断或重写。

新增七项含 39 无关 + 1 当前、Notebook 多源、页面 / 点名来源、两种空范围及 20 / 21 边界；其中五项先失败，修复后相关六文件 108 项通过。最终官方 `npm run typecheck`、八文件严格 ESLint 和 `npm run build` 均通过；直接 `tsc` 曾遇四项生成路由类型缺失，官方 `next typegen && tsc --noEmit` 已重新生成并通过，未手工改生成物或忽略错误。构建保留原 chunk 大小提示。

最终 `npm test -- --maxWorkers=2`：**237 文件 / 2,506 应用测试 + 26 Node 测试通过**，原 1 文件 / 3 项跳过未增加；本批新增 2 工厂 + 7 请求回归。包含现有架构边界与离线评测，不是真实模型 / 外部数据库验证。日志为 `.runtime/m7-agent-flow-recipe-fix-{tests,typecheck,lint,build}.log`；此前无产品修复时的同命令重跑为 2,499 + 26 通过，跨夜超时的首份失败日志保留。架构正文 / 变更记录更新后，`docs:agent:sync`、`docs:agent:check`（168 文件）、`docs:agent:test`、脚本语法和局部 diff 均通过。独立只读复核确认无新增循环或前端服务端依赖泄漏。

## 截图与资源保护

- 6 张新 PNG 均为实际 3001 / 1440 px 截图，验收代理全部逐张查看；主代理另看 4 张。逐图结论在[第 4 轮报告](../../.runtime/hex-agent-analysis-flow-2026-09-21/browser-1790036438519/report.json)的 `visualReview`，`passed` 保持 false；模板内后半场景说明是计划范围，不是已执行计数。
- [待上传](../../.runtime/hex-agent-analysis-flow-2026-09-21/browser-1789997710137/01-csv-ready-1440.png)：只证明新 CSV 和目标页面已选中；两个 201 用 HTTP 回执 / 原件字节确认，不从截图推断。
- [来源与 Data 已保存](../../.runtime/hex-agent-analysis-flow-2026-09-21/browser-1790036438519/02-upload-complete-data-1440.png)：真实 UI 恢复来源并保存的一个 Data，仍待运行，不是执行结果。
- [首请求失败](../../.runtime/hex-agent-analysis-flow-2026-09-21/browser-1790036438519/failure.png)：失败和重试入口可见；40 配方超限原因由实际拦截回执 / Schema 确认，不由通用网络提示推断。
- 未完成修复后的浏览器重测、1024 宽度、采用 / 取消 / 追问截图。没有删除失败任务、清空会话或突破本包冻结资源限制以重复生成成功证据。

固定合成项目从 revision 155 / 40 表 / 16 原件 / 17 页到 revision 160 / 41 / 17 / 18；只新增一份三行 CSV 及原件、一页和一个 Data 定义，复用原空会话后保留一条 failed task / 一轮消息。旧 56 个数据 / 原件文件字节和摘要一致，旧页面 / Notebook / 模型保留；历史 AppSpec 的来源目录按现有导入逻辑增加本批来源，不能宣称所有历史对象逐字不变。项目登记仍 100 条，无新登记、删除、快照或真实数据库操作。

三受管服务健康，PID / worker / revision / 启动时间 / 重启数与开场一致；稳定 release 不变，无启停、重启或发布。分支 `feature/eds-analysis-dashboard`，保留开场 331 项未提交状态，未提交 / 推送 / 合并 / 切分支、升级依赖或改锁文件。本批生产改动仅开发源码；3000 未发布。

收尾 Git 状态共 336 项，新增五个文件包含纯选域入口、工厂、测试、浏览器脚本和专项报告；其他修改保留原工作区，不据数量判断内容属于本批。任务日志追加前历史 413,604 字节已单独备份，追加后核对字节前缀。修复后的完整浏览器两轮验收、原件导入到最终结果的一次连续成功证明和 M7 其余纵向回归保留后续，不把本批失败发现包装成整阶段完成。
