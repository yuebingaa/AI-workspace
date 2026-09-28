# 轻量化第一批（2026-09-27）

## 范围与当前工作记录

实施审查清单中的闲置模块与旧聊天展示清理；旧 Harness、规划 API、可视化评测 API、BI 原型、企业微信、云部署与数据能力保留。无依赖升级、持久化或权限改变。

- 修改前 7 文件 148 项针对性测试通过。
- 删除闲置客户端 / 限流器、3 个无人消费导出及 2 个专属测试。
- `AiBuilderAssistant` 从 497 行收敛到 315 行，去掉双界面开关、旧输入 / 消息分支与重复设置入口；`onSubmitInstruction` 为必需接口，正式确认 / 重试 / 导出等不变。
- 删除旧回答解析 / 展示、Trace / 诊断视图及其专属测试和 Trace 样式；仅删除前端，保留后端事件 / 诊断和旧 Harness。
- 按 CSS AST 清理 6 文件中 169 个包含已退役类名的规则或选择器，混合选择器中的现用规则保留；Notebook 仍使用的 `.composer-context-chip` 不删，未全仓格式化。
- 更新 DSH 输入委派与业务反馈回归。首次测试误将本轮备份源文件识别为测试，已将 19 份备份逐文件改为 `.before` 后缀，未修改测试发现配置或跳过测试。随后 4 文件 61 项通过；类型检查与目标 ESLint 通过。
- 修改前备份：`.runtime/lighten-20260927/baseline-2010/`。已有未提交改动包含在备份内，未覆盖其他工作；纯闲置已跟踪文件可从 Git 恢复。

## 验证与启用

本次验证全部结束，源码 / 3001 已生效；未发布到 3000、未更新便携包、未提交或推送。

| 实际命令 | 本次结果 |
| --- | --- |
| `pnpm exec vitest run components/studio/AiBuilderAssistant.test.tsx components/studio/AiBuilderAssistant.keyboard.test.tsx components/studio/dsh-web/default-entry.test.tsx components/studio/StudioHeader.test.tsx --maxWorkers=2 --reporter=dot` | 4 文件、61 项通过 |
| `npm test -- --maxWorkers=2 --reporter=dot` | 281 文件、3,565 项通过；1 文件、3 项按既有规则跳过；随后 26 项 Node 脚本测试通过 |
| `node --test runtime/dsh/web-client.test.mjs` | 17 项通过，官方固定版本的消息 / 工具事件适配未破坏 |
| `npm run typecheck` | 通过 |
| `pnpm exec eslint components/studio/AiBuilderAssistant.tsx components/studio/AiBuilderAssistant.test.tsx components/studio/AiBuilderAssistant.keyboard.test.tsx components/studio/AgentWorkspace.tsx components/studio/StudioWorkspace.tsx components/studio/dsh-web/default-entry.test.tsx --max-warnings=0` | 通过；不是全仓 lint 验收 |
| `npm run docs:agent:sync` / `npm run docs:agent:check` | 通过，234 个源码文件；正文与变更记录已同步 |
| `npm run build` | 完整成功回执；保留已有大 chunk 提示 |
| `node scripts/verify-dsh-default.mjs --offline` | 3001 浏览器检查通过，20 张本次截图全部实际查看 |
| 目标 `git diff --check`、退役源码静态引用检查 | 通过，未发现生产代码残留导入 |
| 起止 `npm run site:status` | 稳定 / 开发 / 截图服务均健康，PID 与重启数未变化 |

3 项跳过来自 `core/eds/server/real-workbook.acceptance.test.ts`，未配置既有真实工作簿路径，本批未增加跳过。全量 Mock Harness 评测 11 项通过，仅证明执行器 / 安全边界测试结果，不代表真实模型成功率。首次备份误收集的问题已解决，未关闭类型检查或修改测试发现规则。

## 实际删除与保留

共 14 个文件，分两组：

- 闲置 7 个：`core/ai/client.ts`、`client.test.ts`、`index.ts`；`core/ai/server/rate-limit.ts`、`rate-limit.test.ts`；`components/studio/index.ts`；`core/harness/mcp/index.ts`。
- 旧展示 7 个：`components/studio/AssistantAnswer.tsx`、`AssistantAnswer.test.tsx`、`assistant-answer-format.ts`、`HarnessTrace.tsx`、`HarnessTrace.test.tsx`、`HarnessNotebookDiagnostics.tsx`；`app/harness-trace.css`。

先核实实际入口、静态 / 动态引用、注册、脚本和测试，再退役。旧展示专属测试随实现删除；DSH 输入委派、失败反馈、错误文本转义、导出隐藏、权限 / 预览 / 忙碌确认矩阵在现用组件测试中保留或补齐。`AiBuilderAssistant.keyboard.test.tsx` 是任务前已有未跟踪文件，迁移到官方输入委派而非丢弃；真实 Enter / Shift+Enter 由浏览器另行验收。

主要修改集中在 `AiBuilderAssistant.tsx` / 测试、`StudioWorkspace.tsx`、`AgentWorkspace.tsx`、DSH 默认入口测试及 `app/` 的 6 个相关 CSS 文件；更新 README、架构 / 视觉文档和本报告。没有删除整个 `core/ai` 或 `core/harness` 目录，旧执行器、共享工具、请求 / 事件类型、服务端校验、草稿确认和持久化兼容仍保留。页面别名 `/dsh`、`/dsh/web` 继续可用，不新建重复聊天实现。

