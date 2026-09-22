# Hex 第八批：统一 Notebook 试运行验收

日期：2026-09-16。范围：M4 中完整草稿、增量运行 / 提交、失败诊断的共享回执一致性规则。源码、离线检查、实库兼容和 3001 新截图验收完成；3000 未发布。

## 范围与基线

审计证据：`core/harness/tool-registry.ts` 的 createNotebookDraft 原先仅拒绝 runner 顶层 failure；`notebook-cell-tools.ts` 验数量 / 顺序及部分状态，但不验引用身份，提交直接使用缓存；`notebook-diagnostics.ts` 另有更完整但静默的校验。三份规则容易在替换内部执行器时分歧，不能把诊断拒绝当作工具也已拒绝。

仅收敛一致性和输入所有权，不重写调度、变更格式、权限、预算、模型或 UI，不实现全局结果仓库。当前网页真实执行器本已有 Schema 校验，客户端 / LLM 不能直接注入回执；本批是防御性接口加强，不声称发现了可远程利用的漏洞。

基线：分支 feature/eds-analysis-dashboard、HEAD df5bbae，用户原有与前七批未提交内容保留。修改前实际 `npm test -- --reporter=dot --maxWorkers=2` 为160文件 / 1,508应用通过，1文件 / 3项既有跳过，另14项Node通过。日志见 `.runtime/hex-trial-verification-2026-09-16/tests-baseline.log`。三个受管服务健康，未启停。

## 实际结构与接口

```text
core/notebook/
  run-receipt.ts                         # 新：预期捕获、结构/语义一致性验收
  run-receipt.test.ts                    # 新：兼容与不一致反例
core/harness/
  tool-registry.ts                       # 完整草稿：克隆输入、验收后写证据
  notebook-cell-tools.ts                 # 增量运行/提交使用共同门槛
  notebook-diagnostics.ts                # 同规则，继续只读/临时/授权投影
  notebook-receipt-integration.test.ts    # 新：三路消费者/变异/取消回归
  notebook-diagnostics.test.ts           # 补行数/截断与独立快照回归
core/architecture/module-boundaries.test.ts # 纯边界及三消费者共享入口
app/api/ai/harness/trial-verification.test.ts # 新：实际JSON/SSE与真实SQL执行
scripts/
  verify-trial-verification.mjs          # 新：隔离项目/浏览器截图
  fixtures/trial-verification.mjs        # 新：真实Harness执行、明确故障注入
```

`captureNotebookRunExpectation(document, accessMode, targetCellId?)` 在 runner 前从既有图模块取得拓扑 ID，独立冻结版本和模式；`parseNotebookRunReceipt(raw, expectation)` 用原 Schema 复制解析，检查版本、数量 / 顺序、状态双向一致、可选引用四项身份及 table / rowCount / truncated 自洽。没有通用服务容器或重复执行器。

普通 Notebook 执行器 / API、Dataset 捕获和 Dashboard 仍由原模块负责；模型服务和 SQL 适配没有移动。今后替换 notebookRunner 需维持此运行契约，组装入口保持 `app/api/ai/harness/handler.ts`；不能通过变更传入 artifact 来改掉验收预期或待采用内容。新增规则与消费者一同提交，不能遗漏未跟踪文件。

## 行为兼容与安全边界

- 不一致回执在写 Evidence / session.run / 可采用产物之前拒绝；submit 再验当前草稿下的缓存。runner 只获得草稿结构副本，不能改写原待审定义。原 context 仍是可信内部调用对象，不宣称沙箱隔离所有内部代码。
- 取消、编辑版本过期优先于晚到回执错误；真实失败继续保留错误、阶段耗时和只读诊断。无法取得合法回执时为 unavailable / unknown，不编造执行状态 / 0 ms。
- 已安装 runner 返回 undefined 不再当作没配置；真正未配置时原简单声明草稿可只验结构，不加运行证据。没有无条件强制所有草稿先运行。
- 旧可选 table / resultRef、空 runId 依原 Schema 兼容。若有引用则核对身份；不校验哈希、输入引用真实性、完整血缘或数值正确性，不把一致性当权限和可信计算证明。
- 真正 SQL 截断仍可表示执行成功；第七批完整结果保存仍拒绝这种结果。完整大表的有限预览也不误拒。没有改动 wire、持久化、Tool 参数、SSE 事件名、API 路径或看板确认。

