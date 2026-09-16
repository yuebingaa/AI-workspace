# 工作区持久化解耦记录 · 2026-09-14

## 本轮完成边界

以本轮开始时的未提交工作区为基线，保留已有 Harness、Notebook 重构和 Hex 风格布局。本轮仅处理：

- 将本地项目的保存队列与 HTTP 传输分离，保留原客户端构造入口。
- 将工作台自动保存、显式保存和备份恢复后的保存标记集中到持久化协调模块；修复已有 Effect 同步更新错误。
- 增加队列、调度、错误及依赖边界测试，验证临时工作区和本地项目的保存/恢复。

不修改存储版本、API、权限、ChangeSet 确认、页面布局、数据库或模型调用。不提交、推送或发布稳定站。

## 已核对的代码证据

- `core/projects/client.ts`：`ProjectStudioRepository` 同时处理 400 ms 合并、串行修订、冲突冻结及 `projectRequest`；保存传输不可独立替换。
- `components/studio/StudioWorkspace.tsx`：自动保存 Effect 混合项目/临时工作区策略、快照构造及同步错误提示；基线 ESLint 报 `react-hooks/set-state-in-effect`。显式保存及备份恢复另行维护相同存储入口和查询记录标记。
- `core/repository/studio-repository.ts`：已有 `StudioRepository`、v5 快照及安全保存接口，可直接复用，不创建第二份持久化格式。
- `components/studio/projects/LocalProjectsProvider.tsx`：继续持有项目会话、保存状态及切换前的 `flush`，不改变用户确认或冲突恢复策略。

## 实际完成

1. 新增 `ProjectStateRepository`，由注入的 `ProjectStateWriter` 执行写入。队列不再依赖 HTTP、标签页全局项目选择或 React；保留 400 ms 合并、保存序列、修订确认、错误冻结、dirty 和明确放弃逻辑。旧 `ProjectStudioRepository(session, report)` 只负责组装 HTTP writer，没有两份保存实现。
2. 新增 `useStudioPersistence` 与无 React 的 `StudioPersistenceController`，承接自动/显式保存与备份恢复后的查询标记。主组件不再混合这些规则，仍拥有现有文档、恢复、备份确认及所选 Repository。
3. 自动保存改为可取消的微任务，失败通知异步到达 React。旧任务、Effect 清理、显式保存和备份恢复不会相互覆盖；取消的任务不提前更新查询标记，避免 StrictMode 重放漏存。自动快照校验失败转为警告，不产生未捕获异步异常；显式快照校验及返回语义不变。
4. 新增 19 项单元/边界测试及临时工作区浏览器验收脚本；保留原客户端 HTTP 测试和本地项目完整验收脚本。没有改布局、关闭 lint 规则或削弱原测试。

## 实际目录与公开入口

以下是本轮涉及的真实结构，不是整个项目的新目录规划：

```text
site/
├─ components/studio/
│  ├─ StudioWorkspace.tsx
│  ├─ projects/LocalProjectsProvider.tsx       原有项目会话/状态所有者，未修改
│  └─ workspace/
│     ├─ persistence.ts                       useStudioPersistence
│     ├─ persistence-controller.ts            StudioPersistenceController
│     ├─ persistence-controller.test.ts
│     ├─ contracts.ts                         原 PersistWorkspace 类型，未修改
│     └─ README.md
├─ core/
│  ├─ projects/
│  │  ├─ client.ts                            HTTP 与兼容构造入口
│  │  ├─ client.test.ts                       原 HTTP 测试，未修改
│  │  ├─ state-repository.ts                  队列及 ProjectStateWriter
│  │  └─ state-repository.test.ts
│  ├─ repository/studio-repository.ts         原 v5 格式和 StudioRepository，未修改
│  └─ architecture/module-boundaries.test.ts
├─ scripts/studio-persistence-browser-acceptance.mjs
└─ docs/architecture/persistence-refactor-2026-09-14.md
```

主要新增文件是上述两个保存模块、一个 React 适配 Hook、两个测试文件、一个浏览器脚本和本报告。修改的已有文件为 `StudioWorkspace.tsx`、`core/projects/client.ts`、依赖边界测试及工作区/架构文档。根任务日志与视觉规范追加验收说明。没有删除文件、迁移用户数据或修改依赖配置。

## 模块边界与状态所有权

