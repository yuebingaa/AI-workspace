# DSH 主线第二批：原生会话恢复

日期：2026-09-26。范围固定为独立 `/dsh` 对话的原生接受历史、逐轮工具授权、清除 / 范围隔离与验证；不移植官方Web，不修改经典入口执行策略，不发布或打包新Release。

## 已实现

- `core/agent-engines/server/native-session-store.ts`：按服务端身份 / 项目、会话、页面哈希隔离；候选日志、原子head、跨进程锁、摘要及链接检查。失败候选和旧代不作为恢复来源。
- `native-conversation.ts`：授权范围指纹，清除旧网页上下文注入；仅completed / awaitingConfirmation且终检通过可提交。来源或能力变化先作废旧连续性，不因新轮失败回退旧权限历史。
- `runtime/dsh/session-server.mjs`：官方公开create/resume与通知；flush、dispose、子进程退出确认后才返回候选持久成功。每轮仍独立home / cwd / 配置及工具桥，不保留旧token。
- 既有 `dsh-engine.ts` / `dsh-driver.ts` / `executor.ts` / HTTP handler仅组装服务器绑定；公开请求无native路径参数。清除入口同步撤销原生head；任务回执可选new/resumed/reset状态供 `HarnessTrace` 展示。
- runtime carrier修订8，便携复制及架构指纹加入新载体文件；没有SDK升级或更换原技术栈。架构正文与视觉规范同步更新。

主要边界与接口：[Agent架构](../architecture/agent-architecture.md)；运行规则：[载体README](../../runtime/dsh/README.md)。

## 验证记录

开始时 `npm run site:status` 三服务健康；原469项相关应用、26项Node工具和类型基线通过。实现期间修复新闭包mcpRuntime类型推断、测试构造参数与postgresql枚举错误，未弱化检查。

`node scripts/verify-dsh-conversation.mjs --confirm-paid-native` 首次运行通过。3001全新隔离空白项目，2轮真实收费调用，第一轮new、浏览器刷新后第二轮resumed且记住合成代号；未调用业务工具 / 查询数据库 / 修改正式Notebook。请求、SSE回执与截图保留于[实际报告](../../.runtime/dsh-native-conversation-20260926/browser-1790426600232/report.json)。身份 / key不写本文。

同一次浏览器验收覆盖1440 /1024 px、刷新、原入口隔离、独立清除与容量拒绝。失败 / 取消为明确浏览器替身，不代表真实提供方故障；原生取消、写入失败、两进程工具租约与历史仅一次由官方SDK本地网关 / 固定模型测试覆盖。12张截图均由主代理逐张实际查看并更新机器报告标记：原生状态、清除、失败与取消可读，无横向溢出；1024 px展开trace时最后答案在下方滚动区，不声称整段都入图。真实模型为当前配置 `deepseek-v4-flash`、SDK `0.1.7-rc.2`，每轮1次模型调用、0工具；没有费用金额回执，不估算账单。

| 实际命令 / 检查 | 结果 |
| --- | --- |
| `npm test -- --maxWorkers=2` | 279文件 /3563项应用通过；既有1文件 /3项EDS跳过；另26项Node工具通过。无新增跳过 |
| `npx vitest run app/api/ai/dsh/conversation/route.test.ts components/studio/HarnessTrace.test.tsx core/agent-engines/server/native-conversation.test.ts core/agent-engines/server/native-session-store.test.ts core/agent-engines/server/dsh-driver.test.ts --maxWorkers=2` | 收尾95项通过，覆盖授权 / clear / lease / 本机持久化 / 状态文案。新增clear测试JSON为unknown已改为结构断言，无any / 忽略 |
| `node --test runtime/dsh/*.test.mjs scripts/check-agent-architecture.test.mjs scripts/package-portable-windows.test.mjs scripts/setup-dsh-runtime.test.mjs` | 78项通过，其中53项Runtime；固定SDK真实子进程和本机网关，无收费调用 |
| `npm run typecheck` | 最终通过；早期新闭包和新测试类型错误均修复 |
| `npm run build` | 通过；保留既有大于500kB chunk提醒，另有插件耗时提示。PowerShell将stderr警告包装为NativeCommandError文本，命令实际退出0 |
| 24个本批相关TS / TSX / MJS严格ESLint；最终HTTP测试重查 | 全部通过；没有重跑全仓lint，不把先前已知全仓问题记为已修复 |
| `npm run docs:agent:sync`、`npm run docs:agent:check` | 正文更新后同步224文件指纹，收尾复查通过 |
| 本批文件 `git diff --check` | 通过，仅原LF / CRLF转换提示 |
| `npm run site:status` | 收尾3000 /3001 /3198健康；PID、revision、重启次数与基线相同 |

