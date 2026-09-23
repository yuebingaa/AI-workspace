# 对话重试入口恢复 · 2026-09-23

## 冻结范围

用户要求继续现有工作、暂不规划 M8 后续；本批不新增任何阶段，只修复已存在的失败会话重试入口丢失。开工完整阅读运行规则和近期任务，查看相关架构 / 视觉 / 恢复入口；保留 75 项既有 Git 修改。服务状态、类型、209 文件指纹及原两文件 51 项测试基线通过。

实际原因：会话切换无条件清空 `aiRequestError`；首次加载仅恢复最后消息状态；备份恢复先清错误后没有补回。按钮却由 `lastSubmittedInstruction && aiRequestError` 决定，因此失败仍显示但无法重试。独立只读执行实际切换代码复现 status=error / error=null / canRetry=false；随后补三种终态自动测试，3 失败 / 27 通过，保留 RED 日志。不把未拍摄的修前浏览器界面称为截图证据。

## 修改与模块边界

- 新增 `components/studio/workspace/assistant-turn-state.ts`，只接收最后一轮消息，返回恢复后的状态 / 错误，无 React、网络、存储或服务端实现依赖。
- `workspace/assistant.ts`、`StudioWorkspace.tsx` 的切换 / 首次加载 / 备份恢复共用投影；待确认 ChangeSet 保持 success / 无错误及人工确认，不自动运行或采用。
- 切换时按聊天保留原 taskId，即使有限任务历史已淘汰详情；不伪造任务或从其他会话拿详情。`AiBuilderAssistant.tsx` 在无摘要时同文失败仍只显示一次，有不同当前任务则不隐藏新错误。
- 新增 helper 测试，扩展 `assistant.test.ts` 和 `AiBuilderAssistant.test.tsx`；新增隔离浏览器脚本 `scripts/verify-assistant-retry-restore-browser.mjs`。没有修改 CSS、后端 / 模型 / 数据库、Schema、依赖或存储格式，没有删除文件。

重试仍是显式按钮动作，生成原有新幂等键；不承诺历史上下文、Excel / 图片附件在刷新后完整恢复。图片只在当前窗口按原会话 map 保留，File 不进入持久化；需要丢失附件时仍需重新添加并发送请求。服务器授权、当前页面 / 来源选择及 Notebook 编辑忙碌保护沿用原规则。

## 验证与启用

定向 3 文件 / 69 项通过：终态恢复、成功 / 空会话清错、任务淘汰、待确认任务、会话图片与不伪造缺件、无请求 / 执行 / 审计副作用、错误去重以及原聊天回归。七文件严格 ESLint 与类型检查通过。

本次实际执行：

| 检查 | 结果 |
| --- | --- |
| `npx vitest run components/studio/workspace/assistant-turn-state.test.ts components/studio/workspace/assistant.test.ts components/studio/AiBuilderAssistant.test.tsx --maxWorkers=2` | 3 文件 / 69 项通过，含 18 项新增回归；独立复核亦通过 |
| `npm test -- --maxWorkers=2` | 266 文件通过 / 1 跳过；3222 项通过 / 3 既有跳过；Node 工具单测 26 项通过，无失败 |
| `npm run typecheck` | 修改后及构建后通过 |
| 严格 ESLint（上述三测试、四生产文件；浏览器脚本单独检查） | `--max-warnings=0` 通过 |
| `node --check scripts/verify-assistant-retry-restore-browser.mjs` | 通过 |
| `npm run build` | 退出 0，standalone 构建完成；保留既有大于 500 kB 分块警告 |
| `npm run docs:agent:sync` / `npm run docs:agent:check` | 正文和变更记录已维护，209 个源码文件指纹一致 |
| `git diff --check` | 通过，未全仓格式化 |

完整[测试日志](../../.runtime/retry-restore-full-tests-final.log)、[构建日志](../../.runtime/retry-restore-build-final.log)、[构建后类型检查](../../.runtime/retry-restore-typecheck-postbuild.log)。构建日志中的 PowerShell `NativeCommandError` 包装对应 Vite 的分块警告，不是非零退出；已单独确认 `build_exit=0`。

## 3001 浏览器与截图

运行 `node scripts/verify-assistant-retry-restore-browser.mjs`：新隔离浏览器、临时 localStorage，真实页面 / 原 SSE 解析器 / 交互，回执明确为合成数据；全部 API 替身或拦截。6 组检查、5 次合成任务通过，页面异常及网络漏出为 0，真实模型、数据库、Notebook、本地项目读写均为 0。不是收费模型或实库重新验收。

9 张本次截图由浏览器代理及主代理逐张实际查看。包括 1440 工作台与 1024 Notebook 侧栏；失败、取消、受阻的会话切换 / 刷新均保留唯一正文和重试；成功 / 空会话无旧错误残留。恢复本身没有自动请求，人工重试只发一项新任务。导出本轮合成备份后先取消导入保持空会话，再确认导入恢复失败及重试，contextId 正常轮换。待确认 ChangeSet 和任务摘要淘汰由单元测试覆盖，不冒称本轮浏览器截图覆盖。

- [切回失败会话](../../.runtime/assistant-retry-restore-2026-09-23/browser-1790130860455/03-failed-switch-restored-1440.png)
- [刷新后侧栏](../../.runtime/assistant-retry-restore-2026-09-23/browser-1790130860455/04-failed-refresh-sidebar-1024.png)
- [取消后恢复](../../.runtime/assistant-retry-restore-2026-09-23/browser-1790130860455/06-cancelled-restored-sidebar-1024.png)
- [备份恢复](../../.runtime/assistant-retry-restore-2026-09-23/browser-1790130860455/08-backup-restored-retry-1440.png)
- [全部九图、页面 / 场景及逐图结论](../../.runtime/assistant-retry-restore-2026-09-23/browser-1790130860455/visual-review.md)，[机器结果](../../.runtime/assistant-retry-restore-2026-09-23/browser-1790130860455/report.json)

首轮浏览器夹具误用不存在的 `permissionDenied` 终止码，原解析器正确拒绝为 failed；仅将夹具改为已有 `missingRequirements` 后通过，未放宽契约或断言。首轮失败报告和 7 图保留并由浏览器代理实际查看，不作修前 RED 或最终通过证据。

## 状态与剩余边界

仅源码 / 3001 已验收，3000 未发布；三站健康，PID / worker、revision、启动时间、重启数与稳定 release 均与开工一致，supervisor 未变。当前分支 `feature/eds-analysis-dashboard`，原有未提交内容保留，收尾 81 项 Git 状态；本批无提交 / 推送、分支操作、删除或服务启停。任务日志与截图仍沿用原有忽略规则。

未重新验证真实收费模型、实库、用户原件、手机及全站历史功能；图片跨刷新仍不持久化，重试使用当前上下文，不是完整历史输入快照。既有 SDK 依赖风险和构建体积警告未在本批处理。未发现本批尚未处理的新增回归；不新增或规划 M8 及其后续阶段。
