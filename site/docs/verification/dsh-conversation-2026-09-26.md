# DSH 独立对话入口第一批 · 2026-09-26

## 交付范围

- `/dsh` 为网站过渡界面，复用现有 Notebook / 项目 / 数据功能；不是官方DSH Web已嵌入。入口切换先保存并flush，再同标签导航；不默认创建双写窗口。
- 专用JSON / SSE / clear API固定DSH与独立服务端命名空间，原入口 / 全局引擎选择不变。
- 普通回答 / 澄清无需草稿，DSH按需调用受控工具；本轮实际运行可以直接作为证据，不强制先检索。修改仍须真实试运行、提交成功草稿并经用户确认。
- 新旧会话按既有ID字段的集中前缀分类，保留完整项目session数组和原schema；列表、清除、刷新按入口隔离。容量满时拒绝新入口，不覆盖历史。
- profile / broker / SDK双端核对；仅新conversation profile可无工具，授权失效和未知异常不吞。

## 非交付范围

官方Web Host、boot graph、Gateway载体、原生DSH持久会话、全量插件 / Skill、便携包与3000发布均未实施。当前仍是每任务SDK临时环境 + 网站有界会话存储，不是无限上下文。选中来源过期 / 未授权仍可能在HTTP层拒绝；不会为聊天绕开数据权限。模型文本的逐句真实性不等于工具回执校验。

## 主要落地文件与边界

```text
app/dsh/                              网站过渡入口与布局
app/api/ai/dsh/conversation/           JSON、stream、clear 专用入口
app/api/ai/harness/conversation/       共用清除编排与命名空间
core/agent-engines/server/             DSH 对话交付规则、适配和真实证据验证
core/harness/                         会话分类、客户端、请求身份与恢复契约
core/repository/studio-repository.ts   项目保存与恢复时提供会话归属
runtime/dsh/                          profile、插件和 SDK 载体
components/studio/                    入口选择、聊天与执行状态展示
scripts/verify-dsh-conversation.mjs    限两轮的隔离浏览器验收
```

- `dsh-conversation-delivery.ts` 分离普通回复、工具解释与已修改草稿的交付规则；`readonly-answer.ts` 为新模式提供当前运行证据验证，经典路径保留原规则。
- `executor.ts` 可选第 4 个参数选择受控模式；`dsh-driver.ts`、`tool-broker.ts` 与 Runtime 双端核验 profile / 工具目录。载体修订为 7，本批没有升级 SDK。
- `assistant-sessions.ts` 集中 `AssistantExperience` 与新会话标识；`assistant-request-identity.ts` 的任务归属仅供浏览器恢复，不能选择服务端权限。不修改项目 schema。
- `StudioWorkspace.tsx` 组装体验，入口切换先保存 / flush 后同标签导航；聊天 hook、客户端和切换器使用对应端点 / 列表。当前仍复用工作台大组件，不宣称整站模块化已经完成。
- Notebook、Dataset、SQL、Python、语义查询继续调用原业务服务，DSH 插件只作受控适配；没有新增第二套计算器。实际业务编辑仍需成功试运行 / 提交与人工确认。
- 新增引擎、API、会话 / 恢复、客户端 / UI 回归测试；架构检查器把新路由加入指纹范围，补齐测试夹具里既有 Runtime 文件。没有删除业务实现。

## 本次验证

开始前 `npm run typecheck` 通过；针对引擎、DSH API 与聊天 hook 的基线为 531 项应用测试及 26 项 Node 工具测试通过。

| 最终命令 | 本次实际结果 |
| --- | --- |
| `npm test -- --maxWorkers=2` | 276 个文件通过、1 个文件跳过；3471 项通过、3 项既有真实 EDS 检查跳过；另 26 项 Node 测试通过。没有新增跳过。 |
| `npm run typecheck` | 通过，包括路由类型生成与 TypeScript 检查。 |
| `npm run build` | 通过，生成 standalone；保留非阻断的大分块 / 构建插件耗时警告，不代表发布。 |
| `npx eslint app components core fixtures scripts/check-agent-architecture.mjs scripts/check-agent-architecture.test.mjs scripts/verify-dsh-conversation.mjs scripts/dsh-conversation-fixture.ts --max-warnings=0` | 本次适用源码 / 新脚本范围通过，0 错误、0 警告。 |
| `node --test runtime/dsh/driver.test.mjs` | 19 项通过，包含新 conversation profile。 |
| `npm run docs:agent:test` | 1 项通过，覆盖新增入口的指纹监测。 |
| `npm run docs:agent:sync` / `npm run docs:agent:check` | 221 个源码文件指纹同步并核验通过。 |
| `node scripts/verify-dsh-conversation.mjs --offline` | 完整浏览器轮通过；2 次固定 driver 对话、0 次收费调用，10 图。 |
| `node scripts/verify-dsh-conversation.mjs --confirm-paid-model` | 完整浏览器轮通过；严格 2 次真实模型调用，无自动重试，10 图。 |