日志：[全量应用及工具](../../.runtime/dsh-native-conversation-20260926/test-full.log)、[最终95项](../../.runtime/dsh-native-conversation-20260926/targeted-final.log)、[Runtime /打包契约](../../.runtime/dsh-native-conversation-20260926/runtime-packaging.log)、[类型](../../.runtime/dsh-native-conversation-20260926/typecheck-final.log)、[构建](../../.runtime/dsh-native-conversation-20260926/build.log)、[范围ESLint](../../.runtime/dsh-native-conversation-20260926/lint-scoped.log)。

关键截图：[原生新建](../../.runtime/dsh-native-conversation-20260926/browser-1790426600232/native-1-checkpoint.png)、[刷新后原生续接](../../.runtime/dsh-native-conversation-20260926/browser-1790426600232/native-2-checkpoint.png)、[1024 px状态](../../.runtime/dsh-native-conversation-20260926/browser-1790426600232/02-two-rounds-1024.png)、[清除成功](../../.runtime/dsh-native-conversation-20260926/browser-1790426600232/06-dsh-cleared-1024.png)、[失败](../../.runtime/dsh-native-conversation-20260926/browser-1790426600232/08-failure-fixture-1024.png)、[取消](../../.runtime/dsh-native-conversation-20260926/browser-1790426600232/09-cancelled-fixture-1440.png)。其余场景和逐图标记见上方实际报告。

## 保留限制

- 官方DSH Web仍未迁移：已读安装产物 / 源码，实际是独立React18应用、模块注入图与Host RPC，不是可直接导入网站React19的聊天组件。可评估同端口专用文档 / transport adapter；本次没有启动官方Web、开放任意RPC或新增端口。
- 原生历史持久化在本机 `STUDIO_LOCAL_STATE_DIR/dsh-native-sessions`，不是项目导出的一部分；未配置时沿用旧网站历史路径。不证明停机 / 断电一致性、跨机器迁移或无限上下文能力。
- 旧网站聊天只保留显示，不自动导入原生模型历史；数据 / 权限范围变化会重开。历史结果仍需当轮复核，不能复用旧草稿授权 / 成功状态。
- 日志包含用户正文和工具结果，仅配置key / broker token不自动落盘；不是通用秘密清洗、加密存储或Windows ACL隔离。清除为逻辑遗忘，私有旧代和失败候选保留；有显式存储保护，尚无清理UI，完整日志复制有增长成本。
- 两套存储清除不是跨存储事务；原生撤销成功后网站清除失败会明确报失败，可重试但可能丢失旧原生连续性。最终独立只读审查确认了这个多标签窄竞态：clear先持有原生锁，run已占网站会话锁时，clear可在撤销head后因网站busy返回409。没有物理删除、权限扩大或失败历史复活；本批保留保守拒绝，不宣称清除失败必然无副作用。残留锁须确认没有活跃实例后人工处理。
- 本轮真实模型只验证普通两轮续聊；未重新验收费Excel / Python / 实库 / 草稿分析，未重建或安装Windows完整包。
- 分支 `feature/eds-analysis-dashboard`；原有大量未提交改动均保留，本轮不提交 / 推送、不改用户项目、不操作稳定站。
