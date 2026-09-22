# DSH cellSearch 与只读交付调试 · 2026-09-22

## 范围与证据

本次修复限于 DSH 的安全工具诊断、已有 Notebook 的只读回答及相关取消/授权边界。不更换 Agent，不增加工具次数，不改数据库权限、正式文档或草稿采用规则；原 Harness 路径不变。

历史截图对应的任务在两次检索失败后取得检索/运行成功，但最终因“缺少本任务成功提交的草稿”失败。历史日志没有保存失败参数，不能断言两次 `cellSearch` 究竟哪个字段错误。`0.0s` 是十几毫秒格式化后的显示，不代表工具没有执行。

确认的完成契约问题：用户问“现在是分析了什么东西出来”，原 DSH 只接受已编辑、已运行、已提交的草稿，丢弃驱动最终回答；未修改定义的运行也不能提交草稿。因此解释已有结果被错误要求创建修改。

## 实际模块边界

- `core/agent-engines/server/readonly-answer.ts`：保守识别已有单元解释/检索，检查本任务真实工具证据，生成有限长度、脱敏后的只读回答。未知意图或正向修改请求仍走原草稿路径。明确不运行的请求只开放检索。
- `core/agent-engines/server/dsh-engine.ts`：只读任务裁剪工具目录、收集任务私有观察、核对授权/取消/桥生命周期并交付 `completed`，不产生草稿。结果问题接受当前成功运行的规范结果样本，或同运行同版本的 AI 输出页；不是把模型文字当运行证明。
- `runtime/dsh/policy.mjs` 与 `server/tool-broker.ts`：共用封闭工具目录校验，允许仅检索、检索加运行及原完整草稿组合；拒绝半写组合。只读模式不开放编辑/提交。
- `core/agent-engines/server/tool-error-message.ts`：将可信参数错误转换为安全 Schema 字段路径与错误码，经重新授权后写入原任务事件和 SSE。未知异常、取消和撤权不公开原始异常、参数或内部路径。
- `core/notebook/search.ts` / `core/harness/notebook-cell-search.ts` 的错误子类保留已有基类及内部消息，以五个有限错误码标记定位/版本/运行/预算失败。broker 严格 DTO、插件及页面共用 `runtime/dsh/tool-diagnostics.mjs` 固定提示；原始值不传出。
- Notebook 工具仍归属 `core/harness/notebook-cell-tools.ts` / `notebook-cell-search.ts` 与既有 Notebook runtime；DSH 不另实现计算、数据访问或草稿采用。

取消或撤权后不允许用较早的成功检索“恢复完成”。在验证开始/结束与最终交付之间复查授权及桥有效性，错误终态不保留 `verification.passed`。

## 浏览器与付费测试记录

使用 3001、新建隔离项目、合成 CSV（East 150 / South 80）及三个已有单元。禁止操作用户原项目；不发布 3000，不启停服务。

1. 首次真实模型尝试保留为失败：[报告](../../.runtime/dsh-readonly-browser-2026-09-22/browser-1790061833518/report.json)。5 次模型、5 次工具调用，一次检索失败、三次检索成功、一次运行成功。模型取得运行返回结果后结束，但当时校验错误地强制要求额外 `cellSearch(output)`，故拒绝交付。运行工具本来已返回真实结果，修复为校验这些规范引用，不放宽为只凭成功状态。此轮第一个检索失败仍只有通用消息，不能据此断言参数原因。
2. 安全参数提示的[独立离线 UI 验收](../../.runtime/dsh-diagnostic-browser-2026-09-22/browser-1790062028887/report.json)采用固定驱动触发真实 Schema 错误并回放真实事件，1440/1024 两图已查看；不冒充真实模型失败原因或公开 HTTP 模型成功。
3. [第二个隔离项目的真实复验](../../.runtime/dsh-readonly-browser-2026-09-22/browser-1790062927074/report.json)通过：一次公开任务、4 次模型调用、3 次工具调用；真实第一步得到 `notebook_search_version_stale`，明确是传入的草稿版本不匹配，不能证明它与历史截图原因相同。模型收到固定提示后自行重新检索，再运行已有单元，直接使用返回结果回答 East 150 / South 80，最终 `completed`。没有修改、提交或采用草稿，正式 Notebook / AppSpec / 数据源数量对比通过，页面与拦截异常为 0。
4. 主代理实际查看准备页、[1440 回答](../../.runtime/dsh-readonly-browser-2026-09-22/browser-1790062927074/02-real-readonly-answer-1440.png)、[错误后自行恢复及完成](../../.runtime/dsh-readonly-browser-2026-09-22/browser-1790062927074/03-real-readonly-trace-1440.png)、[1024 折叠完成状态](../../.runtime/dsh-readonly-browser-2026-09-22/browser-1790062927074/04-readonly-answer-1024.png)，并复看首轮失败与离线安全参数提示。沿用纯文本渲染，Markdown 标记仍按文字展示，不在本轮扩展富文本。

