# Harness 接口与排查索引

整理日期：2026-09-14。配合 [运行框架](04-Harness运行框架.md) 阅读。路径链接指向当前工作区源码；未来代码改变时，以唯一维护入口和实际代码为准。

## 1. 建议阅读顺序

| 顺序 | 入口 | 重点 |
| --- | --- | --- |
| 1 | [contracts.ts](../site/core/harness/contracts.ts) | 请求、模型动作、任务回执、状态、工作记忆、证据和事件契约 |
| 2 | [handler.ts](../site/app/api/ai/harness/handler.ts) | 请求与附件限制、服务端身份/项目授权、模型与工具依赖组装、会话与幂等 |
| 3 | [harness-composition.ts](../site/core/ai/server/harness-composition.ts) | 将私有模型配置转成 `createModelClient` 与运行策略；凭据不进入任务请求 |
| 4 | [coordinator.ts](../site/core/harness/agents/coordinator.ts) / [registry.ts](../site/core/harness/agents/registry.ts) | 单 Agent 回退、委派条件、只读白名单、父子验证与唯一交付 |
| 5 | [runtime.ts](../site/core/harness/runtime.ts) | 初始化、循环、模型/工具调用、修正、恢复、验证和失败解释 |
| 6 | [context-selector.ts](../site/core/harness/context-selector.ts) | 任务复杂度、相关数据、上下文预算、压缩、工具选择和工作记忆 |
| 7 | [execution-planner.ts](../site/core/harness/execution-planner.ts) | 步骤、允许工具、模型计划约束、同步与重规划 |
| 8 | [tool-registry.ts](../site/core/harness/tool-registry.ts) / [skill-registry.ts](../site/core/harness/skill-registry.ts) | 工具完整参数校验、调用领域实现、结果压缩、Skill 按需加载 |
| 9 | [evidence-bus.ts](../site/core/harness/evidence-bus.ts) / [task-verifier.ts](../site/core/harness/task-verifier.ts) | 证据来源和关联、实际工具覆盖、候选产物与完成检查 |
| 10 | [stream.ts](../site/core/harness/stream.ts) / [conversation-store.ts](../site/core/harness/server/conversation-store.ts) | 终止帧、取消、事件限制、主会话锁、有限历史与持久化 |

## 2. 关键接口分别跨越哪条边界

下表是接口摘要，不是完整可直接发送的请求 Schema。

| 接口或类型 | 生产者 → 消费者 | 主要信息 |
| --- | --- | --- |
| 公共请求 / `HarnessRequest` | 浏览器 → API → Runtime | 目标、页面/AppSpec、配方、选定数据、可选会话/Notebook/语义/附件上下文；API 重建身份与权限 |
| `HarnessRuntimeOptions` | 服务端组装 → Runtime | `modelClient` / `createModelClient`、数据运行时、授权复查、导出/Notebook/连接/视觉端口、预算、时钟、取消与事件回调 |
| `HarnessModelInput` | Runtime → 模型适配器 | 当前允许工具、有界上下文、轮次、输入估算与 AbortSignal；失败解释使用独立 purpose |
| `HarnessModelResult` | 模型适配器 → Runtime | 结构化动作、模型标识与真实用量；`next` 必需，语义分类/规划方法可选 |
| `HarnessExecutionPlan` | Planner → Executor | 当前步骤、允许工具、步骤状态、完成条件、来源、修订与重规划原因 |
| `HarnessToolExecutionResult` | 工具 → Runtime | 摘要、数据及可选 ChangeSet/导出/Notebook/分析计划/表结果；工具成功后形成 Observation |
| `HarnessTaskVerification` | Verifier → Runtime | 验收状态、检查项、问题与尝试轮次；结果不通过时不能当作已验收交付 |
| `HarnessTaskSummary` | Runtime/协调器 → API/浏览器/会话 | state、resultMessage、error、terminationCode、计数/用量/时间、计划/工作记忆/证据/验证、候选产物与可选委派 |
| `HarnessTraceEvent` | 执行过程 → SSE → Trace UI | taskId、sequence、类型、公开消息、工具/计划/验证摘要及可选 Agent 归属 |

**前后端边界：** 浏览器使用 [client.ts](../site/core/harness/client.ts)、共享契约和 SSE 解析器。DeepSeek 请求与凭据处理在 [deepseek-harness-model.ts](../site/core/ai/server/deepseek-harness-model.ts)；[deepseek-harness.ts](../site/core/harness/deepseek-harness.ts) 是服务端兼容入口。不要让浏览器组件从该兼容入口导入服务端能力。

## 3. API 与用户操作

| 入口 | 实际用途 |
| --- | --- |
| [POST /api/ai/harness](../site/app/api/ai/harness/route.ts) | 完整 JSON 回执；与 SSE 共用 handler |
| [POST /api/ai/harness/stream](../site/app/api/ai/harness/stream/route.ts) | fetch 响应流推送结构化执行事件，最后交付 task |
| [DELETE /api/ai/harness/conversation](../site/app/api/ai/harness/conversation/route.ts) | 清除指定范围的服务端会话；成功后客户端再清理聊天并更换会话 ID |
| [POST /api/ai/visualization-lab/stream](../site/app/api/ai/visualization-lab/stream/route.ts) | 服务端重建固定合成画布和数据的单 Agent 测试；不继承用户项目/Notebook/主会话 |