全仓 `npm run lint` **未通过**：既有配置会扫描 `.runtime` 便携产物并触发输出长度错误；排除这些产物后仍扫描到 vendor 与既有 `scripts/notebook-query-worker.cjs` 问题。本批自己的导航 lint 问题已修复，最后使用表中明确源码范围核验；没有修改全仓规则、关闭检查或把局部通过说成全仓通过。

日志保留在 `.runtime/dsh-conversation-*-20260926.log`。浏览器调试过程发现普通对话刷新被旧零工具 / 数据关键词规则误判，现已补充归属标记、恢复测试和保存刷新验收；另修正测试菜单定位与开发模块新 helper 的缓存导入问题。早期失败目录保留，不计为通过。

## 真实模型结果与调用边界

本次 `deepseek-v4-flash`、SDK `0.1.7-rc.2` 的两轮依次为“你是ds吗？先不要分析数据。记住本次合成测试代号晨星42”和追问代号。首轮正常解释身份，第二轮准确回答“晨星42”；两轮均 completed，各 1 次模型、0 次业务工具，无 Notebook 草稿。服务端附加“本轮为对话回复，未读取或计算数据，也未修改正式文档”以区分业务执行。

两轮使用真实专用 HTTP / SSE、官方 SDK、当前服务端模型配置和网站持久会话；不是固定答案替身。回执的 persistent 指网站 conversation store，并不表示 SDK 原生长会话。本次没有可靠 Token / 金额用量回执，不报告臆测费用。

测试只创建空白合成项目，没有业务文件上传、Notebook 执行、数据库查询或用户数据读取；正式 AppSpec / Notebook 定义逐次比对未变。失败 / 取消是明确的浏览器 SSE 替身，不宣称提供方取消测试通过。执行器前后均 dsh / revision 1 / activeTasks 0，没有改模型或全局引擎设置。

## 3001 实际截图

以下每一行均各有离线 / 真实模型轮两张图，共 20 张，主代理均已实际打开查看；两个证据目录另有 `visual-review.md`。所谓“真实模型轮图”中，后续失败 / 取消 / 容量场景仍为明确合成场景，不冒充真实模型故障。

