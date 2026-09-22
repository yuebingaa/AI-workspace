# DSH 检索失败定位与恢复（2026-09-22）

## 本轮边界

承接第三批真实任务失败，先验证当前 SDK 调度与工具契约，基于复现证据修补，不猜测上次未记录的参数。保留工具 Schema、授权、六次工具保护、人工采用和正式项目不变；不发布 3000、不更新依赖、不自动重复收费。

若离线确认调用链与诊断可靠，本轮最多再进行一次受现有验收网关约束的真实模型任务，以收集新证据，不把上次未知原因追认为已解决。失败后仅离线分析，不进行第二次付费任务。使用归属已确认的 AdventureWorks reader，不写业务数据或网站连接配置。

## 开场与基线

- 分支 `feature/eds-analysis-dashboard`，366 条既有工作区状态保留；运行约定、近期日志和 Agent 架构已阅读，任务日志已备份。
- `npm run site:status` 已运行，状态基线 `.runtime/dsh-recovery-service-before.log`；不启停三服务。
- `npx vitest run core/agent-engines/server/dsh-engine.test.ts core/agent-engines/server/tool-broker.test.ts core/harness/server/notebook-tool-bridge.test.ts`：3 文件 / 98 项通过，日志 `.runtime/dsh-recovery-baseline.log`。
- 上次原始参数没有保存，不能恢复；空 Notebook 的 `cellSearch({})` 已有真实固定动作成功证据，当前不把空文档当成根因。

## 工作记录

- 实测排除默认并发冲突：[双工具报告](../../.runtime/dsh-dispatch-1790051374155/report.json)在官方 SDK / 适配器、真实 broker / 桥上测试两种返回顺序；最大并发1、全部工具成功、SDK已回收。只有模型 / Schema I/O 为本地替身，没有付费或实际查询。新增 `scripts/dsh-dispatch-fixture.ts`、`scripts/verify-dsh-dispatch.mjs`，生产调度未修改。
- 桥目录原先复用公共说明，指向未注册的 Python 专用工具，并提及 schema 已排除的 text / parameter。`core/harness/server/notebook-tool-bridge.ts` 现按真实 cellKinds 生成编辑提示；保留完整替换 / 原Data来源 / after / remove / 输出名检查 / 真实运行提交规则，Python启用时明确走同一编辑工具。
- 同一桥的 `cellSearch` 明确首次可用 `{}`、空文档仍返回编辑版本；后续使用结果中的 editVersion，不取正式文档revision；不用的定位 / 筛选字段省略，不填null。参数 Schema 与执行校验未放宽，原 Harness 公共目录未改变。
- 新增桥目录3项回归，桥56/56通过；`verify-dsh-adventureworks.test.mjs` 增加4项实际模型上下文 / 版本 / 空文档下一步 / noMatch与空结果区别，13/13通过；根代理另跑桥+DSH能力65项通过。
- 测试库只检查现有 owned 实例仍 running，没有启动 / 停止 / 恢复或写数据。本轮唯一真实复验已结束，结果如下。

## 真实任务结果：有进展，但未交付

运行 `node scripts/verify-dsh-live.mjs --confirm-paid-model --runtime-dir <已确认归属的测试库目录>` 一次；该路径为脱敏占位，不是新的实例。使用官方 SDK、实际配置模型与 PostgreSQL reader，退出1；保留[失败报告](../../.runtime/dsh-live-model-1790051472510/report.json)，没有再次付费。

工具顺序为 `cellSearch → inspectConnectionSchema → inspectConnectionSchema → editNotebookCells → runNotebookCells → editNotebookCells`。这六次工具调用都返回了回执，**不表示第一次 Notebook 试运行的全部单元成功**。模型再次调用 `runNotebookCells` 时被原六工具保护阻止，最终 `executionFailed`、没有已验证提交的草稿。不能据本次检索成功，反推上次未保存参数的精确错误或宣称它的全部原因已修复。

隔离查询日志保存了本次生成 SQL 的成功结果元数据：38行、未截断。实际库的查询链已通，但未通过整个任务的表图交付断言；SDK / 业务适配器验收不是浏览器真实提交 / 采用 / 保存全链。