## 验证与证据

| 本次实际命令 | 结果 |
| --- | --- |
| 修改前 `npm test -- --reporter=dot --maxWorkers=2` | 1,508应用 + 14 Node通过，3项既有跳过 |
| 修改后同一全量命令 | 163文件 / 1,577应用通过，1文件 / 3项既有跳过；另14 Node通过，exit 0 |
| `npm run typecheck -- --incremental false` | 初次发现本批测试 toBe 多传消息参数；将消息移到 expect 后复测通过 |
| `node node_modules/vitest/vitest.mjs run core/notebook/run-receipt.test.ts app/api/ai/harness/trial-verification.test.ts core/architecture/module-boundaries.test.ts --reporter=dot --maxWorkers=2` | 类型修正后50项再次通过，断言未弱化 |
| `node node_modules/eslint/bin/eslint.js <本批11个源码/测试/脚本> --max-warnings=0` | 修改完成后复测通过；不是全仓 lint |
| `npm run build` | exit 0；既有大 chunk 警告保留 |
| `node --check scripts/verify-trial-verification.mjs` 及 fixture | 两文件通过 |
| `npm run docs:agent:sync` / `check` / `test` | 正文/变更记录维护；141文件指纹一致，检查器1项通过 |
| `git -c core.safecrlf=false diff --check` | 通过；新文件独立检查UTF-8、尾空白、EOF |

新增69项：纯回执28、消费者集成36、诊断2、JSON/SSE API2、架构1。首轮消费者33项中30项真实失败 / 3项兼容通过，接线后转绿；之后补 installed-runner undefined、取消 / 版本优先和诊断边界。纯模块最初是缺文件导致套件未执行，不将其写成28个行为红测；16种原Schema接受的不一致形状有独立拒绝断言。新API测试初稿误带客户端role并漏计划table交付步骤，被原安全 / 计划规则拒绝；修正测试输入后两种传输各真实执行一次合法和一次故障注入链通过，未放宽产品校验。

API测试使用实际路由、真实 Harness / Plan / Tool / DuckDB；模型选择为显式替身，错误 runner 是实际计算后替换为空单元回执且带合成 notice 标记。合法结果等待采用，错误结果 failed / 无 artifact / 诊断 unknown，标记不进入事件 / 最终回答；SSE 保持唯一 completed。执行代码没有新增公共调试或注入接口。

日志：[基线](../../.runtime/hex-trial-verification-2026-09-16/tests-baseline.log)、[全量](../../.runtime/hex-trial-verification-2026-09-16/tests-final.log)、[类型](../../.runtime/hex-trial-verification-2026-09-16/typecheck-final.log)、[类型修正后专项](../../.runtime/hex-trial-verification-2026-09-16/post-typefix-tests.log)、[严格代码检查](../../.runtime/hex-trial-verification-2026-09-16/lint-final.log)、[构建](../../.runtime/hex-trial-verification-2026-09-16/build.log)、[API](../../.runtime/hex-trial-verification-2026-09-16/api-final.log)。

### 原数据库链兼容

完整读取 README、原验收与共享脚本，并核验既有隔离库归属/进程/loopback后，使用既有reader运行：

`node scripts/test-database/verify-adventureworks.mjs --runtime-dir <既有v3隔离库目录> --evidence-dir .runtime/hex-trial-verification-2026-09-16/adventureworks-chain`

