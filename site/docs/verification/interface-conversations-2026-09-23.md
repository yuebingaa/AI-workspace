# 工作界面独立会话验收 · 2026-09-23

## 结果与范围

已实现：同一项目内每个工作界面按稳定 `pageId` 拥有自己的会话列表、最近选中线程、文字草稿、回复与重试状态。AI 工作台和 Notebook 右侧助手共用该归属。任务执行等交互锁定期间不切换界面，完成 / 取消后恢复。左侧仍仅负责界面选择，没有增加视觉控件或 CSS。

`assistant-sessions.ts` 增加可迁移的 `pageId / activeByPage`、选择和旧记录拆分函数；`studio-repository.ts` 将保存版本升为 v7；`workspace/assistant.ts` 管理界面切换及按线程派生的窗口内图片，`StudioWorkspace.tsx` 处理恢复 / 备份和切换保护，`ConversationSwitcher.tsx` 过滤并标注当前界面。旧消息先按消息 / 任务的页面身份分开，未知消息和唯一旧草稿归最后已知页，无任何线索归初始空白页，不复制或清空；删除页面的历史仍保存在项目内。每界面新建上限 50，项目上限 1050 兼容旧 50 ×（20 轮 + 待返回页面）的最大拆分；备份仍限 5 MiB，旧版不读取 v7。服务端身份、项目授权及 Notebook 执行机制未变。

## 3001 实际浏览器验收

脚本：[verify-interface-conversations.mjs](../../scripts/verify-interface-conversations.mjs)。最终记录：[report.json](../../.runtime/interface-conversations-2026-09-23/browser-1790138005445/report.json)。隔离 Edge / 临时浏览器存储，只创建、保存和读取本轮自有合成项目；不读取用户项目，拦截不在允许范围内的写请求。三个工作界面含 DES / EDS，另用独立临时浏览器构造 v6 混合记录。四组检查通过，页面异常 / 意外路由异常均为 0。

AI 回复为明确合成 SSE，经真实前端解析 / 状态链处理，不是收费模型或分析结果。最终共 5 次合成任务请求（含一次人工重试），一次合成服务端清除；真实项目 API 创建 / 保存 / 读取。没有真实模型、外部数据库或 Notebook 运算。断言核对请求 pageId / conversation_id、每页消息与草稿、选择往返、保存重开、无自动重试、单次手动重试及清除不影响另一页；截图仅提供相应可见状态，不能替代完整数据断言。

以下 9 张均在最终源码上从 3001 新拍摄，主代理已逐张实际查看：

| 截图 | 场景与实际查看结论 |
| --- | --- |
| [01 · DES 失败](../../.runtime/interface-conversations-2026-09-23/browser-1790138005445/01-des-failure-1440.png) | 1440 px，DES 选中、失败回复、重试按钮和 DES 未发送草稿一致，没有 EDS 内容。 |
| [02 · EDS 会话菜单](../../.runtime/interface-conversations-2026-09-23/browser-1790138005445/02-eds-only-menu-1440.png) | 1440 px，只列 EDS 会话并标注“仅当前界面”，EDS 成功回复和草稿可见。 |
| [03 · 在途切换拒绝](../../.runtime/interface-conversations-2026-09-23/browser-1790138005445/03-inflight-switch-blocked-1440.png) | 1440 px，点击 DES 后仍停留 EDS，任务运行态与等待当前任务结束的原因提示实际可见。 |
| [04 · EDS 取消](../../.runtime/interface-conversations-2026-09-23/browser-1790138005445/04-eds-cancelled-1440.png) | 1440 px，原成功回复保留，新增取消卡与重试入口，不污染 DES。 |
| [05 · 保存刷新](../../.runtime/interface-conversations-2026-09-23/browser-1790138005445/05-eds-refresh-1024.png) | 1024 px，刷新恢复 EDS 标题、独立历史、取消状态和保存后草稿；刷新未触发新任务。 |
| [08 · 人工重试成功](../../.runtime/interface-conversations-2026-09-23/browser-1790138005445/08-eds-retry-success-1024.png) | 1024 px，取消后原句重试成功，回复仍归 EDS；聊天滚动到下方，早期成功消息在视口外，不宣称全文同屏。 |
| [09 · 清除不跨界面](../../.runtime/interface-conversations-2026-09-23/browser-1790138005445/09-des-survives-eds-clear-1024.png) | 1024 px，清除 EDS 后 DES 的选中线程和原成功回复仍在；Notebook 下方工具超出视口，不宣称整页同屏。 |
| [06 · 旧 EDS 迁移](../../.runtime/interface-conversations-2026-09-23/browser-1790138005445/06-legacy-eds-migrated-1440.png) | 1440 px，旧 EDS 失败 / 重试、唯一未知归属消息和唯一旧草稿保留，没有旧 DES 回复。 |
| [07 · 旧 DES 迁移](../../.runtime/interface-conversations-2026-09-23/browser-1790138005445/07-legacy-des-migrated-1440.png) | 1440 px，旧 DES 回复保留，无 EDS 错误或草稿；合计三条旧消息经同次断言确认全部且只保留一次。 |