[模型回执](../../.runtime/dsh-live-model-1790051472510/model-usage.json)显示6次 HTTP200，仅完整观察到5个响应 usage，共输入27,708 / 输出621 Token。`usageComplete=false`，这些数字不是完整账单或费用上限；最后流随任务中止未完整观察。没有因失败自动发起第二个付费任务。

## 精度与图表类型：独立只读复现

新增 `scripts/test-database/verify-dsh-numeric-chart.mjs`，读取本次隔离日志，在连接前以固定已审阅 SQL 摘要拒绝其他 SQL，精确重跑已保存 SQL；使用相同真实查询 / Notebook 端口，与独立只读聚合参考逐月比较。数据库 bigint 保留 string 是原有精度策略，不是修改或关闭的校验。[最终只读报告](../../.runtime/dsh-numeric-chart-20260922-3/report.json)3组通过，旧失败 / 成功证据未覆盖。

- 原 SQL 成功，`order_count` 和 `revenue_cents` 为 PostgreSQL OID20，字段 / 值均保留 string，38月逐值符合独立参考。
- 按用户需求**重新构造**订单量折线图，触发既有“图表数值列必须为数字”拒绝。原任务完整图定义未保存，这不是恢复原图，也不能证明原图具体失败原因。
- 每项聚合先检查 int4 / 安全整数范围和 BigInt 往返，再显式 SQL 转换；真实 Notebook 表 / 图均成功，38月共31,465订单、血缘和正式文档保护通过。该转换只证明此公开样例，不允许任意 numeric 自动转浮点数。
- 初次复现脚本漏预加载 catalog，末尾血缘断言失败；补充真实 inspect 调用后重跑成功。这是本轮验收脚本问题，失败报告保留，未当成产品缺陷或抹去。

生产代码只追加工具提示：图表数值必须 number、bigint/numeric 可能返回 string、显式转换前必须核对范围 / 精度。没有改 PostgreSQL 结果映射、SQL / Chart Schema 或业务数据。

## 已落地修补与模块边界

| 文件 | 本轮职责 |
| --- | --- |
| `core/harness/server/notebook-tool-bridge.ts` / `.test.ts` | 按桥实际 profile 输出工具说明、明确检索版本与安全图表类型；继续复用原业务校验 |
| `core/agent-engines/server/dsh-engine.ts` / `.test.ts` | 保存已知的工具次数中止原因，给出明确结果文案；仍是 `executionFailed`，不新增协议枚举或提高次数 |
| `scripts/dsh-dispatch-fixture.ts`、`scripts/verify-dsh-dispatch.mjs` | 实际 SDK 同响应双工具的离线调度证据 |
| `scripts/test-database/verify-dsh-adventureworks.test.mjs` | 实际上下文、初始版本、空检索及下一步编辑回归 |
| `scripts/test-database/verify-dsh-numeric-chart.mjs` | 保存 SQL 的只读类型 / 图表复现，独立于生产运行与历史证据 |
| `scripts/dsh-tool-limit-fixture.ts`、`scripts/verify-dsh-tool-limit-browser.mjs` | 真实引擎 / 工具触发次数保护，再在隔离浏览器回放正式 SSE，验证错误展示 |

Agent / SDK 仍通过受控 broker 调业务桥，数据库凭据不入 SDK。模型文字不构成成功草稿，必须真实运行、提交后由用户采用。六工具 / 超时 / 权限 / 用户取消继续由原边界执行。新次数文案只使用受控计数，不输出原始 SDK 错误或敏感路径；取消、撤权、超时文案优先级不变。图表精度提示和次数文案均在本次付费任务后补入，**未做第二次付费复验**。

## 验证与启用

