# Notebook 模块解耦记录（2026-09-14）

## 范围与基线

延续上一轮有界重构，保留 `feature/eds-analysis-dashboard` 上全部未提交内容。本轮仅处理 Notebook 的定义归属与执行基础设施依赖，不改业务规则、API、持久化格式、用户交互、模型或数据库配置，不发布稳定站。

已核实的问题：

1. `core/notebook/contracts.ts` 运行时导入 Harness 定义，图依赖、配方处理及 Notebook 编辑器也使用 Harness 单元类型。Notebook 定义应同时供人工编辑与 Agent 使用，不应由 Agent 模块拥有。
2. `core/notebook/server/runtime.ts` 同时编排单元、绑定 DuckDB 进程查询和读取本地查询日志配置。虽然可以在调用时替换 query/log，依赖图仍到达具体进程和文件存储实现。

基线在独立源码快照执行：类型检查、全部变更代码严格 ESLint、架构文档检查器、离线测试及生产构建均通过。快照排除 `.env*`，复用既有依赖；检查前后源码指纹无漂移。证据位于 `.runtime/refactor-2026-09-14/notebook-baseline/`。

## 固定实施清单

- [x] Notebook 自有单元 / 草稿契约；旧 Harness 导出保留别名兼容，不复制 Schema。
- [x] 执行用例显式依赖查询与日志契约，具体 DuckDB 与文件日志在服务端入口组装。
- [x] 增加兼容、替身执行及依赖边界测试；专项 4 个文件、29 项通过，全量回归 957 项通过、3 跳过。
- [x] 同步架构文档、任务记录及本报告，明确保留耦合与启用状态。

不合并人工校验与 Agent 草稿校验：二者的授权范围、校验时机、错误文本不同，本轮保持各自行为。Dashboard 渲染器、Agent 路由与长期上下文不是本轮范围。

## 已落地结构与职责

```text
core/notebook/
  definition.ts               单元、草稿、草稿产物的唯一 Schema / 类型
  contracts.ts                文档、运行请求、结果表及血缘引用
  execution-contracts.ts      查询 / 日志端口与用例输入
  graph.ts                    依赖、排序约束与失效传播（行为不变）
  client-state.ts              差异、采用、版本与试运行证据门控
  transform.ts / dashboard.ts 配方执行 / 生成看板 ChangeSet
  server/
    execution.ts              执行用例；依赖显式 query / log
    runtime.ts                保留 runNotebook，组装默认依赖
    query-engine.ts           既有隔离 DuckDB 查询与并发 / 超时（未修改）
    query-log.ts              私有 v1 文件日志；最近 100 条、2 MiB
core/harness/
  notebook-contracts.ts       旧名称兼容别名，不是第二份业务实现
```

主要改动：新增定义、执行契约、执行用例、日志适配文件；Notebook 原有核心文件和 4 个工作台组件仅迁移单元 / 草稿的类型、Schema 名称与 import，没有改 JSX、样式或用户交互。旧 Runtime 保留 API / Harness 的相同调用方式和每次请求覆盖依赖的能力。

`executeNotebook(input, dependencies)` 可以直接使用测试查询器和日志接收器，运行完整单元链且不加载默认 SQL 进程或文件存储。默认的 `runNotebook(input)` 仍使用原查询模块，不能因每次组装重置并发额度。记录日志仍同步完成，失败不能静默丢弃。

新增测试验证旧 Schema 对象身份、八类单元保存读取、严格校验与草稿确认，完整数据而非预览输入、结果精度、失败 / 下游阻塞、AI 敏感字段策略、取消 / 截止时间 / 日志失败，以及旧日志格式、保留条数、配置切换、损坏文件保护。静态检查额外追踪类型导入，防止只把反向依赖改成 `import type` 来掩盖。

## 后续替换方式与保留事项

- 更换本地 SQL：实现 `NotebookQueryExecutor`，在 `server/runtime.ts` 组装；查询器必须遵守取消、结果完整性和精度约定。旧调用方仍可逐次传入 query。
- 更换查询日志：实现同步日志端口并在同一入口组装；若需要异步日志，要明确修改等待 / 失败语义并补测试，不能直接放任后台写入。
- 更换远端数据库：仍沿用上一轮 `ConnectionDriver` 与查询服务的边界；请求身份、连接权限、方言和数据范围没有转交给 Notebook。
- Agent 仍负责生成并校验草稿，Harness 管理预算 / 工具 / 确认；受检 Notebook 生产源码不再反向依赖 Harness，集成测试仍可调用 Harness 验证共同链路。旧 Harness 别名待其消费者迁移后可清理。
- 执行用例仍是 Node 服务端代码，使用 crypto 生成 ID / 摘要；没有宣称跨平台、任意内核零成本替换。原引擎仍按需加载全部有界输入，未新增分页、大结果缓存或 Python。
- Dashboard 仍使用既有渲染器和 ChangeSet；长期上下文、复杂任务路由及看板标签问题未在本轮修复。