AI 工作台 / Notebook 往返、每页记住最近所选线程和清除 EDS 的完整对象对比由同次浏览器断言覆盖，未额外截图。图片草稿 / 重试附件的线程切换由真实 React hook 重渲染单测覆盖，仍不持久化 File，未做图片专用浏览器截图。重名 / 改名按 ID 的隔离是纯函数验证，不声称截图演示了改名。

## 自动化与过程记录

- 新增 `core/harness/assistant-page-sessions.test.ts`，扩展 `components/studio/workspace/assistant.test.ts`；共新增 11 项回归，另将原图片 ref 测试改为实际 hook 状态测试。覆盖旧数据拆分、未标记归属、待返回任务、已删除页面历史、1000 轮最坏拆分保留、Schema 拒绝跨页混合、备份往返、拒绝跨页选线程 / 发请求、热更新旧状态与图片暂存。
- 最终全量 `npm test -- --maxWorkers=2`：268 文件通过 / 1 文件既有跳过，3304 项应用通过 / 3 项既有跳过，26 项 Node 通过。[日志](../../.runtime/interface-conversations-2026-09-23/full-tests-final.log)。
- 最终相关 4 文件 / 66 项应用及 26 项 Node 通过，[日志](../../.runtime/interface-conversations-2026-09-23/targeted-final.log)；正文与变更记录更新后执行架构指纹同步 / 检查，209 文件一致。
- 最终全局类型检查、8 文件严格 ESLint、脚本语法检查、生产构建均通过；[类型](../../.runtime/interface-conversations-2026-09-23/typecheck-final.log)、[ESLint](../../.runtime/interface-conversations-2026-09-23/lint-final.log)、[构建](../../.runtime/interface-conversations-2026-09-23/build-final.log)。既有大于 500 kB 分块警告保留。
- 初轮两个旧图片 ref 测试和 ESLint 渲染期 ref 规则未通过，调整为 React 状态及实际 hook 验证后修正；不将初轮失败算作通过。
- 浏览器前 3 轮因测试脚本断言失败：失败文案重复匹配、空聊天仍有欢迎容器、取消按钮名称不符；修正定位后通过。三个后续成功目录分别为 `browser-1790137710235`（7 图）、`browser-1790137810878`（9 图）及最终 `browser-1790138005445`（9 图）。早期证据均保留，不作为最终截图；本批共创建 6 个自有合成项目，无用户项目改动或删除。

## 启用与未验证边界

源码 / 开发站 `http://127.0.0.1:3001` 已验收，无新运行开关；稳定站 3000 未发布。结束时三站健康，supervisor 与各站 PID / worker / revision / 启动时间 / 重启数以及稳定 release 与开工状态一致，未启停服务。[结束服务状态](../../.runtime/interface-conversations-2026-09-23/site-status-final.log)。本批不包含手机、全站业务、收费模型、外部实库或真实 Notebook 计算重验；不把合成 SSE 当作后端模型能力证明。未读取或迁移真实用户项目，兼容迁移仅以本轮夹具和测试验证。