本批[报告](../../.runtime/hex-trial-verification-2026-09-16/adventureworks-chain/report.json)8/8通过：10表107字段、31465订单/38月/10地区独立核对，PG→DuckDB→表图→Dataset来源与重开→Dashboard预览/应用/撤销，截断拒绝、未授权表、取消重试兼容。四个真实增量工具 cellSearch / editNotebookCells / runNotebookCells / submitNotebookDraft 全成功，最终 awaitingConfirmation、verification passed，无自动采用。

前后隔离库 PID28212、55432回环监听、ready均未变，未恢复/启停/写库/改连接配置。脚本是进程内实际API模块而非HTTP；模型为固定替身，真实模型调用0。金额的既有显式转换不代表一般十进制无损，Databricks未验证。

### 浏览器与截图

最终[5组/逐图报告](../../.runtime/hex-trial-verification-2026-09-16/browser-1789569786973/report.json)，新本地合成项目。手工 Python→DuckDB 使用真实3001 HTTP，独立预期 Alpha=3 / Beta=0.5。离线 fixture 用真实 Harness→Analysis Plan→完整 Notebook 草稿工具→Python/SQL生成合法、错身份、恢复三份最终任务；浏览器仅明确回放这三份真实任务的SSE，**不是实时公共Harness请求或真实LLM**。外部HTTP被拒，目录GET为空目录替身。

| 新截图 | 验收 |
| --- | --- |
| `01-real-manual-success-1440.png`、`02-real-manual-success-1024.png` | 真实Python计算与SQL汇总数值、完整结果及阶段耗时 |
| `03-valid-whole-draft-1440.png` | 整稿验证通过，两新增变更可查看，仍需采用 |
| `04-dismiss-keeps-formal-document.png` | 暂不采用后正式两单元不变 |
| `05-rejected-untrusted-receipt-1440.png`、`06-rejected-untrusted-receipt-1024.png` | 错run引用被拒后的unknown只读定义，无伪造耗时/可采用产物；源码转义 |
| `07-valid-retry-after-rejection.png` | 新任务恢复合法runner后可再次待采用，不被上一次错误污染 |
| `08-refreshed-original-notebook-1024.png` | 刷新后失败诊断不恢复、正式两单元仍未改；合法待采用草稿保留见下述边界 |

全部8张由验收代理逐张查看，主代理另看01/03/06/07/08。05/06取景针对诊断定义区，不将其描述为错误总标题截图；07同时可见失败历史与合法重试。页面异常和禁止请求0，真实模型/外部数据库调用0；没有修改UI或CSS，使用现有桌面1024/1440样式，不做手机布局。取消仅指暂不采用，不冒称运行中取消截图；后者由离线测试/实库兼容覆盖。

首轮 `browser-1789569696120` 因脚本预计第三次模型选择而失败：实际第二次工具已耗尽显式2次预算，直接终止；改为更严格的精确2次后新项目完整复跑。旧失败报告/截图保留，未改产品规则、放宽预算或删除测试项目。

## 保留与未验证

无真实付费模型、生产或Databricks验收。未实现持久结果仓库、完整动态Cell注册、自动重算 / 参数或多人权限；无对任意SQL/Python结果数学正确性的证明。执行器空字符串异常归一化是本轮旁查提示，未纳入此回执兼容切片，不声称所有失败形状已彻底加固。

截图核验发现原有“暂不采用”只隐藏当前草稿；刷新仍会从保留的合法任务恢复待采用提示。正式 Notebook 始终没改、未自动采用，但不应称为永久删除草稿。本轮保持该业务行为并记录，不擅自改变持久化语义。

最终仍在 feature/eds-analysis-dashboard、HEAD df5bbae，用户既有改动与本批源码/测试均未提交；无提交/推送/切分支、源码删除、升级依赖、锁文件变更或数据迁移。新接口与消费者需一起提交，不能遗漏未跟踪模块。任务日志及.runtime证据沿用既有忽略规则，不强制加入Git。

site:status前后三服务健康，PID/workerPid/revision/restarts相同，dev历史2次未增长。仅源码和3001本批验收生效，3000没有启停/发布；build产物不等于已发布。TASK-LOG本批之前281947字节的前缀单独核验不变。
