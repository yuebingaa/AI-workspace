# M6 第三包：按需文件诊断与安全恢复

日期：2026-09-21。范围固定为本地项目文件读取 / 恢复故障定位，以及数据表恢复失败不改变回收站。源码、聚焦 / 全量回归、类型、定向 lint、构建和 3001 浏览器 4 组 / 7 图验收已完成；3000 未发布，完整 M6 未完成。

## 依据与实际修改

- 原 `LocalProjectStore.readBytes` 的 `lstatSync` / `openSync` 抛出系统错误后，API 仅报告通用读取失败；原件下载客户端也丢弃服务器的具体校验提示。
- 原 `restoreTable` 先在 `edit` 内清除 `deletedAt` 并保存，再调用 `getTable`。两个新增失败测试在修改前复现：表文件缺失或摘要不符时恢复报错，但清单字节已经改变、回收站标记已经消失。
- 原损坏提示建议重新导入，但新导入会生成新 Dataset ID，不自动更新原 Notebook 引用。本包改为说明从完整备份核对恢复，不把重新导入等同于修复。

实际归属与接口：

| 文件 | 职责与变更 |
| --- | --- |
| `core/projects/server/store.ts` | `readBytes` 保留原路径、目录身份、普通文件、容量和有界读取约束；缺失文件及数据目录返回安全的相对位置。新增内部 `readTableEntry` / `readOriginalBytes` 复用校验；`restoreTable` 在修改清单前完成读取 / 摘要 / 格式验证，失败不写入 |
| `core/projects/client.ts` | `downloadProjectFile` 有界读取失败 JSON，保留有效服务器消息；无效 / 超限 / 超时错误体回退通用说明，成功下载路径不变 |
| `components/studio/projects/DataBrowser.tsx` | 复用现有错误区；目录提示明确“项目持久数据 · 读取时校验文件”，不增加独立状态库或全目录扫描 |
| `core/projects/server/file-diagnostics.test.ts` | 真实临时文件缺失、损坏、非法 JSON / Schema、非普通文件、数据目录缺失，以及失败不改清单、原字节恢复后原 ID 可用 |
| `app/api/projects/file-diagnostics.test.ts` | 通过现有 Dataset / 原件 / restore HTTP 路由验证错误、项目隔离、同源限制、模块热更新和恢复失败不写清单 |
| `core/projects/client.test.ts` | 新增下载错误有界读取、失败不触发下载与正常下载兼容测试，保留上批保存重试测试 |
| `scripts/verify-project-file-diagnostics.mjs` | 在隔离合成项目新增资源，核验归属后注入真实文件缺失 / 损坏；实际截图、恢复故障文件、比对原资源与 Notebook，保留失败尝试 |

没有新 API、第三方依赖、持久化字段、数据迁移或工具。Agent / Harness / SQL / Dashboard 仍通过原有业务接口使用项目数据，不新增能力或改变确认机制。文件系统实现继续由 Project 服务端拥有，浏览器只调用 HTTP；后续替换存储实现时须保留“先验证再恢复”和相同错误边界。

## 验证记录

- 开工基线：`npm test -- --run core/projects/server/store.test.ts app/api/projects/route.test.ts core/projects/client.test.ts --maxWorkers=2`，3 文件 / 37 项应用和 14 项 Node 通过。
- 红灯复现：新增表恢复缺失 / 损坏两项测试，修改前均在“清单不应改变”断言失败；修复后通过，没有删除或弱化断言。
- 聚焦：`npx vitest run core/projects/server/file-diagnostics.test.ts app/api/projects/file-diagnostics.test.ts core/projects/client.test.ts core/projects/server/store.test.ts app/api/projects/route.test.ts --maxWorkers=2`，5 文件 / 67 项通过。本包新增 30 项：存储 12、API 6、客户端 12。
- `npm run typecheck` 通过；`npx eslint core/projects/server/store.ts core/projects/server/file-diagnostics.test.ts app/api/projects/file-diagnostics.test.ts core/projects/client.ts core/projects/client.test.ts components/studio/projects/DataBrowser.tsx --max-warnings 0` 通过。
- `npm test -- --maxWorkers=2`：207 文件 / 2,252 项应用通过，既有 1 文件 / 3 项跳过；14 项 Node 通过，离线 Harness 评测 11/11。没有调用真实模型。
- `npm run build` 退出 0；保留既有大 chunk 警告，未发布。`node --check scripts/verify-project-file-diagnostics.mjs` 和该脚本严格 ESLint 通过。
- Agent 架构正文与变更记录已更新；`npm run docs:agent:sync`、`npm run docs:agent:check` 为 152 文件一致，`npm run docs:agent:test` 1 项通过。范围内 `git diff --check` 通过；没有全仓格式化。
- 全仓 lint 本批未执行；上一包已有 `.runtime` / vendor 生成代码及旧 worker 问题不冒称已修复。独立代理只读复核本包存储实现和回归测试，未发现阻断问题。

