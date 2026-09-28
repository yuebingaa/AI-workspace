# DSH 网站执行约束清理 · 2026-09-28

## 本批边界

- 移除 DSH 默认 24 次业务工具、180 秒整轮、35 秒通用工具时限；服务端可显式配置可选预算，不再以上述值为硬上限。
- 浏览器跟随服务端可空截止时间；保留用户取消、断连、授权复核、SQL / Python 自身保护和模型网络超时。
- 移除 DSH 最终答复固定字数裁切，贯通验证、传输、展示、确认与保存；诊断摘要和输入上下文摘要仍有界。
- 保留旧 Harness、业务证据与草稿确认，不开放主机权限、不更换 SDK、不发布 3000。

## 工作记录

- 修改前基线：`node node_modules/vitest/vitest.mjs run core/agent-engines/server core/harness/client.test.ts core/harness/conversation.test.ts core/harness/task-state.test.ts --reporter=dot`：24 文件 / 556 项通过。
- 发现附带链路：任务 trace 最多 256 条，需要有界保留且维持 SSE 连续序号；长可见回复进入下一轮时仍需转为契约内的上下文摘要。
- 中间专项复测 27 文件 / 644 项通过；新增完整 HTTP/SSE 长回答案例后最终 27 文件 / 646 项通过。

## 实际修改

| 文件（均相对 site/） | 职责与变化 |
| --- | --- |
| `core/agent-engines/server/execution-policy.ts` | 三个网站预算默认 `null`，不再将旧值作为硬上限；保留可信部署可选配置 |
| `dsh-engine.ts`（同目录） | 仅在明确配置预算时设置计时器 / 检查次数；trace 独立递增并仅保留最近 256 条，实时流仍连续 |
| `dsh-context.ts`（同目录） | 明确 `null` 是未设置预算，删除最终说明“不超过1600字”指令 |
| `dsh-conversation-delivery.ts`、`dsh-delivery.ts`、`readonly-answer.ts`（同目录） | 完整脱敏并交付对话、只读和成功草稿说明；保留业务证据和保存状态校验 |
| `core/harness/contracts.ts`、`conversation.ts`、`task-state.ts` | 扩展共享消息契约，取消可见答案 2000 字符上限；确认 / 拒绝追加状态而不截正文；日志摘要仍有界 |
| `core/harness/client.ts`、`app/api/ai/harness/handler.ts` | `clientTimeoutMs: null` 贯通服务端 / 浏览器；独立 DSH SSE / JSON 默认不设置整轮时限，显式调用方超时、取消和旧 Harness 默认不变 |
| `components/studio/workspace/assistant.ts` | 保留完整回复，下一轮按现有请求契约投影最多 2000 字符的历史摘要，避免发不出第二轮 |
| 对应单测、`runtime/dsh/driver.test.mjs` | 增加超过旧次数 / 时间边界、完整答案、授权 / 取消与实际官方 SDK 离线回归 |
| `scripts/verify-dsh-execution-cleanup.mjs` | 新增可重复的隔离浏览器验收，禁止真实 AI 网络请求及用户项目写入 |

本批没有物理删除文件、移除原 Harness 或新增依赖；清理的是执行与展示链路中的固定额度和截字逻辑。未改 SDK、模型 thinking 配置、工具名称 / 参数及正式 Notebook 采用流程。

## 可选部署设置与保留边界

- `DSH_MAX_TOOL_CALLS`、`DSH_TOTAL_EXECUTION_TIMEOUT_MS`、`DSH_TOOL_CALL_TIMEOUT_MS`：不配置或设字符串 `0` 表示关闭；正整数表示运维显式启用，可以超过旧 24 / 180000 / 35000。非法值仍拒绝。可信代码传 `null` 关闭，不接受数值 `0`；超时受 JS 计时器有效范围约束。
- 未改用户环境配置；检查当前 `site/.env*` 未发现这三个显式配置项。不能据此推断外部启动环境永远没有覆盖值。
- 保留数据权限、同源校验、取消 / 断连清理、模型网络超时、SQL / Python 自身执行与结果大小保护、草稿验证和人工采用；不新增文件系统、Shell 或联网权限。
- 输入字数、上下文摘要、日志、HTTP/SSE 字节上限、项目快照和原生会话磁盘容量仍有限。完整可见回答不是把完整 Notebook 或所有历史再次注入模型；原生 DSH 会话沿用 SDK 接受点。
- 旧版本已经截掉的历史无法自动补回；扩展后的完整长回复只验收当前源码保存 / 重开，没有验证旧稳定构建读取新长回复的前向兼容。
- 未定位截图原任务为何重复调用到 24 次，也没有新增循环检测。解除固定额度可能增加耗时、内存和付费调用，需手动停止无效循环；提供方上下文与账户额度不受本次控制。
- `UNKNOWN` 通用失败码投影仍保留，本批未重做错误诊断协议。

## 验证结果