本次两次付费公开任务合计 9 次模型调用（首轮 5、复验 4），没有第三次调用；公开任务数量不是内部模型调用数量。未取得完整计费用量，不推算费用。第一次失败与第二次成功证据均保留。取消/撤权由离线真实引擎测试覆盖，本次未额外收费做取消场景。

## 保留边界

- 意图识别是保守规则，不是全语言理解；未知请求保持原草稿路径。
- 证据校验保证工具来源/运行/范围与版本，不逐句证明模型解释、推断或数值表述正确。结果仍可能是有界样本，不能当完整结果仓库。
- 不恢复历史未记录的参数；新增安全诊断只影响后续调用。
- SDK 依赖风险沿用上一批报告，本次不升级依赖、不重新宣称安装安全。
- Excel/Python/外部数据库全链不是此次只读合成数据验证范围。
- 既有工作区修改保留，无提交、推送、分支切换或生产发布。

## 验证收尾

| 本次实际命令 / 检查 | 结果 |
| --- | --- |
| `npm test -- --maxWorkers=2` | 255 文件 / 2,819 应用测试通过，原 1 文件 / 3 项跳过保持；后续 26 Node 工具测试通过 |
| `node --test scripts/check-agent-architecture.test.mjs runtime/dsh/driver.test.mjs runtime/dsh/tool-diagnostics.test.mjs` | 19/19：15 官方 SDK 离线、3 安全诊断、1 架构守卫 |
| `npm run typecheck` | 构建后复查通过，无新增类型错误 |
| `npm run build` | 通过，保留既有大 chunk 提示，不发布或启动产物 |
| 本次 25 个 TS/MJS/声明文件严格 ESLint | 通过，无忽略检查或放宽断言 |
| `npm run docs:agent:sync` / `npm run docs:agent:check` | 正文/变更先更新，191 源码指纹一致；新增 policy 声明纳入守卫及测试 |
| 两个真实付费任务 / 新截图 | 首轮失败保留；修复后复验通过，模型自行纠正版本错误，无第三次付费 |

日志位于 `.runtime/dsh-debug-*.log`。针对测试先复现只读任务被强制提交及取消/撤权误报完成，再修复并通过；没有删除失败测试。源码生产部分冻结后进行最终真实复验和全量回归。

服务前后检查：三个服务健康；PID/worker、版本、启动时间、重启次数、稳定站 release 与开场一致，DSH revision 7 / activeTasks 0 保持。源码默认引擎仍原 Harness，不把当前进程选择当跨重启配置。源码与 3001 已验证，3000 未发布。

工作区：`feature/eds-analysis-dashboard`，开场 376 条已有 Git 状态保留，收尾 381 条（状态条目不等于改动文件总数）；没有提交/推送/切分支。任务日志开场副本按字节前缀检查保留，期间其他任务追加也保留。隔离合成测试项目、首次失败证据与成功截图均留在忽略的 `.runtime/`，没有删除用户文件或改写真实业务数据。
