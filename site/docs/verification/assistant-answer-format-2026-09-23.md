# AI 成功回答格式化验收 · 2026-09-23

## 本批范围与实现

承接参数定义问答中已记录的粗体 / 代码标记原样显示问题，限定改成功答案的阅读体验；不重开 M7、扩充执行能力、改变模型与数据库实现或保存格式。本批基线已有 68 项 Git 修改，保留其他会话的工具分层、UI 和既有功能，不计作本批实现。

实际落地：

- `components/studio/assistant-answer-format.ts`：无框架依赖的有限块 / 行内解析。段落、粗体、单反引号代码、局部标题、至少两项连续平铺列表、完整三反引号代码；不是完整 Markdown。
- `components/studio/AssistantAnswer.tsx`：只接收字符串，通过固定 React 标签渲染；无 HTML 注入、图片、链接、脚本、网络、下载或执行按钮。
- `components/studio/AiBuilderAssistant.tsx`：仅 success 使用共用组件。AI 工作台 / Notebook 侧栏同一入口；失败 / 受阻 / 取消、用户输入、后备消息与 trace 保持原文。
- `app/studio-layout.css`：限定 `.compact-studio .assistant-answer` 样式，暖灰代码块、正文换行与代码自身横滚 / 键盘焦点。不改变其他页面样式。
- `components/studio/AssistantAnswer.test.tsx`、`AiBuilderAssistant.test.tsx`：格式、安全、内容保真和现有交互回归。
- `scripts/verify-assistant-answer-browser.mjs`：全新无持久浏览器，临时 localStorage，合成 SSE 经真实解析与 UI；API 替身和第二层网络拦截防止业务调用。

不添加依赖；不迁移 / 删除文件。接口仍是原字符串，不新增持久状态。之后调整展示只改纯解析与组件 / 局部 CSS，无需修改执行器。未知 / 未闭合围栏从该处起保守保留原文；超过 10,000 字符完整按文字显示、不截断。当前 response 契约仍保持原限制，本次长度保护不限制模型任务。

## 验证记录

开工 `npm run typecheck`、`npm run docs:agent:check`（209 文件）、`npm run site:status` 通过；原助手 / NotebookTextResult 两文件 28 项通过。实际离线测试禁止默认付费模型，不以本批 UI 验收代表业务重新计算。

新增回归过程中：初次 62 项有 4 项因早期测试把失败 / 后备消息也预期格式化而失败，按明确的 success-only 范围纠正对应断言；没有扩大生产接入。独立审阅实际复现两类保真缺陷，补 5 项 RED 测试：粗体内部代码含 `**` 误结束、未知围栏内部被当标题 / 粗体；修复后 75 项全通过。未知围栏保守处理不等于新增 C# 或波浪围栏语法。

实际执行（命令均在 `site/`）：

| 检查 | 结果 |
| --- | --- |
| `npx vitest run components/studio/AiBuilderAssistant.test.tsx components/studio/AssistantAnswer.test.tsx components/studio/notebook/NotebookTextResult.test.tsx --maxWorkers=2` | 3 文件 / 87 项通过；包括未修改的 Notebook 纯文本回归 |
| `npm run typecheck` | 开工、实现后和构建后均通过 |
| `npx eslint components/studio/assistant-answer-format.ts components/studio/AssistantAnswer.tsx components/studio/AssistantAnswer.test.tsx components/studio/AiBuilderAssistant.tsx components/studio/AiBuilderAssistant.test.tsx scripts/verify-assistant-answer-browser.mjs --max-warnings=0` | 六文件严格检查通过 |
| `node --check scripts/verify-assistant-answer-browser.mjs` | 通过 |
| `npm run build` | 通过；保留既有大于 500 kB 分块提示 |
| `npm run docs:agent:sync` / `npm run docs:agent:check` | 正文和变更记录更新后，209 文件指纹一致 |
| `git diff --check` | 通过；仅已有 CRLF 提示 |
| `npm test -- --maxWorkers=2` | 退出 0；265 文件 / 3,204 应用测试通过，原 EDS 原件缺失 1 文件 / 3 项跳过；随后 26 项 Node 工具测试通过。包含现有架构边界回归 |

日志：[相关测试](../../.runtime/answer-format-targeted-final.log)、[类型](../../.runtime/answer-format-typecheck-final.log)、[严格 lint](../../.runtime/answer-format-lint-final.log)、[构建](../../.runtime/answer-format-build-final.log)、[全量](../../.runtime/answer-format-full-tests-final.log)。

## 3001 实际截图与交互

最终 `node scripts/verify-assistant-answer-browser.mjs` 完成 8 组检查、10 次合成任务、9 张新截图；浏览器代理及主代理均逐张实际查看最终 9 图。所有模型 / Notebook / 数据库 / 项目 HTTP 业务请求为 0，页面异常、网络漏出为 0。全部 API 被替换或拦截，真实网络仅 3001 页面与静态资源；不是收费模型或实库端到端测试。

- [宽屏完整回答](../../.runtime/assistant-answer-2026-09-23/browser-1790129142883/01-formatted-workspace-1440.png)：1440 px，标题、粗体、代码、列表清晰，过程保持折叠。
- [刷新后窄侧栏](../../.runtime/assistant-answer-2026-09-23/browser-1790129142883/02-formatted-restored-notebook-1024.png)：1024 px，原字符串恢复且未重复任务，回答不撑宽页面。
- [失败与重试](../../.runtime/assistant-answer-2026-09-23/browser-1790129142883/06-failed-once-retry-workspace-1440.png)、[实际取消](../../.runtime/assistant-answer-2026-09-23/browser-1790129142883/08-cancelled-workspace-1440.png)：纯文本一次显示、原入口保留。
- [标记保真补验](../../.runtime/assistant-answer-2026-09-23/browser-1790129142883/09-inline-code-unknown-fence-workspace-1440.png)：代码中的 `**` 完整，未知 c# 围栏连同尾部按文字显示；另两个围栏变体独立 DOM 断言通过，没有冒称此图包含三者。

其余未闭合、安全内容、长代码、展开 / 收起过程的页面、场景及结论统一见[逐图记录](../../.runtime/assistant-answer-2026-09-23/browser-1790129142883/visual-review.md)与[机器报告](../../.runtime/assistant-answer-2026-09-23/browser-1790129142883/report.json)。长代码仅截图首段，代码框实际可横滚 80 px，全量内容由 DOM 比对，不冒称截图展示全部代码。

首次脚本错误预期取消正文包含“取消”，实际为“任务已经停止”，当时前六组已通过；改为原完整文案与取消状态断言后全套通过，没有生产行为修改或弱化检查。失败记录、旧轮 16 图仍保留且由浏览器代理实际查看；最终以新 9 图为准。证据位于原有忽略目录，本批未改变忽略规则。

## 启用与剩余边界

当前源码 / 3001；不发布 3000、不修改服务或执行器设置，无 Git 提交 / 推送 / 分支操作。三站健康、PID / worker、revision、启动时间、重启数和稳定 release 与开场逐值一致，supervisor 未变。仍为 `feature/eds-analysis-dashboard`，HEAD 未变；当前 75 项已有及本批未提交改动保留，没有清理用户修改。

真实模型、数据库、Excel 原件、手机、全部历史页面和端到端业务能力本批未重验；既有 SDK 依赖风险不因展示改动消失。不支持表格、嵌套列表和全部 CommonMark 语法，HTML / 图片 / 链接始终不创建活动元素。