| 所有者 | 负责 | 不负责 |
| --- | --- | --- |
| `StudioWorkspace` | 正式文档、审计、确认/撤销、恢复和 Repository 选择 | 不执行 HTTP 保存队列 |
| `useStudioPersistence` | React 生命周期、快照构造、原显式保存签名、通知 UI | 不另建数据存储或项目会话 |
| `StudioPersistenceController` | 待执行微任务与查询记录标记；取消旧任务 | 不持有第二份工作区文档、不调用 HTTP、不管理 React 状态 |
| `ProjectStateRepository` | 已接受快照、待写队列、修订号、保存错误 | 不读取当前标签页选择、不决定用户是否放弃更改 |
| `ProjectStateWriter` / `client.ts` | 接收明确的 handle/state/revision；适配现有项目 API | 不复制队列或冲突策略 |
| `LocalProjectsProvider` | 所选会话、保存状态、切换前 flush、显式放弃 | 不改变服务器文件写入权限 |

本轮没有改动已有 Agent → Model/Tool → Notebook/Dataset/SQL 执行链。Agent 决策仍依赖 `HarnessModel`；Harness 管执行、预算、事件和取消；Tool 继续使用现有业务入口和权限检查。Dataset 的项目/临时仓库、SQL 查询接口与驱动、Notebook 执行/日志端口沿用前两轮成果。Dashboard 仍由原渲染组件和 ChangeSet 管理，不因保存模块拆分自动确认看板。

### 兼容与时序

- API 路径、`x-agentcanvas-project`、30 秒请求截止、请求/响应字段、存储 key、v5 数据和备份格式均未变化。
- 临时工作区仍由查询记录引用变化触发自动保存；其他操作继续走显式保存。项目工作区跟随文档变化保存，由队列合并磁盘写入。
- `persistExplicitly` 仍同步返回 `StudioSaveResult`。项目模式中的 `persisted: true` 表示快照被队列接受，不等于磁盘已写入；持久完成仍以异步保存状态或 `flush()` 为准。
- 自动保存推迟到当前调用栈之后，是修复原 Effect 错误所需的有界时序调整。取消只针对尚未执行的自动保存，不取消已经发出的项目 HTTP 写入。
- 本轮未统一临时和项目的保存策略，未增加重试、自动放弃、权限或数据副本。

## 验证结果

所有 npm 命令在 `site/` 或其隔离源码快照执行。全量检查通过 `.runtime/refactor-2026-09-14/verify.mjs persistence-verified` 编排；快照逐文件校验、排除 `.env*` 和运行/用户数据、复用已安装依赖，构建不写入正在运行的站点目录。记录位于 `.runtime/refactor-2026-09-14/persistence-baseline/` 与 `persistence-verified/`；补强浏览器断言前的全量通过结果另保留在 `persistence-final/`。

| 检查 | 实际结果 |
| --- | --- |
| 修改前基线 | 类型、文档工具测试通过；958 项业务测试通过、3 跳过，另 14 项 Node 工具测试通过；lint 有 1 项原有 Effect 错误 |
| `node scripts/run-offline-tests.mjs core/projects/client.test.ts core/projects/state-repository.test.ts` | 11 项通过，另 14 项工具测试通过 |
| 工作区、项目和依赖边界分组检查 | 首次 57 项通过；补充浏览器调度接收者回归后，控制器 11 项单独通过，后续全量覆盖 |
| `npm run typecheck -- --incremental false` | 全局类型检查通过 |
| 严格 ESLint：全部 76 个已变更代码文件，`--max-warnings 0` | 0 错误、0 警告；已消除基线 Effect 错误，不是仅检查新增文件 |
| `npm test -- --reporter=dot --reporter=json ...` | 977 项通过、3 项原有跳过，另 14 项 Node 工具测试通过；新增 19 项 |
| `npm run docs:agent:sync` / `check` / `test` | 正文和记录已更新，101 个维护范围文件指纹一致，检查器测试通过 |
| `npm run build` | 隔离快照生产构建通过；保留既有客户端 chunk 大于 500 kB 提醒 |
| `git diff --check` | 按仓库原换行配置通过；未全仓格式化或改 Git 配置 |
| 源码比较 | 快照构建期间漂移 0；与开始快照比较，站点仅本轮 6 个已有文件和 7 个新文件发生变化；根目录另追加本轮任务记录 |

### 浏览器验证与发现的回归

只访问开发站 3001，使用独立 Edge 会话和合成数据：