## 验证与工作区状态

基线：933 项离线测试通过、3 跳过，另 14 项 Node 工具测试通过；类型、当时 36 个变更代码文件的严格 lint、架构检查器及构建通过。当时 lint 范围不含本轮才修改类型引用的 `StudioWorkspace.tsx`，不能将其描述为全仓 lint 无错误。

修改后检查均针对独立源码快照，排除环境文件并复用现有依赖；没有真实模型、远端数据库或企业账号调用。

| 实际命令 / 检查 | 结果 |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run core/notebook/definition.test.ts --reporter=dot` | 契约迁移后 11 项通过 |
| 同命令再加入 `core/notebook/server/execution.test.ts`、`query-log.test.ts`、`core/architecture/module-boundaries.test.ts` | 4 个文件 29 项通过，其中本轮新增 24 项 |
| `npm run typecheck -- --incremental false` | 通过 |
| `npm test -- --reporter=dot --reporter=json --outputFile=<本机报告>` | 117 个文件通过、1 文件跳过；957 项通过、3 跳过；随后 14 项 Node 工具测试通过 |
| `node node_modules/eslint/bin/eslint.js <54 个变更代码文件> --max-warnings 0` | **未通过：1 项已有错误，0 项新增**；详见下文 |
| `npm run docs:agent:sync` / `docs:agent:check` / `docs:agent:test` | 正文同步后指纹覆盖 100 个文件；维护检查及检查器测试通过 |
| `npm run build` | 通过；保留既有客户端 chunk 大于 500 kB 提示 |
| `node scripts/notebook-transform-browser-acceptance.mjs` | 3001 的 6 项检查通过，页面异常 0；3 张截图逐张查看 |
| 迁移前后代码对比 | Schema 除名称外逐字一致；执行函数体除 query/log 端口替换外一致；4 个组件仅类型 / import 改变 |
| `git diff --check` | 按仓库原换行配置检查通过 |

Lint 的唯一错误是 `components/studio/StudioWorkspace.tsx:541` 的 `react-hooks/set-state-in-effect`：本地项目保存失败分支直接更新提示状态。用本轮修改前快照运行同一规则，在相同位置复现；修改前后规则、位置、级别完全一致。该文件本轮仅改三处 Notebook 类型 / import，没有调整持久化 Effect。为避免扩大为前端持久化行为改造，保留原实现，不禁用规则、不改断言、不宣称 lint 全部通过。

首个整体验证脚本因这项 lint 错误返回非零并跳过构建；保留原失败回执。确认其为已有问题后，在同一最终源码快照单独执行完整构建，通过。`followup.json` 同时保留 `lintPassed=false`、已有错误、无新增错误及构建结果。检查期间一次临时以 `core.autocrlf=false` 读取差异把原 CRLF 视为空白错误，按仓库原配置复查通过；没有改 Git 配置或全仓重写换行。

浏览器使用隔离上下文和合成 CSV，经过真实导入 → 本机 DuckDB → DataRecipe → 图表 / 结果血缘 → 重跑失效 → 保存 Dataset；独立核对聚合为 East 150、South 80。手机无整页横向溢出或表单控件重叠。脚本只删除自己创建的临时 Dataset，未删除用户数据；没有运行新服务。

证据：`.runtime/refactor-2026-09-14/notebook-baseline/`、`notebook-final/`（后者含 `validation.json`、`followup.json`、Vitest JSON、类型 / lint / 文档 / 构建日志）；浏览器结果及截图位于 `evidence/notebook-transform-2026-09-14T02-20-17-000Z/`。源码快照不是分发压缩包。3 项既有环境相关测试仍跳过，真实模型 / 远端数据库仍未验证；静态边界检查不覆盖任意计算生成的 import 或第三方包内部实现。

仍在 `feature/eds-analysis-dashboard`，HEAD 保持 `15ebdae`；未提交、未推送、未合并 main，没有升级依赖、改锁文件、生成分发压缩包或发布 / 启停服务。3001 已验收；收尾 `site:status` 显示 3000 / 3001 / 3198 均健康，服务进程、启动时间和稳定版本与本轮开始一致。现有未提交内容保持保留，最终差异包含上一轮和本轮，不能把总差异全部归为本轮新增。
