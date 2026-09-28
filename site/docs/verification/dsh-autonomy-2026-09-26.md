# DSH 独立上下文与分析说明交付

日期：2026-09-26。范围限定为上下文组装与已验证草稿的最终说明；不升级 SDK、不新增插件、不改工具 / 权限 / 预算 / 模型推理模式。

## 实现

- `core/agent-engines/server/dsh-context.ts`：DSH 独立投影当前授权环境；不调用旧 Harness 规划选择器。只传字段 / 来源 / 连接 / Notebook 元数据，不传源码和原始行。历史消息保留原请求契约内完整尾部并脱敏，仍标记为非证据，不扩展服务端记忆。
- `dsh-delivery.ts`：草稿回执验证成功后展示脱敏模型说明；权威待确认状态始终置前。冲突保存声明退回状态提示，模型文字不能生成或确认草稿。
- `dsh-engine.ts`：调用上述两个独立边界，保留业务工具桥、只读分支、预算与取消。
- `core/harness/security.ts`：分离完整脱敏和原1000字符显示裁剪，原调用方行为不变；`task-state.ts` 确认 / 拒绝时保证末尾状态更新不因较长说明消失。

## 验证

| 实际检查 | 本批结果 |
| --- | --- |
| `npm run typecheck` | 开工及最终均通过 |
| `npm test -- core/agent-engines/server --maxWorkers=2` | 修改前15文件405项 + 26项Node工具测试通过 |
| `npm test -- core/agent-engines/server core/harness/security.test.ts core/harness/notebook.test.ts core/harness/deepseek-harness.test.ts --maxWorkers=2` | 20文件522项 + 26项Node工具测试通过 |
| `npm test -- app/api/ai/harness/dsh-engine.route.test.ts --maxWorkers=2` | JSON / SSE入口48项 + 26项Node工具测试通过 |
| `npm test -- --maxWorkers=2` | 最终272文件3406项通过，1文件3项原有实工作簿用例因未提供原件路径跳过；随后26项Node工具测试通过 |
| 严格ESLint | 本批12个源码 / 测试 / 脚本文件零警告通过 |
| `npm run build` | 通过；保留原大分块警告，未发布 |
| `npm run docs:agent:sync` / `npm run docs:agent:check` | 正文同步后更新并核查源码指纹 |
| `git diff --check` | 通过，只有既有LF / CRLF提示 |

新增28项应用测试涵盖：不加载旧上下文选择器、授权来源投影、对话尾部保留 / 脱敏、历史状态不是证据、上下文副本不共享可变对象、真实SQL试运行后交付说明、缺回执不交付、冲突保存声明、长说明后的确认 / 拒绝状态。完整回归首轮仅2项旧HTTP断言失败：原断言禁止一切模型说明，与新展示要求冲突；更新展示断言，同时保留真实回执 / 状态 / 事件 / 正式定义未变检查，并增加2项冲突声明拒绝检查后重跑全部通过。未删除或跳过失败测试。

本地日志：[`基线`](../../.runtime/dsh-autonomy-baseline-20260926.log)、[`专项`](../../.runtime/dsh-autonomy-targeted-20260926.log)、[`路由`](../../.runtime/dsh-autonomy-routes-20260926.log)、[`首轮回归`](../../.runtime/dsh-autonomy-full-20260926.log)、[`最终回归`](../../.runtime/dsh-autonomy-full-final-20260926.log)、[`类型`](../../.runtime/dsh-autonomy-types-final-20260926.log)、[`构建`](../../.runtime/dsh-autonomy-build-20260926.log)。

### 收费模型：部分证据，未计完整通过

执行一次 `node scripts/verify-dsh-autonomy.mjs --confirm-paid-model`，使用网站当前配置的 `deepseek-v4-flash` / DSH `0.1.7-rc.2`，实际通过3001公开API、SDK和供应商；仅新建三行合成销售项目，没有用户数据。未修改模型、密钥、引擎选择或预算，也没有自动重试。

页面已显示四单元草稿、生成阶段试运行通过及分析说明，截图可见合计230、地区差异和样本局限。但验收脚本用Playwright `response.text()`读取SSE时发生CDP响应体丢失，浏览器关闭时本地预览仍在运行。没有取得完整终态JSON，未完成该收费任务的确认 / 保存重开；不能把界面片段当成全链路通过，也未统计费用或Token。

[`真实模型现场图`](../../.runtime/dsh-autonomy-20260926/browser-1790410685774/failure.png)已实际查看；[`失败机器报告`](../../.runtime/dsh-autonomy-20260926/browser-1790410685774/report.json)保留原失败状态。内存幂等缓存没有安全只读恢复入口，未重新发请求以避免再次计费。后续脚本改为浏览器内立即克隆流读取，并先落盘任务证据；此采集修正仅在离线模式复验，未再次运行收费任务。