聊天状态与重试在 [workspace/assistant.ts](../site/components/studio/workspace/assistant.ts)；正文与重试按钮在 [AiBuilderAssistant.tsx](../site/components/studio/AiBuilderAssistant.tsx)；执行详情在 [HarnessTrace.tsx](../site/components/studio/HarnessTrace.tsx)。

## 4. 遇到问题先查哪里

| 现象 | 首先核对 | 代码入口 |
| --- | --- | --- |
| 模型没调用业务工具就结束 | 语义分类、复杂度、选中上下文、预算和 `terminationCode` | [上下文选择](../site/core/harness/context-selector.ts)、[Runtime](../site/core/harness/runtime.ts) |
| 工具名字存在却不允许调用 | 本轮 `selection.toolNames` 与计划 `allowedTools` 是否同时允许；是否处于只读子角色 | [执行计划](../site/core/harness/execution-planner.ts)、[角色注册](../site/core/harness/agents/registry.ts) |
| `contextBudgetExceeded` | 单次输入是否包含过大工具目录/历史、压缩前后估算、累计 Token | [上下文预算](../site/core/harness/context-selector.ts)、[共享预算](../site/core/harness/agents/budget.ts) |
| 重复同一个工具仍然失败 | 参数修正与恢复计数、失败指纹、是否缺少外部条件 | [Runtime](../site/core/harness/runtime.ts) |
| 看起来“完成”但没改看板 | 是否为 `awaitingConfirmation`，预览/确认是否执行；不要只看模型 message | [任务状态](../site/core/harness/task-state.ts)、[任务验证](../site/core/harness/task-verifier.ts) |
| 失败回复僵硬或错误重复 | `resultMessage` 是否生成、本地分类是否命中、解释策略/预算、当前聊天是否已经显示同一错误 | [失败说明](../site/core/harness/failure-response.ts)、[助手展示](../site/components/studio/AiBuilderAssistant.tsx) |
| 模型名称不一致或 Token 不可信 | 服务端实际模型配置、提供方响应 ID/usage、协议/格式错误 | [模型适配器](../site/core/ai/server/deepseek-harness-model.ts)、[模型错误契约](../site/core/harness/model-errors.ts) |
| 对话丢失或清除失败 | 会话/页面/项目命名空间、内存或私有快照模式、锁和清除 API | [会话存储](../site/core/harness/server/conversation-store.ts)、[会话客户端](../site/core/harness/conversation-client.ts) |
| SSE 结束却没有答案 | 是否收到合法终止 task、taskId/sequence 是否一致、是否断流/取消 | [SSE 协议](../site/core/harness/stream.ts)、[客户端](../site/core/harness/client.ts) |
| Notebook 能手动运行但 Agent 失败 | 区分计划/草稿预算与业务执行失败；核对 Agent 授权和试运行证据 | [分析规划](../site/core/harness/analysis-planner.ts)、[Notebook 工具实现](../site/core/harness/notebook.ts)、[执行用例](../site/core/notebook/server/execution.ts) |

## 5. 扩展时应该改哪一层

- **接入其他模型：** 实现 `HarnessModel`，在服务端组装。保留或明确替代模型标识、用量、超时和格式校验；补充契约测试。不要把供应商 HTTP 分支重新塞回 Runtime。
- **新增业务工具：** 同步工具名/参数契约、工具实现、上下文选择、执行规划、Verifier 与必要 Skill；若要给子 Agent 使用，还需明确更新角色白名单。当前这些步骤仍含人工维护的业务判断。
- **改善上下文：** 从 context-selector、工作记忆和会话摘录入手，用真实失败样例验证。提高预算或创建子 Agent 不是现成的自动策略。
- **新增专家角色：** 修改协调器、角色、协议与共享预算，定义受限上下文和证据回执；当前没有现成的并发或递归委派框架。
- **增强验证：** 将领域可确定的数值/来源/版本检查放进相应执行和 Verifier，再补真实场景验收；不能靠增加“请确保正确”的提示词代替证据。

## 6. 本次整理的检查与维护

本次只整理文档，核查源码入口、默认预算、角色白名单、状态和失败解释分支；执行架构指纹检查、本地链接检查与图片排版检查。详细结果、来源 SHA256 和生成时间写入 [Harness核对记录.json](Harness核对记录.json)，不把之前任务的应用测试写成本次重跑。

若未来改动 Harness 实现，先更新 [唯一架构入口](../site/docs/architecture/agent-architecture.md)，再在 `site/` 执行 `npm run docs:agent:sync` 与 `npm run docs:agent:check`，最后按改动范围验证。服务管理遵循 [STABLE-RUNTIME.md](../site/STABLE-RUNTIME.md)。本文件夹只是日期资料，不替代持续维护文档。