| 页面 / 场景 | 本次截图 | 实际查看结论 |
| --- | --- | --- |
| /dsh · 1440 px 两轮回答 | [离线图](../../.runtime/dsh-conversation-20260926/browser-1790424758612/01-two-rounds-1440.png) · [真实模型轮图](../../.runtime/dsh-conversation-20260926/browser-1790424821720/01-two-rounds-1440.png) | 两轮正常完成，普通问答不要求草稿；预览边界和输入框可见。 |
| /dsh · 1024 px 两轮回答 | [离线图](../../.runtime/dsh-conversation-20260926/browser-1790424758612/02-two-rounds-1024.png) · [真实模型轮图](../../.runtime/dsh-conversation-20260926/browser-1790424821720/02-two-rounds-1024.png) | 自然换行 / 纵向滚动，无页面横向溢出，输入框可用。 |
| /dsh · 保存后刷新 | [离线图](../../.runtime/dsh-conversation-20260926/browser-1790424758612/03-reloaded-dsh.png) · [真实模型轮图](../../.runtime/dsh-conversation-20260926/browser-1790424821720/03-reloaded-dsh.png) | 两轮与 completed 状态恢复，无额外模型请求。 |
| / · 返回原入口 | [离线图](../../.runtime/dsh-conversation-20260926/browser-1790424758612/04-classic-isolated.png) · [真实模型轮图](../../.runtime/dsh-conversation-20260926/browser-1790424821720/04-classic-isolated.png) | 仅显示本入口“你好”及本地回复，DSH 历史不混入。 |
| /dsh · 菜单返回 | [离线图](../../.runtime/dsh-conversation-20260926/browser-1790424758612/05-dsh-restored-isolation.png) · [真实模型轮图](../../.runtime/dsh-conversation-20260926/browser-1790424821720/05-dsh-restored-isolation.png) | DSH 历史恢复，会话列表不显示经典入口记录。 |
| /dsh · 清除上下文 | [离线图](../../.runtime/dsh-conversation-20260926/browser-1790424758612/06-dsh-cleared-1024.png) · [真实模型轮图](../../.runtime/dsh-conversation-20260926/browser-1790424821720/06-dsh-cleared-1024.png) | 显示空态，专用 clear 生效、上下文轮换，旧入口不受影响。 |
| / · 清除后返回 | [离线图](../../.runtime/dsh-conversation-20260926/browser-1790424758612/07-classic-survives-clear.png) · [真实模型轮图](../../.runtime/dsh-conversation-20260926/browser-1790424821720/07-classic-survives-clear.png) | 原入口本地问候与回答仍保留。 |
| /dsh · 失败替身 | [离线图](../../.runtime/dsh-conversation-20260926/browser-1790424758612/08-failure-fixture-1024.png) · [真实模型轮图](../../.runtime/dsh-conversation-20260926/browser-1790424821720/08-failure-fixture-1024.png) | 失败说明 / 重试入口可读，不冒充成功；未点击重试。 |
| /dsh · 取消替身 | [离线图](../../.runtime/dsh-conversation-20260926/browser-1790424758612/09-cancelled-fixture-1440.png) · [真实模型轮图](../../.runtime/dsh-conversation-20260926/browser-1790424821720/09-cancelled-fixture-1440.png) | 点击取消后显示已取消，输入恢复；不是提供方取消实测。 |
| /dsh · 容量阻断 | [离线图](../../.runtime/dsh-conversation-20260926/browser-1790424758612/10-capacity-blocked-1024.png) · [真实模型轮图](../../.runtime/dsh-conversation-20260926/browser-1790424821720/10-capacity-blocked-1024.png) | 1050 条合成会话下显示返回入口与保护说明，存储字节不变。 |

两轮报告的页面异常、路由守卫失败、资源失败均为 0；刷新、新旧列表隔离、清除独立性与容量拒写均通过。证据：[离线报告](../../.runtime/dsh-conversation-20260926/browser-1790424758612/report.json)、[真实模型报告](../../.runtime/dsh-conversation-20260926/browser-1790424821720/report.json)。本地证据位于忽略目录，不会自动随 Git 推送。

## 保留边界与后续替换位置

- 官方 DSH Web Host / Gateway、原生持久 SDK 会话及全量插件 / Skill 未迁移；当前是独立对话入口第一批，不是整个提议最终完成。
- 本批真实收费验收只覆盖普通对话与上下文承接，未重新实测付费 Notebook / Excel / Python / SQL / 语义分析链；引擎离线测试覆盖工具回执、草稿验证及失败保护，不等同于真实模型分析质量。
- 当前每任务仍新建 SDK 环境；网站会话近期历史 / 摘要有界，不能承诺无限记忆。模型自然语言结论不能仅靠工具成功回执逐句证明。
- 已选来源无权限或失效仍可在 HTTP 层得到 403 / 410。工具授权、只读查询、取消、24 工具 / 180 秒保护及修改确认保留。
- `activeByPage` 是共享提示，跨入口会选自身最近会话，不是两份独立活动选择持久化。主动同标签导航降低双写风险，但没有实现跨标签协同锁。
- 替换模型协议主要在 `runtime/dsh/chat-adapter.mjs` / `driver.mjs`；更换对话宿主需迁移本批 API / 会话适配，不应复制业务服务。增加业务能力应先复用所属业务接口，再同步 broker / policy / plugin 的双端契约和回归测试。
- 旧 `/` 和原执行器仍保留作为回退，不删除旧 Harness 契约 / 工具桥。当前没有未经验证的“所有插件即插即用”承诺。

## 工作区与启用状态

分支仍为 `feature/eds-analysis-dashboard`；已有修改和未跟踪文件全部保留，本批未提交 / 推送、切换分支、安装依赖或升级 SDK。工作区中的 Runtime 安装 / 锁文件及 Notebook 自动运行等其他差异属于先前任务，不计作本批新增。

最终 `npm run site:status` 显示 3000 / 3001 / 3198 均健康，运行 revision / PID 与本批基线一致；没有启动、停止或重启服务。源码在 3001 的 `/dsh` 可用，未执行 `site:publish`，3000 和 GitHub 便携包未更新。