### 浏览器：离线模型替身 + 真实引擎与计算

`scripts/dsh-autonomy-fixture.ts` 用固定模型驱动调用真实 `runDshEngine` / Notebook工具桥 / DuckDB SQL / SSE；`scripts/verify-dsh-autonomy.mjs --offline` 在3001新合成项目回放该SSE。模型所在验收进程拒绝网络且不读取环境凭据；后续页面调用真实Notebook运行和项目保存接口。不是收费SDK或公开AI handler端到端的替代证明。

成功检查：一份Data → SQL → Table → Chart草稿真实计算East150、South80；待确认时正式Notebook不变；网站自动预览一次成功，确认保存保留结果；刷新不重跑模型 / Notebook；合成失败回执与停住传输后的取消均不产生新草稿、正式定义不变。页面错误0、路由错误0，未修改正式看板或引擎配置，收费调用0。

首轮离线验收到重开成功，但负向fixture遗漏服务端 `role`，被响应Schema拒绝；修正为隔离editor角色后全轮重验通过，未修改产品校验。最终[`机器报告`](../../.runtime/dsh-autonomy-20260926/browser-1790411380961/report.json)和[`引擎任务回执`](../../.runtime/dsh-autonomy-20260926/browser-1790411380961/analysis-task.json)保留。

下面6图均为本批3001实际截图，主代理逐张查看；fixture正文明确标注离线模型替身。

| 场景 | 实际图及结论 |
| --- | --- |
| 待确认 + 分析说明 | [1440截图](../../.runtime/dsh-autonomy-20260926/browser-1790411380961/01-dsh-analysis-pending.png)：状态、金额与局限可读，确认 / 撤销可用 |
| 窄桌面 | [1024截图](../../.runtime/dsh-autonomy-20260926/browser-1790411380961/02-analysis-narrow.png)：正文换行无页面横溢，顶部原持久化提示盖住部分标题 |
| 确认保存 | [截图](../../.runtime/dsh-autonomy-20260926/browser-1790411380961/03-confirmed-analysis.png)：Notebook显示已保存且保留运行结果，草稿操作消失 |
| 刷新重开 | [截图](../../.runtime/dsh-autonomy-20260926/browser-1790411380961/04-reopened-explanation.png)：历史分析说明保留，不自动再分析 |
| 失败 | [截图](../../.runtime/dsh-autonomy-20260926/browser-1790411380961/05-failure-no-analysis.png)：新失败回合只有失败提示，不借用上轮成功说明 |
| 取消 | [截图](../../.runtime/dsh-autonomy-20260926/browser-1790411380961/06-cancelled-no-analysis.png)：显示已停止与重试，正式定义不变 |

表 / 柱状图在页面下方，本批截图以说明与确认状态为重点，不声称所有结果同时可见。历史对话保留生成时的“待确认”原回答；确认后的当前状态由Notebook状态条 / 任务回执表达，本批没有改写聊天历史。

## 工作区与启用

当前分支 `feature/eds-analysis-dashboard`。保留全部开工未提交修改，特别是Notebook自动预览与独立DSH升级批次；本批没有修改SDK、依赖锁、模型模式或原Harness执行循环。新增两个运行模块、三个单测文件、一个离线fixture和一个显式验收脚本；修改DSH引擎 / 单测、HTTP入口测试、共用脱敏 / 确认消息，以及架构 / 视觉 / 本报告 / 任务记录。没有本批源码删除或迁移持久化格式。

源码 / 3001热更新已生效。最终 `npm run site:status` 的3000 / 3001 / 3198均健康，进程、revision和重启计数与本批开工一致；[状态日志](../../.runtime/dsh-autonomy-status-final-20260926.log)。未启停服务、发布3000、更新GitHub附件、提交或推送。验收目录只保留本批合成项目与截图，不操作用户项目。

## 保留边界

仍使用既有只读请求识别、Notebook工具桥与Harness公共DTO；不是完全解耦所有业务契约。未开放终端、网络、跨项目文件或MCP插件；24次工具 / 180秒等保护和 thinking disabled 不变。没有新增完整长期记忆，历史最多10轮且受原持久化 / 请求边界约束；服务端存储仍可能先截取1000字符，本次不能恢复已丢失历史。模型说明不是逐句正确性证明，状态冲突过滤不是完整语义安全机制。

没有相同输入 / 模型的前后对比，不声称“推理质量已提升”。未新验收原始Excel、Python、外部数据库实库、生产数据、便携包或供应商 / 数据库取消。这里只降低DSH上下文对旧规划器的耦合，并恢复已验证草稿的解释出口；后续调整上下文主要改 `dsh-context.ts`，展示改 `dsh-delivery.ts`，工具和验证仍归业务桥，模型 / SDK继续由既有driver适配器管理。