- 基线与中间专项命令：见工作记录；日志 `.runtime/dsh-cleanup-tests.log`。首次修改后 2 个失败分别是长文夹具脱敏后不足 2000 字、旧测试仍要求拒绝 1801 字答案；已改为真实长文夹具和新规格，保留空回答 / 笼统回答 / 脱敏 / 证据拒绝断言。
- 最终专项命令：`node node_modules/vitest/vitest.mjs run core/agent-engines/server core/harness/client.test.ts core/harness/client-deadline.test.ts core/harness/conversation.test.ts core/harness/task-state.test.ts app/api/ai/harness/dsh-engine.route.test.ts app/api/ai/dsh/conversation/route.test.ts --reporter=dot --maxWorkers=2`，27 文件 / 646 项通过，日志 `.runtime/dsh-cleanup-tests-final.log`。
- 核心回归：默认 134 次真实业务工具完成检索、SQL 试运行和提交；超过 256 条 trace 后 HTTP/SSE 仍能交付且序号连续。假时钟超过旧 35 / 180 秒不被网站中断，取消仍到达 runner；显式预算、权限撤销与失败草稿不交付仍生效。没有用真实模型消耗 134 次调用。
- `node --test runtime/dsh/driver.test.mjs`：21 项通过。真实固定版本官方 SDK / 子进程使用离线模型夹具完成 30 次工具与 4000+ 字最终说明，并验证进程回收；不是收费模型测试。日志 `.runtime/dsh-cleanup-sdk.log`。
- `npm run typecheck`：最终通过，交付前再次通过。首次曾遇到本批未编辑的 `StudioHeader.tsx` 使用不存在的 `DropdownMenu.Shortcut`；复查时工作区该处已改为 `shortcut` 属性，本批没有修改它。首轮 / 复查 / 交付前日志分别为 `.runtime/dsh-cleanup-typecheck.log`、`.runtime/dsh-cleanup-typecheck-final.log`、`.runtime/dsh-cleanup-typecheck-handoff.log`。
- 23 个本批涉及源码 / 测试 / 脚本的定向 ESLint 通过；最后新增 / 调整的 5 文件追加 ESLint 通过。日志 `.runtime/dsh-cleanup-lint.log`、`.runtime/dsh-cleanup-lint-final.log`。未执行全仓格式化。
- `npm run build`：通过，仍有 bundle 体积提示；只构建，不发布。日志 `.runtime/dsh-cleanup-build.log`。
- `npm run docs:agent:sync`、`npm run docs:agent:check`：247 文件源码指纹一致，正文 / 变更记录已维护。
- `node --test scripts/eds-browser-acceptance.test.mjs scripts/run-offline-tests.test.mjs scripts/copy-notebook-runtime.test.mjs`：26 项通过；首轮全仓 Vitest 失败会阻止 npm test 自动启动此阶段，因此单独实际执行。日志 `.runtime/dsh-cleanup-node-tools.log`。
- 全仓首轮 `npm test -- --reporter=dot`：3546 通过 / 73 失败 / 3 跳过；包括当前 UI 迁移的 Theme / DOM 断言不匹配及并行构建时 Python / 文件测试超时。日志 `.runtime/dsh-cleanup-full-test.log`。
- 低并发全仓复查 `npm test -- --reporter=dot --maxWorkers=2`：3576 通过 / 40 失败 / 3 跳过，13 文件未通过（含一个测试模块加载错误）。Python / DSH 执行链超时在该次复查未再失败；仍有 `AiBuilderAssistant`、Notebook / 文件删除等 UI 断言与现有 Radix DOM 不匹配，`StudioHeader.test.tsx` 当时无法从新 `test-support/markup.ts` 解析 `happy-dom`，以及未改动的 `core/notebook/server/available-capabilities.test.ts:70` 文件替换身份断言失败。日志 `.runtime/dsh-cleanup-full-test-low-concurrency.log`。本批未修改这些失败组件 / 测试、未安装依赖、未扩大范围；全仓明确不是通过。期间其他 UI 相关文件仍在变化，两次测试数量为各自执行时快照，不据此声称本批删除了测试。

## 3001 实际截图

运行 `node scripts/verify-dsh-execution-cleanup.mjs`，隔离新项目与浏览器、固定官方 Web 资源，AI 使用明确的浏览器传输夹具；读写的是本次新建的合成项目，未打开用户项目、修改设置或调用模型 / 数据库。实际保存原文为 3306 字符，第二轮上下文摘要为 2000 字符，原长回复仍完整保留。以下 6 图均已实际打开查看，正文末段、输入区、取消与失败提示可见，无横向溢出。

| 截图 | 场景与结论 |
| --- | --- |
| [完整答复末段](../../.runtime/dsh-execution-cleanup-20260928/browser-1790559687064/01-long-answer-ending.png) | 超过旧上限后，第36项及最终标记仍显示 |
| [刷新恢复](../../.runtime/dsh-execution-cleanup-20260928/browser-1790559687064/02-reopened-ending.png) | 项目重开保留完全相同的正文末段 |
| [继续提问](../../.runtime/dsh-execution-cleanup-20260928/browser-1790559687064/03-followup.png) | 原长回复和续聊成功同时可见 |
| [运行可取消](../../.runtime/dsh-execution-cleanup-20260928/browser-1790559687064/04-cancellable.png) | 官方停止按钮仍可操作 |
| [取消结果](../../.runtime/dsh-execution-cleanup-20260928/browser-1790559687064/05-cancelled.png) | 显示任务已停止，保存 cancelled，不冒充完成 |
| [失败结果](../../.runtime/dsh-execution-cleanup-20260928/browser-1790559687064/06-failed.png) | 失败状态及重试入口保留 |

[机器验收与实际查看标记](../../.runtime/dsh-execution-cleanup-20260928/browser-1790559687064/report.json)。这些是当前源码官方 UI / 持久化验收，不冒充付费模型或数据库实库端到端测试。

## 工作区与启用

分支 `feature/eds-analysis-dashboard`，原有大量未提交 / 未跟踪内容保留；本批没有提交、推送、stash、切换分支、删除用户数据或改锁文件。仅源码与 3001 开发站；未发布 3000、GitHub Release 或便携包，未操作生产系统。

`site:status` 收尾检查稳定站、开发站、截图服务均健康；期间观察到开发站重启次数从 0 到 1，本批没有执行启动 / 重启 / 停止命令，原因未另行调查，不能声称由本批发布。稳定站与截图服务未观察到重启。