## 3001 浏览器证据

执行 `node scripts/verify-project-file-diagnostics.mjs --reuse-failed-project .runtime/hex-notebook-capability-toggle-2026-09-20/browser-1789916685499/project`。最终[报告](../../.runtime/hex-project-file-diagnostics-2026-09-21/browser-1789958629088/report.json)通过 4 组，7 张截图均实际打开查看；主代理另复看 02 / 04 / 05 / 07。1440 和 1024 宽度未见页面横向溢出，错误位置、恢复操作及恢复后的数据可读。

| 场景 | 本次证据与结果 |
| --- | --- |
| 新增合成数据并运行 | [初始 SQL](../../.runtime/hex-project-file-diagnostics-2026-09-21/browser-1789958629088/01-new-workspace-live-sql-1440.png)：真实 Data → SQL，East=150 / South=80 |
| 原件缺失 | [下载失败定位](../../.runtime/hex-project-file-diagnostics-2026-09-21/browser-1789958629088/02-original-missing-diagnostic-1440.png)显示真实 files/ 相对位置与备份建议；[表仍能分析](../../.runtime/hex-project-file-diagnostics-2026-09-21/browser-1789958629088/03-original-missing-table-runs-1024.png)确认缺原件不影响独立已导入表 |
| 表文件缺失 | [预览失败](../../.runtime/hex-project-file-diagnostics-2026-09-21/browser-1789958629088/04-table-missing-reference-retained-1440.png)显示 tables/ 位置；清单精确比对和 DOM 断言确认 Data Cell 引用及删除保护不变。引用页脚在截图内部滚动区下方，不冒称截图直接展示了该断言 |
| 回收站恢复失败 / 成功 | [缺失拒绝](../../.runtime/hex-project-file-diagnostics-2026-09-21/browser-1789958629088/05-archived-missing-restore-refused-1024.png)、[摘要异常拒绝](../../.runtime/hex-project-file-diagnostics-2026-09-21/browser-1789958629088/06-archived-changed-restore-refused-1440.png)：真实 409，deletedAt / stateRevision / 清单全部字节不变；放回原字节后[同 ID 恢复并预览](../../.runtime/hex-project-file-diagnostics-2026-09-21/browser-1789958629088/07-original-bytes-same-id-restored-1024.png)成功，原数据和摘要一致 |

3 次实际 SQL 均得相同预期值。4 个 409 来自真实文件故障，不是替换 API 结果；控制台对应 4 项预期错误，意外控制台 / 页面 / 路由错误和违规请求均为 0。只将连接目录、无句柄最近项目 GET 替换为空列表以隐藏其他记录，没有替换读取、恢复、Dataset 或运行结果。

首轮两组通过后，脚本导航定位器因图标与文案间空格匹配过严超时；[失败报告](../../.runtime/hex-project-file-diagnostics-2026-09-21/browser-1789958533016/report.json)保留，并列入最终 `attemptHistory`，失败图实际查看。只修正定位器后完整重跑，未修改产品迎合脚本。两轮文件故障均在 finally 恢复，最终 `restorationErrors=[]`；最终轮原有 6 表 / 5 原件 / 5 Notebook 的元数据、ID、摘要和定义不变，只新增本轮 1 个界面 / 2 表 / 1 原件。

前后 `npm run site:status` 均显示 stable / dev / capture 健康，PID / 修订 / 重启次数不变；未启停、重启或改配服务，3000 保持原发布版本。

## 安全范围与待完成

只操作合成测试资源。最近项目登记 100 条上限不改，不删除已有登记；浏览器复用已证明归属的失败验收项目，每轮新增独立资源。故障只针对本轮创建且路径 / ID / 原摘要核验通过的文件，先备份后暂移或写入合成坏字节，并在 finally 恢复；不操作旧文件或用户数据。

这不是自动修复、全目录扫描、OS 沙箱或跨进程文件事务。完整项目清单损坏、项目根目录丢失及未知格式兼容仍沿用原拒绝路径；错误定位不保证外部程序之后不再改文件。没有完整备份不能承诺恢复数据。原件和表分别保存，只缺原件不应抹掉已导入表；没有新增 AI 授权。

保留目录身份、符号链接拒绝、大小上限与读取中变化校验；未知 I/O 异常用脱敏说明，不返回系统绝对路径或文件内容。单个原件缺失与整个 `files/` 目录缺失不同：后者仍被既有公共目录检查阻断项目读取。独立只读复核未发现本包严重回归；校验通过后外部进程仍可修改文件，不把失败不改清单称为跨进程原子修复。真实权限故障、磁盘故障和跨进程并发替换不作为本批浏览器已验证场景。

分支 `feature/eds-analysis-dashboard`，保留用户及此前未提交内容；未提交 / 推送 / 切分支 / 合并 / 清理。只在 3001 验收，不重启服务或发布 3000；本包之外的删除影响、看板快照闭环、通用未知 Cell、物理卸载 Python 和 M7 保留。
