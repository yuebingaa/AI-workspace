# Harness 实时执行与会话连续性

## 使用

开发站 `http://127.0.0.1:3001`：AI 工作台和看板侧栏共用同一个助手。执行过程随真实事件展开，结束后默认折叠，点击标题可重新查看。只有模型实际调用工具、生成计划或完成验收时才产生对应步骤；不会给纯聊天补齐四个绿色进度点。

ChangeSet 仍然必须先预览、再人工确认。`awaitingConfirmation` 表示预览准备完毕，不代表页面已修改或最终渲染已验收。稳定站 3000 不会随源码更新，需要单独验收并发布。

## 协议

原有 `POST /api/ai/harness` JSON 接口保留。新接口 `POST /api/ai/harness/stream` 接受相同 JSON 或 multipart（工作簿/图片）请求，新增可选 `conversation_id`。前端使用 `fetch` 读取响应体，不使用仅支持 GET 的原生 EventSource。

所有执行帧包含 `event` 对象：`id`、单调递增 `sequence`、`taskId`、`timestamp`、`type`、安全摘要 `message`；工具事件另带调用标识、名称、状态、实际耗时，计划事件带公共子任务说明，验收事件带状态和证据引用。没有 API Key、模型内部推理、原始图片或原始工具返回值。

```text
task_started → context_loaded → plan_created
  → tool_started → tool_completed / tool_failed
  → plan_updated（需要重规划时，可重复）
  → verification_started → verification_completed
  → completed { event, task }
```

`status_update` 同步实际运行阶段、计数和时间预算。`completed` 是“本次请求结束”，必须检查其中 `task.state`：completed / awaitingConfirmation / blocked / failed / cancelled，不能一概显示成功。

当前模型使用结构化 JSON 输出，最终答案在任务验收后通过终止帧完整返回。`answer_delta` 仅保留协议类型，目前不发送；不会把未验收文本展示给用户，也不会把完整答案拆字模拟流式生成。执行过程本身实时推送。

响应 MIME 为 `text/event-stream`，每帧以空行结束；10 秒注释心跳，关闭缓存和代理缓冲。正式部署仍须验证反向代理不会缓冲、平台请求时限能覆盖任务预算。规范依据：[MDN SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)、[MDN Fetch 响应流](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch)。

本机 Node 开发模式将 read-excel-file / write-excel-file 的 Node 依赖外置，避免 graceful-fs 在 Vite 的不可扩展 ESM 代理上定义属性，导致两个 Harness 路由加载时返回 500。此设置只用于受管 Node 开发模式，不改变 Cloudflare/生产构建。配置依据：[Vite SSR external](https://vite.dev/config/ssr-options#ssr-external)。

## 失败、取消与幂等

- 请求格式、角色与数据权限检查沿用共同处理器；流建立前失败仍返回 JSON + HTTP 状态码。
- 流建立后的准备错误返回 `stream_error`。没有最终任务回执、任务标识不一致、乱序、格式错误或超限都按失败处理，不推断成功。
- AbortSignal 从前端传到 Runtime、模型和工具。断开拥有该执行的原始连接会取消任务；取消不能回滚已执行的外部操作。订阅相同任务的第二个连接断开，不取消第一个连接。
- 相同身份命名空间 + idempotencyKey + 请求内容共享一次执行并重放已产生的事件；不同请求内容复用 key 会冲突。当前缓存为进程内、最多 100 个条目、完成后按原有 10 分钟 TTL 淘汰，不保证进程重启后的 exactly-once。
- 前端断流不自动新建任务重试。用户点击“重试”会显式启动新的任务/key。支持重新订阅同 key，不代表断网任务会自动恢复执行。

## Conversation Store

会话按现有身份命名空间、conversation_id、pageId 隔离；每个工作界面的 ID 保存在浏览器中。保存最近 10 轮问答、最多 2,000 字符的较早对话滚动摘录、Working Memory、当前选择的页面/数据/配方 ID、最近 10 个任务状态与目标。不是无限记忆，摘要是确定性的历史摘录而非额外模型推理。过期数据、截图和工作簿不会因为会话记忆而自动恢复授权。

服务端已知会话优先使用服务端历史；客户端近期消息仅用于新会话/旧 UI 迁移引导，并始终视为不可信连续性信息。Planner 和语义路由获取短摘要，Executor 获取受预算约束的近期消息及工作记忆；当前权限与本轮证据始终优先。

配置 `STUDIO_LOCAL_STATE_DIR` 时复用现有原子快照适配器，将对话记录保存到私有运行目录 `harness-conversations.json`。不存原始文件、图片、工具参数或工具返回；问答中出现的内容仍属于对话记录。未配置时明确标记 `conversationStorage=memory`；保存失败不丢弃已验收答案，但标记 unavailable，界面过程详情提示。最多 100 个会话，30 天未更新的会话在下次访问时清理。文件权限与锁沿用现有运行机制，不是额外加密系统。

“清除上下文”先调用 `DELETE /api/ai/harness/conversation` 清理服务端当前浏览器所关联的会话，再清理对话并更换 ID；失败时保留聊天并提示。任务/变更审计仍保留，此按钮不是删除全部历史或数据备份。当前项目仍是 demo-single-user 身份模式，并未因新增 Store 变成生产级多租户系统。

## 验证

```text
npm test
npm run build
node scripts/verify-agent-workspace.mjs
node scripts/verify-harness-stream-ui.mjs
```

离线测试覆盖 Runtime 发出事件的时机、路由校验、同 key 重放、UTF-8 分块/CRLF、缺少终止帧、取消、会话隔离/摘要/持久化与 Trace 状态。浏览器脚本使用独立上下文、合成数据和可控 SSE，不调用付费模型；截图与结果在 `.runtime/agent-workspace/` 和 `.runtime/harness-stream-ui/`。这验证通信和 UI，不宣称真实模型分析准确率。
