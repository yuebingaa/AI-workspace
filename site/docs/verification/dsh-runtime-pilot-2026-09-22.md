# DSH 执行内核离线试点（2026-09-22）

## 本批边界

暂停 M7 后，经用户同意，先验证官方 DeepSeek Harness 能否直接调度现有 Notebook 业务工具；不是整体替换网站执行器，也不是模型质量评测。

- 选定：固定官方版本 `0.1.6-alpha.2`，独立依赖目录；官方 Cordis / AgentLoop 的测试级 in-process 组合，不加载 CLI / 默认 profile。
- 一条闭环：合成 CSV 导入 → `cellSearch` → `editNotebookCells` → `runNotebookCells` → `submitNotebookDraft`；SQL 使用真实本地执行器，只有模型决策使用固定测试替身。
- 保留：既有来源校验、Schema、任务副本、试运行回执、草稿基线与人工采用。禁止 Python、仓库连接、原件、MCP、Shell 工具；不调用旧 `HarnessRuntime.run`，避免双循环。
- 不做：公开 API 引擎切换、SDK 子进程、SSE 转换、真实模型、长期会话迁移、新 UI 或发布。网站默认执行路径保持原样。

## 查证依据

以官方 commit `ddefc45fbc7f8e46dd73185e68295696d1297887` 和 npm 实际发布物为准：

- [架构及测试组合约定](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/docs/architecture.md)
- [SDK 类型](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/sdk/client/src/types.ts)
- [默认 minimal 配置](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/bundle/sdk-minimal/cordis.patch.yml)

各包默认 dist-tag 不一致，不能使用无版本安装。SDK 没有每次 run 的工具回调、AbortSignal 或 cancel 请求，通知不包含逐 Token 流；默认 minimal 仍带 Shell 和宽松策略。因此先采用官方允许的测试级小型插件组合，不把它冒充受支持的生产 SDK 启动器。依赖隔离和不注册危险插件不是操作系统沙箱。

## 工作记录

- 修改前：`npm test -- --maxWorkers=2`，237 文件 / 2,506 应用测试、26 Node 测试通过；原 1 文件 / 3 项跳过。日志：`.runtime/dsh-pilot-baseline-tests.log`。
- 开场：3000、3001、3198 均健康；336 项已有 Git 修改作为基线保留。
- 实施：工具桥、官方循环和真实 CSV 闭环已落地；最终全量验证另列下表。

## 实际落地

```text
core/harness/server/
  notebook-tool-bridge.ts          受限业务工具会话，不拥有模型循环
  notebook-tool-bridge.test.ts     参数、权限、隔离、真实 SQL、取消与回执
scripts/
  dsh-notebook-fixture.ts          固定合成 CSV、真实工具及结果断言
  dsh-notebook-pilot.mjs           无监听离线组合与机器验收报告
  dsh-pilot/
    package.json / package-lock.json  独立依赖锁，不改网站主包
    runner.mjs                    官方 AgentLoop + 固定模型适配
    runner.test.mjs               真实循环成功 / 失败 / 取消检查
    README.md                     固定安装、复跑方法和能力边界
```

桥的 `execute(name, args, callSignal?)` 保留来源、版本、完整 DAG 与运行回执约束；每次执行前后和取草稿复查可信授权。请求、行、参数和回执使用任务副本；拒绝并行写入，同任务编辑或重跑清空旧提交。全局或单次调用取消会关闭整个实验会话、传到实际 runner，并拒绝迟到结果。`getVerifiedDraft()` 只能获取实际提交工具保存的副本，不能接收模型自报成功。

官方 DSH 只负责模型 / 工具循环和规范 Session 事件；Dataset 解析与内存存储、SQL / 表图执行及试运行验证仍由现有业务模块负责。图表配置和数据数值通过不等于实际图表渲染通过。本批没有 UI 变更或开发站引擎切换，因此没有生成新截图，也没有引用旧截图冒充验收。

隔离安装使用 `npm install --prefix .runtime/dsh-pilot-deps --ignore-scripts --no-audit --no-fund`，8 个直接依赖、总计 25 包，全部 DSH 包固定 `0.1.6-alpha.2`；独立锁已保留，主 `package.json` / `package-lock.json` 不变。实验要求 Node 24，本机为 v24.19.0；不提高网站原有 Node 要求。具体复跑命令见 [README](../../scripts/dsh-pilot/README.md)。

## 真实集成结果

机器证据：[最终报告](../../.runtime/dsh-notebook-pilot-1790038758065/report.json)，`passed=true`。

