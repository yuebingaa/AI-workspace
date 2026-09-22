# DSH 网站嵌入第一批（2026-09-22）

## 冻结范围

本批接通可切换完整执行器：原版保持默认，官方 DSH 作为明确标记的本地实验选项。四个受控 Notebook 工具、单 CSV → 本地 SQL / 表图 → 待采用草稿；新增引擎设置和只读插件目录。复用现有身份、会话、幂等、SSE、数据授权和人工采用，不接新模型、任意插件安装、Shell、外部 MCP、Python、数据库连接或 Excel 原件。

普通模型调用不新增字符 / Token / 次数配额；保留执行时限和工具次数保护。不开启真实付费模型验证，不发布 3000，不改变受管服务，不修改主依赖锁文件或用户项目。本批完成边界是上述链路及其离线、接口和界面验收，不扩大到整个 DSH 产品功能。

## 实施记录

- 基线：`npm test -- --maxWorkers=2` 为 2,527 应用测试与 26 Node 测试通过，原 1 文件 / 3 项跳过。日志 `.runtime/dsh-embedding-baseline-tests.log`。
- `core/agent-engines/contracts.ts` 定义共享引擎 / 设置 DTO；`server/selection.ts` 持有进程内选择与任务租约；`server/executor.ts` 独占内核组装。
- `server/dsh-engine.ts` 只适配真实工具、上下文和业务回执，不套原 HarnessRuntime 循环；`server/tool-broker.ts` 提供任务级 IPv4 回环令牌能力；`server/dsh-driver.ts` 连接官方 SDK 并隔离凭据。
- `runtime/dsh/` 固定官方 `0.1.6-alpha.2`，官方 SDK 启动独占子进程，受控 profile 只注册四工具；关闭默认终端、文件作业、持久化和其他外部能力。`scripts/setup-dsh-runtime.mjs` 单独安装，主包 / 锁不变。
- 网站 handler 保留外层授权 / 会话 / 幂等，进入执行时固定选择；评测 / 可视化实验页仍固定原执行器。设置 API 和 UI 不发模型请求。
- 发现并修复：SDK idle 不代表成功，须核对唯一成功 turn/end；取消时等待 SDK 回收后才释放网站任务租约；只从 DSH 的任务副本剔除不可用的全局连接目录，避免纯 CSV 被误阻断，实际远端 SQL 仍严格拒绝。原授权闭包及调用方请求不变。

## 验证与交付状态

验证采用三层证据，不混淆：

1. 官方 SDK 载体：`node --test runtime/dsh/driver.test.mjs` 8 项真实 SDK 子进程测试通过。模型是固定动作，另有官方 DeepSeek Adapter 对本机模拟 SSE 的请求兼容性验证；无真实供应商请求。
2. 真实业务组合：`node scripts/verify-dsh-embedding.mjs` 通过。官方 SDK / AgentLoop → 带令牌 broker → 四个真实工具 → SQL / Table / Chart 均为 150 / 80 → 原 SSE → 待采用草稿；显式内存采用可生成新文档，原文档未改。取消贯通 Notebook 信号，返回前 driver 已完成清理，没有草稿。[最终机器报告](../../.runtime/dsh-embedding-1790042075057/report.json)。公开 handler 另由 8 项固定 DSH driver 测试覆盖授权、JSON/SSE、两轮服务端上下文、跨切换幂等与占用锁，不将其当作真实模型测试。
3. 3001 界面：`node scripts/verify-dsh-settings-browser.mjs` 6 组 / 8 图通过。真实 GET / PATCH：原版 rev0 → DSH rev1 → 原版 rev2；取消零 PATCH，失败为明确注入的 503，然后真实刷新恢复。1440 / 1024 无横向溢出，页面异常 0。全部图实际查看，主代理复看 02 / 05 / 06 / 08。[报告与截图目录](../../.runtime/dsh-settings-browser-2026-09-22/browser-1790041529816/report.json)，[DSH 选择成功截图](../../.runtime/dsh-settings-browser-2026-09-22/browser-1790041529816/05-dsh-applied-1440.png)。该截图不证明浏览器真实模型分析、草稿采用或图表渲染全链。

第一轮整仓回归为 2,618 应用 + 26 Node 通过，3 项原有跳过；其后补连接目录投影和显式架构边界回归，最终 **246 文件 / 2,623 应用 + 26 Node 全部通过**，原 1 文件 / 3 项跳过保留。以下命令均实际执行成功：

