# M6 第一包：Python 能力关闭与恢复验证

日期：2026-09-21

范围：部署级 Python 逻辑关闭 / 恢复；不是物理卸载，也不代表 M6 全部完成。

状态：源码、自动化与 3001 分层验收完成；3000 未发布。

## 1. 实际完成

- `core/notebook/capabilities.ts` 定义浏览器、Harness 与执行器共用的能力契约，并检查禁用单元是否被草稿或自动流程修改、替换或移除。
- `core/notebook/server/capabilities.ts` 解析 `NOTEBOOK_PYTHON_ENABLED`：未设置及 `true/1/on` 为启用，`false/0/off` 为关闭，非法值明确报配置错误。
- `/api/notebook/python` 同时返回部署许可和 Runtime 可用性；关闭时不探测 Runtime。Notebook 在状态未取得前按关闭处理，避免加载期间短暂开放 Python 控件。
- Notebook 关闭 Python 后隐藏创建入口，保留旧定义、源码和依赖只读展示；编辑、单独运行、包含 Python 的整页运行及不安全的草稿采用被阻断。人工明确删除仍沿用原依赖确认，不由能力开关代替项目删除语义。
- Harness 不向模型暴露 `createPythonCell`、`getKernelPackagesInfo` 或包含 Python 的计划 Schema；直接伪造调用、整稿删除、增量修改 / 移除、运行及提交旧 Python 单元均在工具边界拒绝。混合文档仍可通过 CellSearch 只读检查。
- 服务端 Notebook 运行时最终以服务器环境能力为准，调用方不能伪造启用状态。关闭时在创建 Python session 之前失败并阻断其下游；无依赖的非 Python 分支仍可由人工单独执行。
- 恢复后复用原项目定义，不迁移或改写 Python 代码。

## 2. 状态矩阵

| 状态 | 浏览器 | Agent / Harness | 服务端执行 |
| --- | --- | --- | --- |
| 状态未取得 | Python 控件保持关闭，旧定义可见 | 服务端策略仍是最终依据 | 按部署配置决定 |
| 已启用且 Runtime 可用 | 可创建、编辑、运行 | Python 工具与计划字段可用 | 可建立 Python session |
| 已关闭 | 不提供创建；旧定义只读；整页运行受阻；独立非 Python 分支可单独运行 | 不宣传 Python 工具；拒绝修改、移除、运行或提交禁用单元 | 创建 session 前拒绝 Python，下游阻断 |
| 配置恢复 | 同一份定义重新可编辑、运行 | 工具目录恢复 | 同一运行端口恢复，无数据迁移 |

能力开关不是权限系统，也不改变 Dataset、连接、项目角色或 ChangeSet 的权限边界。

## 3. 自动化验证

最终检查结果：

- 聚焦回归：10 个测试文件、95 项通过，另 14 项 Node 工具测试通过；覆盖纯能力规则、状态 API、运行时强制覆盖、执行阻断、Harness 目录 / 直接调用 / 草稿保护、初始 fail-closed 和 UI 恢复。
- 全量回归：`npm test -- --maxWorkers=2` 退出 0；204 个测试文件通过、1 个跳过，2,206 项通过、3 项跳过；随后 14 项 Node 工具测试全部通过。离线 Harness 评测 11/11 通过。
- 类型：`npm run typecheck` 退出 0。
- 构建：`npm run build` 退出 0；保留已有客户端 chunk 大于 500 kB 的警告。
- 相关源码 / 测试 / 验收脚本的定向 ESLint 通过。
- 仓库级 `npm run lint` 未取得源码结论：脚本扫描 `.runtime` 的旧便携包产物后，ESLint formatter 抛出 `RangeError: Invalid string length`。显式排除 `.runtime` 后仍扫描 `vendor/python` 生成文件及既有 CommonJS worker，得到 8 个错误、5,408 个警告；未通过删除生成文件、关闭规则或修改本包源码来伪造全局通过。
- Agent 架构正文、变更记录与源码指纹同步检查在收尾后通过。

服务端关闭边界由模块、API handler 和运行时组合测试覆盖：即使调用者传入伪造的启用能力，环境为关闭时也不会创建 Python executor。没有为了浏览器测试重启或改配受管开发站。

## 4. 3001 浏览器证据

最终隔离合成项目报告：[report.json](../../.runtime/hex-notebook-capability-toggle-2026-09-20/browser-1789917314398/report.json)。4 个场景、4 张 1440×1000 截图全部通过并已实际查看；页面异常、控制台错误和违规请求均为 0。

| 场景 | 证据 | 实际边界 |
| --- | --- | --- |
| 启用前真实运行 | [01-live-python-before-disable-1440.png](../../.runtime/hex-notebook-capability-toggle-2026-09-20/browser-1789917314398/01-live-python-before-disable-1440.png) | 真实受管 3001 的 GET / POST；Python 结果 East=300、South=160 |
| 关闭态只读定义 | [02-disabled-python-readonly-1440.png](../../.runtime/hex-notebook-capability-toggle-2026-09-20/browser-1789917314398/02-disabled-python-readonly-1440.png) | Playwright 只替换 `GET /api/notebook/python`；验证创建隐藏、定义保留、编辑 / 运行禁用，不代表服务端已关闭 |
| 关闭 UI 下独立 SQL | [03-disabled-ui-independent-sql-1440.png](../../.runtime/hex-notebook-capability-toggle-2026-09-20/browser-1789917314398/03-disabled-ui-independent-sql-1440.png) | SQL 由真实 3001 执行，结果 East=150、South=80；当时服务器仍为默认启用配置 |
| 恢复后真实运行 | [04-live-python-restored-1440.png](../../.runtime/hex-notebook-capability-toggle-2026-09-20/browser-1789917314398/04-live-python-restored-1440.png) | 恢复真实 GET，原定义无需迁移；真实 POST 再得 East=300、South=160 |

首轮自动化因没有处理已有“输出变量改名确认”交互而失败，失败截图保留在 `.runtime/hex-notebook-capability-toggle-2026-09-20/browser-1789916685499/`；修正验收脚本后最终轮通过，产品代码未为迎合脚本弱化确认。

## 5. 未完成与发布状态

- `vendor/python`、Runtime 适配器和构建复制仍存在；物理卸载、无 Python 资源构建及旧项目兼容器不在本包范围。
- 未在真实 HTTP 浏览器会话中将受管 3001 以 `NOTEBOOK_PYTHON_ENABLED=false` 重启；因此关闭态截图不能作为真实 disabled-server 证据。该服务端边界只由进程内自动化验证。
- M6 的完整保存 / 关闭 / 重开、缺失文件、通用未知 Cell、删除影响、看板快照 / 撤销闭环仍需后续批次。
- 没有调用真实模型、外部数据库或用户业务文件；浏览器使用隔离合成项目。
- 源码已由当前 3001 热更新环境承载；没有执行 `site:publish`，稳定站 3000 保持原发布版本。