1. 成功场景：CSV 三行 → 四个真实业务工具 → 一次本地 SQL，地区汇总 150 / 80，SQL / Table / Chart 数值一致。官方 DSH 产生 31 条真实 Session 事件、5 次固定模型响应、4 次工具执行，循环为 `completed`、工具失败 0。草稿含四类单元、`baseRevision=7`，正式文档不变且未采用。
2. 取消场景：在真实 Notebook runner 开始后取消 DSH；这是独立的 DSH 调用信号，不是外层 fixture 信号。取消沿 DSH → 工具桥 → Notebook 传播，最终 `cancelled`，runner signal 已取消，无法提交 / 取草稿，正式文档不变。
3. 两场景没有网络 fetch，未配置或调用真实模型；没有用户项目、数据库、正式 HTTP 会话或稳定站副作用。fetch 守卫不覆盖所有底层网络 API，不能当作网络沙箱。

最终成功条件同时检查 DSH 自身状态、模型调用数、工具失败数和服务端真实提交草稿，不能仅因工具曾成功就忽略最后循环失败。各级清理分别尝试，失败时仍恢复临时环境 / fetch，机器报告不写原始堆栈或本机路径。

## 验证记录

| 本次命令 | 实际结果 |
| --- | --- |
| 修改前 `npm test -- --maxWorkers=2` | 2,506 应用 + 26 Node 通过，原 3 项跳过 |
| 工具桥定向 Vitest | 21 项通过：真 SQL、失败 / 假回执、隔离、授权撤回、并发、调用取消与监听清理 |
| `node --test scripts/dsh-pilot/runner.test.mjs` | 7 项通过：真实事件、错误、未知 Shell 拒绝、fetch 拒绝、取消、超时、预取消 |
| `node scripts/dsh-notebook-pilot.mjs` | 最终成功和执行中取消两场景通过，见上方报告 |
| `npm run typecheck` | 完成态通过 |
| 六个新增代码 / 测试文件 ESLint `--max-warnings=0` | 通过 |
| 修改后 `npm test -- --maxWorkers=2` | 238 文件 / **2,527 应用 + 26 Node 通过**，原 1 文件 / 3 项跳过不变；132.84 秒 |
| `npm run build` | 通过；保留既有客户端 chunk 大小提醒，不是发布 |
| `npm run docs:agent:sync / check / test` | 正文 / 变更记录同步后 169 文件指纹检查和检查器 1 项通过 |
| 三个脚本 `node --check` / 本批 `git diff --check` | 通过；Git 提示文档下次写入时 LF 转 CRLF，不是内容错误 |
| `npm run site:status` | 三服务健康；PID / worker / revision / startedAt / 重启数 / stable release 与开场一致，未操作服务 |

日志为 `.runtime/dsh-pilot-*.log`。保留初次集成失败：无敏感字段的合成 CSV 不应调用敏感策略确认接口；修正测试准备使用解析器的 `not-required` 后成功，未放宽产品权限。工具桥初版测试读取了错误的解析返回层级，已修复；编辑期间两项 TS 诊断已修复，完成态类型通过。独立复核发现的“未检查 DSH 终态”和“工具取消未贯通”已修正，并加真实组合取消场景。以上均为本批问题，不冒称原有失败。

## 未启用与后续接入位置

- 网站仍是现有 `CoordinatedHarness / HarnessRuntime`；本批没有改 handler、环境引擎开关、SSE、会话或持久化，没有自动发布。
- 真正接入网站时，在 `app/api/ai/harness/handler.ts` 的执行器调用边界选择新引擎；保留外围身份、项目来源范围、授权复查、幂等和会话提交。不要把完整 DSH 套入 `HarnessModel.next()`。
- 此处固定模型仅验证工具 / 内核边界。真实模型适配、SDK 官方启动 / 跨进程工具传输、SSE 与取消映射、原会话上下文、人工采用界面仍需独立实现和验收，不把 in-process 测试构造当作生产 SDK。
- Python、外部只读数据库、Excel 原件、EDS、语义、MCP 与多源尚未在 DSH 路径验证。现有产品能力没有被删除。
- 取消是合作式，不是强杀隔离。桥能拒绝迟到结果，但无法保证任意第三方不合作代码立刻停止；生产进程隔离需另行设计。
- 原 M7 浏览器连续分析仍暂停，本批不宣称其已完成。

## 工作区与交付状态

分支保持 `feature/eds-analysis-dashboard`，开场 336 项已有修改保留。只新增上述 10 个代码 / 测试 / 实验依赖 / 文档文件，更新唯一 Agent 架构入口并追加任务日志；未提交、推送、合并、切换分支或清理用户文件。隔离依赖及机器证据位于忽略的 `.runtime`，不是网站发布物。普通 `git status --short` 收尾 342 项（新实验文件夹按一项显示）。

本批结论是：**官方 DSH 循环已经在离线试点中复用本项目真实分析工具，并通过成功与取消验证；网站尚未改用 DSH。** 正式切换需保留既有业务和权限边界，完成上列未验证能力后再决定范围。