| 实际检查 | 结果 |
| --- | --- |
| `npm test -- --maxWorkers=2` | 248文件 / 2,680应用 + 26 Node通过；原1文件 / 3项跳过保留 |
| `node --test runtime/dsh/driver.test.mjs runtime/dsh/installation.test.mjs runtime/dsh/tool-diagnostics.test.mjs scripts/setup-dsh-runtime.test.mjs scripts/dsh-live-model-gateway.test.mjs scripts/test-database/verify-dsh-adventureworks.test.mjs scripts/verify-dsh-live.test.mjs scripts/check-agent-architecture.test.mjs` | 68/68通过；含实际 SDK 本地模型替身，不收费 |
| `npm run build`，随后 `npm run typecheck` | 均退出0；新增截图脚本后再次正规 typecheck 通过；保留既有大chunk提示 |
| 本轮10个源码 / 验收文件 `npx eslint … --max-warnings 0` | 通过；没有全仓格式化或关闭检查 |
| `npm run docs:agent:sync` / `npm run docs:agent:check`，`git -c core.safecrlf=false diff --check` | 187文件指纹及差异检查通过 |
| `node scripts/verify-dsh-dispatch.mjs` | 2种顺序实际SDK串行调度通过；详见上述报告 |
| `node scripts/test-database/verify-dsh-numeric-chart.mjs --runtime-dir <owned-runtime> --evidence-dir <本轮隔离目录> --source-log <本轮查询日志>` | 固定SQL / 新构造失败图 / 安全转换成功图3组通过；参数已脱敏，原日志未变 |
| `node scripts/verify-dsh-tool-limit-browser.mjs` | 3001，4张新图实际查看，详情如下 |

日志统一为 `.runtime/dsh-recovery-*.log`，真实模型失败仍独立保留，不能被全量离线通过覆盖。没有升级 SDK 或主依赖、没有重新 audit；第三批活动安装 audit0 与旧树风险是历史结果。

### 3001 截图

[最终浏览器报告](../../.runtime/dsh-tool-limit-browser-2026-09-22/browser-1790052212084/report.json)验证真实 `runDshEngine` / 六次业务 `cellSearch` / 第七次保护 / 正式 SSE 编码；driver 和可信连接上下文为显式替身，浏览器拦截回放该 SSE，不调用公开 handler、SDK、收费模型或数据库。全新隔离浏览器，禁止项目写和多次提交，用户存储未打开。

- [1440默认折叠与完整原因](../../.runtime/dsh-tool-limit-browser-2026-09-22/browser-1790052212084/01-tool-limit-collapsed-1440.png)
- [1440展开实际执行记录](../../.runtime/dsh-tool-limit-browser-2026-09-22/browser-1790052212084/02-tool-limit-trace-1440.png)
- [1024完整原因](../../.runtime/dsh-tool-limit-browser-2026-09-22/browser-1790052212084/04-tool-limit-collapsed-1024.png)

四图子代理逐张查看，主代理复看01 / 02 / 04；原因可读、无草稿采用入口、无横向溢出 / 页面异常。02与03因完整内容可见而相同，不计额外覆盖。首次脚本因环境变量隔离丢失 Windows 大小写查找而在浏览器启动前失败，修补测试脚本后重跑，失败报告保留。原界面“执行失败·Harness”是共用历史标签，本批不改 UI 组件 / 样式；实际错误文案明确DSH。本批不涵盖成功草稿或用户取消截图。

### 工作区与启用

保持 `feature/eds-analysis-dashboard`，开场366条既有状态保留，收尾371条（未跟踪目录折叠）。未提交 / 推送 / 切分支 / 自动stash，未清理历史或升级锁文件。服务状态前后对照：三服务PID、worker、revision、启动时间、重启次数及stable release均未变，健康正常；保持用户 `dsh / revision7 / activeTasks0`，源码默认原版。未启停或发布3000，没有用户项目 / 生产数据库写入。任务日志历史字节前缀另在交付前核对。

## 诊断边界

本次离线结果不恢复上次参数，不能把null、错误版本或缺锚点当作历史事实。`INVALID_TOOL_ARGUMENTS` 可定位安全字段 / code；`BUSINESS_VALIDATION` 仍可能是过期 / 关闭 / 授权等多种情况，普通业务 Error 也不能直接决定是否重试。没有通过原始 message 或参数值来猜测权限错误。

当前任务需要两页 Schema 且还要编辑 / 试运行 / 提交，六工具会使错误恢复空间很小。这是已观察到的限制，本批按边界保留，没有通过提高额度或跳过运行 / 提交验证来制造通过。真实任务的完整内部单元回执未保存，后续验收应进一步保留必要的脱敏状态证据；此次不以猜测补齐。浏览器真实模型→草稿采用→持久化、语义模型 / 图片及其余 DSH 能力不在本轮完成范围。