## 3001 逐图验收

采用本次独立浏览器和隔离合成项目；模型传输层为明确的离线回执，未使用真实密钥、实库或用户数据。官方 DSH iframe 资源实际加载；成功追问、两个别名重开、失败重试入口、取消及 HTTP 拒绝均检查。项目保存使用本地项目 API，清空只影响本次 DSH 测试会话；Notebook / 看板定义及预先写入的合成旧聊天逐字节保持。

以下均为本次新图，20 张已逐张实际查看，布局无横向溢出，输入区可见、不被空态引导遮挡；机器报告的 `actualImageReviewed` 在查看后才标记为 true。目录名沿用原脚本日期，`browser-1790511373757` 为 2026-09-27 本次运行。[机器报告](../../.runtime/dsh-default-20260926/browser-1790511373757/report.json)记录 0 页面错误、0 路由异常、0 资源加载失败、0 付费任务。

| 页面 / 场景 | 本次截图 |
| --- | --- |
| 首页空态，1440 / 2048 | [1440](../../.runtime/dsh-default-20260926/browser-1790511373757/01-default-home-1440.png)、[2048](../../.runtime/dsh-default-20260926/browser-1790511373757/01b-empty-home-2048.png) |
| Notebook 空侧栏，1440 / 2048 | [1440](../../.runtime/dsh-default-20260926/browser-1790511373757/01a-empty-notebook-sidebar-1440.png)、[2048](../../.runtime/dsh-default-20260926/browser-1790511373757/01c-empty-notebook-sidebar-2048.png) |
| 设置展开与底部，1440 | [展开](../../.runtime/dsh-default-20260926/browser-1790511373757/01d-settings-without-role-1440.png)、[底部](../../.runtime/dsh-default-20260926/browser-1790511373757/01e-settings-bottom-without-role-1440.png) |
| 数据菜单，1440 | [数据](../../.runtime/dsh-default-20260926/browser-1790511373757/02-header-context-menu-1440.png) |
| Shift+Enter 保留两行且不发送，1024 | [换行](../../.runtime/dsh-default-20260926/browser-1790511373757/03-shift-enter-workspace-1024.png) |
| 合成成功及追问，1440 | [成功](../../.runtime/dsh-default-20260926/browser-1790511373757/04-success-home-1440.png) |
| `/dsh`、`/dsh/web` 恢复同一会话，1024 | [别名 1](../../.runtime/dsh-default-20260926/browser-1790511373757/05-alias-1-1024.png)、[别名 2](../../.runtime/dsh-default-20260926/browser-1790511373757/05-alias-2-1024.png) |
| Notebook 带消息侧栏，1024 / 1440 | [1024](../../.runtime/dsh-default-20260926/browser-1790511373757/06-notebook-sidebar-1024.png)、[1440](../../.runtime/dsh-default-20260926/browser-1790511373757/07-notebook-sidebar-1440.png) |
| 失败与重试入口，1024 | [失败](../../.runtime/dsh-default-20260926/browser-1790511373757/08-failure-retry-1024.png) |
| 运行状态及停止，1024 | [运行](../../.runtime/dsh-default-20260926/browser-1790511373757/09a-running-inline-status-1024.png)、[取消](../../.runtime/dsh-default-20260926/browser-1790511373757/09-cancel-1024.png) |
| HTTP 预检拒绝，1024 | [拒绝](../../.runtime/dsh-default-20260926/browser-1790511373757/10-http-preflight-rejected-1024.png) |
| DSH 只读组件设置，1440 | [设置](../../.runtime/dsh-default-20260926/browser-1790511373757/11-dsh-settings-readonly-1440.png) |
| 清空测试 DSH 会话、保留旧聊天，1440 | [清空后](../../.runtime/dsh-default-20260926/browser-1790511373757/12-cleared-classic-preserved-1440.png) |
| 看板工具栏，1440 | [看板](../../.runtime/dsh-default-20260926/browser-1790511373757/13-dashboard-toolbar-clean-1440.png) |

## 边界与可恢复性

- 本轮是代码收敛，未重跑真实收费模型、数据库实库、实际 Notebook 计算、草稿采用 / 看板确认端到端；相关契约与权限由全量 / 针对性测试覆盖，不将导航截图算作执行验收。
- 不动 BI、旧规划 API、可视化评测后端、企业微信或云部署；不批量删除历史验收脚本。部分历史脚本仍针对旧界面，需要使用时独立迁移。没有测量网页 / 安装包体积、内存或性能收益。
- SDK、数据执行、权限 / 确认契约、项目格式、依赖与锁文件本轮均未修改；原工作树中这些路径的变化属于此前任务，不能算作本轮完成。
- 分支 `feature/eds-analysis-dashboard`，已有未提交与未跟踪内容保留。本轮改动也未提交；删除的已跟踪文件可从 Git 恢复，涉及既有修改的展示文件另有 `.runtime/lighten-20260927/baseline-2010/` 中 19 份 `.before` 备份，恢复时逐文件比对，不能整目录覆盖后续改动。未删除用户文件、项目、数据或已有运行包。
- 当前源码只保留一套聊天展示，旧 Harness 后端及共享业务仍有耦合，不能宣称全仓轻量化完成。构建仍有大 chunk 提示；依赖体积优化需单独测量。