| 命令 / 检查 | 本次结果 |
| --- | --- |
| `npm test -- --maxWorkers=2` | 上述最终全量；`.runtime/dsh-embedding-final-regression.log` |
| `npm run typecheck` | 通过；`.runtime/dsh-embedding-typecheck-final.log` |
| `npx eslint … --max-warnings=0`（本批源码 / 测试 / 脚本） | 通过；`.runtime/dsh-embedding-lint-final.log`，非声称整仓 lint |
| `npm run build` | 通过；`.runtime/dsh-embedding-build.log`，保留原有客户端大 chunk 提示 |
| `npm run docs:agent:sync` / `check` / `test` | 184 文件指纹一致，检查器 1 项通过；新增范围包括可选 Runtime 的显式文件，不扫第三方依赖 |
| `node --test runtime/dsh/driver.test.mjs` | 8 项 SDK 测试通过；`.runtime/dsh-embedding-sdk-tests.log` |
| 组合脚本 / 3001 浏览器脚本 | 上述分层成功、取消和截图通过 |
| 本批差异检查 / 架构边界 | 通过；无新增运行时循环，设置 UI 不导入服务端实现，原内核不依赖 DSH |

初次业务组合脚本误把 NotebookRun 的 `cells[].table.rows` 写为工具输出的 `results[].rows`，导致脚本断言失败、草稿被正确拒交付；修正测试脚本后成功。另修复新增设置 API 测试两处 HeadersInit 联合类型；直接 tsc 发现的临时 `.next/types` 不一致由正规 `npm run typecheck` 生成路由类型后消除。没有删失败断言、放宽校验或改变业务结果。

## 主要目录与替换点

```text
site/
  core/agent-engines/
    contracts.ts                 引擎与设置公共契约
    server/
      selection.ts               进程选择 / revision / 任务占用
      executor.ts                两内核唯一组装入口
      dsh-engine.ts              上下文 / 工具 / 验证 / 事件适配
      dsh-driver.ts              官方运行时与模型凭据组装
      tool-broker.ts             单任务受控工具传输
  runtime/dsh/                   锁定 SDK、profile、插件、网络策略
  app/api/settings/agent-engine/  本地设置 API
  components/studio/AgentEngineSettings.tsx
  app/agent-engine-settings.css
```

以后更换执行框架主要增加与原任务契约兼容的内核并在 `executor.ts` 组装；换 DSH 版本 / profile 主要影响 `runtime/dsh` 和 driver 的终态 / 生命周期协议；扩展业务工具应先扩大工具桥的明确范围及授权 / 回归，再注册插件。数据库 / Notebook / Dataset / 图表实现仍属于现有业务模块，没有复制进 DSH 插件。真实模型能力和新框架的事件 / 取消差异不保证零成本替换。

原版 Harness、业务注册器和上一步试点入口保留；它们不是第二套业务计算。主 `package.json` / `package-lock.json` 不变，没有删除文件或迁移数据。

## 工作区与启用状态

- 分支仍为 `feature/eds-analysis-dashboard`；保留开场 342 项既有状态，本批收尾普通 `git status --short` 355 项（未跟踪目录折叠显示，不是文件数）。未提交、推送、合并、切分支、stash 或清理历史。
- 3001 源码 / 设置已可用，DSH 已在本机独立安装；验收结束明确恢复原版，当前没有活动任务。选择作用域是本机服务进程，后续在菜单中显式切换。
- 三个受管服务均健康，PID / worker / revision / startedAt / 重启数及稳定 release 与开场一致；未停止、重启或发布。日志 `.runtime/dsh-embedding-service-final.log`。
- 未连接生产数据库、调用真实收费模型、操作用户项目或更改数据格式。运行截图使用隔离浏览器和空白演示状态；本地 SQL 使用合成 CSV / 独立内存数据。
- 根任务日志只追加本批；追加前 426,466 字节保留备份并核对历史字节前缀。此前重构 / M7 的未提交工作仍保留，M7 后续不算本批完成。

## 已知边界

- 仅本地 Node 模式，要求 Node 24 或更高；未支持 Cloudflare / 便携包 / 稳定发布部署 DSH。设置进程内保存，重启回到原版；不是项目级配置。
- DSH 新建任务级内存会话；受控网站历史摘要随请求提供，不迁移官方 DSH 持久化会话。SSE 来自实际业务事件，不曝光内部推理或宣称逐 Token 输出。
- 插件目录是固定接线的展示，不是插件市场、配置管理或任意安装能力。现有 DSH 主机插件不是操作系统安全沙箱。
- 隔离 SDK 完整 CLI 依赖树的 audit 报告 6 项 moderate（同一 fflate ZIP64 问题的传递路径）；当前受控 profile 未加载 Web / Office / 解压能力，但不能宣称整个依赖树无漏洞。未擅自升级或执行 audit fix。
- 真实模型策略质量、成本、复杂恢复与不支持业务迁移另行验收。本批离线固定动作不证明模型能自主正确分析任意文件。