- `node scripts/studio-persistence-browser-acceptance.mjs`：4 项通过。验证显式创建与 v5 导出；注入存储配额失败，检查自动失败提示且无循环重试；未保存修改仍可导出；人工确认恢复后刷新，旧状态不覆盖备份。页面异常和控制台 error 均为 0，模型和设置写入请求均为 0。
- 收尾进一步补强恢复断言：先把额外草稿实际保存，使当前存储与备份不同，再断言恢复移除这些草稿；防止把无操作恢复和普通刷新误当成功。完整 4 项重跑通过。
- `node scripts/local-project-browser-acceptance.mjs`：10 项通过。真实合成 CSV/XLSX 导入、重命名/归档/恢复、语义模型、真实本机 SQL 聚合 15/20、图表、结果快照及 Notebook 刷新；退出项目不改变临时工作区。页面异常和控制台 error 均为 0；该脚本阻断模型请求。
- 7 张截图逐张检查：自动保存警告、恢复后的菜单、空项目、语义计算、Notebook 图表、桌面与窄屏 Data Browser。未发现本次布局回归。

首次浏览器验收发现本轮新控制器把原生 `queueMicrotask` 当作实例方法调用，浏览器报 `Illegal invocation`；Node 替身测试未暴露此问题。已改为保留原生调用方式的回调，并新增针对接收者的回归测试。重新执行两条完整浏览器流程和全量检查后通过；没有忽略异常或减少断言。

浏览器证据：

- `.runtime/studio-persistence-2026-09-14T04-51-40-791Z/`（补强断言前的通过结果亦保留于同前缀 `2026-09-14T04-44-52-206Z/`）
- `.runtime/local-project-browser-2026-09-14T04-44-52-244Z/`

首次失败截图分别保留在相同前缀的 `2026-09-14T04-43-35-339Z` 和 `2026-09-14T04-43-35-349Z` 目录。没有删除用户文件；成功验收的合成项目留作复核，不是便携分发包。

## 后续替换位置

- 更换项目保存传输：实现 `ProjectStateWriter`，在 `core/projects/client.ts` 的组装点替换，队列测试无需替换全局 fetch。服务器文件格式变化仍需单独设计迁移，不属于“零修改替换”。
- 更换浏览器/工作区存储：实现已有 `StudioRepository`，在工作台恢复或项目 Provider 中组装。必须保留 `save()` 同步语义；异步磁盘状态仍用项目队列协议表达。
- 更换模型：沿用前轮的 `HarnessModel` 与 `core/ai/server/harness-composition.ts`；不需要更改本轮保存模块。图片、流式和工具能力差异仍需适配。
- 更换数据库：沿用 `core/connections/server/query-contracts.ts` 的驱动契约及 `server/query.ts` 组装；Notebook 本地 SQL/日志通过 `core/notebook/server/runtime.ts` 注入。方言、超时、取消和权限必须保留。
- 更换 Agent 策略或 Dashboard 渲染器：仍是对应协调/策略模块和现有渲染适配的独立任务；本轮没有宣称这两部分已完全解耦。

## 工作区状态、保留与风险

- 仍为 `feature/eds-analysis-dashboard`、HEAD `15ebdae`，保留原有及本轮未提交修改，未暂存/提交/推送/合并/切换分支。近期 Hex 布局和前两轮未提交重构均保留。
- 稳定站 3000、开发站 3001、截图服务 3198 前后健康；进程、启动时间及稳定版本不变。只在 3001 验收，没有发布、重启服务或重新生成便携包。
- `ProjectStudioRepository` 暂保留兼容构造入口；只有 Provider 和其他现有调用方明确迁移到新组装入口后才能删除，当前不维护双份实现。
- 主组件仍有恢复、备份、审计及 ChangeSet 协调职责；大文件问题、完整存储迁移和渲染器解耦不在本轮范围。用户没有授权新的业务行为，因此未继续拆更多模块。
- 3 项原有 EDS 真实工作簿验收跳过；没有调用付费模型、连接真实远端数据库、企业账号或生产系统。没有进行真实断电、磁盘损坏或跨浏览器矩阵测试。
- 快照 schema 校验仍同步执行，项目写入仍有原 400 ms 等待；临时关闭页面和未等待 flush 的风险没有被重构消除。队列的 `discardPending` 不是操作系统写入取消，也不负责重载磁盘，Provider 保留该责任。
- 历史 Agent 数据上下文/工具选择及 Dashboard 标签问题未处理；架构测试覆盖可解析静态/字面量动态依赖，不代表任意运行时动态加载的形式化安全证明。

本轮选定范围已完成，未留下半迁移模块或已知新增回归；剩余边界如上，不扩展为全项目重写。
