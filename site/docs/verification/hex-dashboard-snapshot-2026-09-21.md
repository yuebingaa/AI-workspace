# M6 第七包：Notebook 看板快照闭环

日期：2026-09-21。状态：本包限定范围的源码、自动化与 3001 实际验收已完成；不代表整个 M6 / M7 完成。3000 未发布。

## 冻结范围与实现

- 沿用真实 `/api/notebook/run` 的 snapshot action：重新运行，取得请求内完整结果，保存带来源的独立 Dataset，然后生成 ChangeSet 预览；不把浏览器旧结果直接当作快照。
- `core/notebook/dashboard-review.ts` 与 `components/studio/notebook/NotebookSnapshotReview.tsx` 分开纯来源投影 / 定义比较和 UI；展示来源版本、单元、runId、生成时间、行列数、存储边界，不展示 SQL 或原始 rows。定义已修改 / 移除时明确是历史固定结果，允许显式确认，不伪装为最新结果。
- `core/changesets/confirmation.ts` 复用原执行与权限，核对预览身份、规范化的正式基线、完整 ChangeSet 和最终候选；基线仅在 `previewChangeSet` 返回的内存预览中，不进入持久化或 API。`StudioWorkspace` 接线当前状态，取消显式保存审计，Notebook 确认按钮标为“确认加入看板”。`DataProductCanvas` 用通用详情 / 确认 / 取消文案插槽，不引入 Notebook 执行依赖。
- `core/notebook/dashboard-policy.ts` 共用快照边界；表格超过 30 列拒绝而非静默裁剪，普通 Dataset 保存不收紧。已有 500 行、分类唯一和有限图表数值检查保留。
- 取消、撤销保留已经保存的结果表和来源；未确认预览不跨窗口恢复应用。没有格式迁移、新 API / 模型服务 / 动态 App / 自动清理。

## 基线与验证

- 修改前：`npm test -- core/changesets/executor.test.ts app/api/notebook/run/route.test.ts core/notebook/result-availability.test.ts --maxWorkers=2`，3 文件 / 43 项应用及 14 项 Node 通过。
- 首轮类型检查发现新 UI 对可选 `dataProduct.notebooks` 的访问遗漏；补齐可选访问后 `npm run typecheck -- --incremental false` 通过。
- 独立审查修正两处本批风险：生成快照不再清空尚未应用的 Puck 编辑稿；确认不能只比较最终 AppSpec（会漏掉被同一操作覆盖的正式页变化），改为同时校验正式基线与完整 ChangeSet，并补重叠修改 / 等价结果但审阅文案变更测试。
- 首轮架构断言误将 Canvas 既有传递依赖的纯 Notebook Schema 一并禁止，修为精确保护本次 review / policy / dashboard 实现与所有 server 依赖；29 项通过，未移除既有边界。宽表首版 API 测试用 SQL 生成 31 列触发既有 SQL 运行器限制，改用真实 CSV → DataRecipe 路径证明合法宽表行为，未放宽限额。
- 定向新增验证：policy / 投影 / API / 可用性 4 文件 62 项通过（新增 29）；来源 / 审阅 / 初版确认 3 文件 19 项通过；加强正式基线后补 5 项，同相关 ChangeSet 与架构检查 5 文件 63 项通过。本批合计新增 55 项应用回归（含 2 项架构边界），未删除 / 跳过失败测试。
- 最终 `npm test -- --maxWorkers=2`：222 文件、2,389 项应用通过；原有 1 文件 / 3 项跳过不变，另 14 项 Node 工具测试通过，离线 Harness 11/11。日志：[最终全量](../../.runtime/hex-dashboard-snapshot-2026-09-21/tests-final.log)。第一轮 2,384 项通过后才增加基线回归，最终结果不沿用初轮。
- `npm run typecheck -- --incremental false`、本批 20 个 TS / TSX 和 3 个脚本严格 ESLint 通过；`npm run build` 通过，保留已有大于 500 kB chunk 提示（PowerShell 将 stderr 警告包装为 NativeCommandError 文本，命令实际退出 0）。[最终构建日志](../../.runtime/hex-dashboard-snapshot-2026-09-21/build-final.log)。
- `npm run docs:agent:sync` / `docs:agent:check` / `docs:agent:test` 通过：将 ChangeSet 3 个源文件纳入指纹，最终共 160 文件，并验证新增确认模块变化会触发过期检查；源码差异检查通过。未运行全仓 lint，不声称修复其他既有问题。
- API 回归验证 31 列快照拒绝且不写入、30 列保留全部字段、100 列 Dataset 完整保存；图表重复分类与 NULL 数值保留原报错及不写入行为。模型为离线替身，未调用付费模型或本轮实库。

## 3001 实际验收

最终脚本：`node scripts/verify-notebook-dashboard-snapshot.mjs --reuse-failed-project .runtime/hex-notebook-capability-toggle-2026-09-20/browser-1789916685499/project`。在核对旧合成项目身份、全部文件 SHA、允许的数据内容并备份清单后复用，不增加最近项目登记、不删除原资源。

[最终浏览器报告](../../.runtime/hex-notebook-dashboard-snapshot-2026-09-21/browser-1789976094817/report.json)：9 组 / 16 张桌面截图，1440×1000 与 1024×900。Notebook 四步定义经明确的真实 scoped API 设置，导入、编辑、运行、生成快照、确认、取消、撤销均走真实 UI；没有预置看板节点或替换执行 / 保存响应。连接目录及无句柄的最近项目 GET 使用空 fixture；Puck 固定公共字体 CSS URL 两次由空 CSS fixture 截获，未联网。

| 场景 | 实际结论 |
| --- | --- |
| SQL → 表格 / 图表 | 原始三行合成为 East=150、South=80，正式看板初始为空 |
| 未确认表格快照 → 改 Notebook → 取消 | 显示历史版本提示，正式节点 / 撤销条数不变，快照表和来源保留 |
| 历史图表快照确认 | 来源 revision 3、当前定义 revision 4；明确确认后仍是 150 / 80，状态 116→117 |
| 修改并重跑 Notebook | 新结果 300 / 160，不改已保存的 150 / 80 看板 |
| 撤销 | 状态 117→118，移除本次看板变更，不回滚 Notebook / 删除原表或快照 |
| 重新生成当前图表与表格 | 分别确认独立结果，两者均为 300 / 160 |
| 新标签页重新打开 | 看板、来源和撤销历史保留，Notebook 运行缓存为空；运行请求计数 9→9，没有自动执行 |
| 重复分类真实失败 | API 400，状态 121→121、表数量 36→36；无半保存快照或正式看板修改 |
| 已有 Puck 未应用草稿 → 快照 → 取消 | 返回原编辑模式，修改的标题仍在；状态 122→125 仅保存相关快照 / 审计，正式页面不变 |

13 次真实 Notebook HTTP：12 成功、1 个预期 400；共保存 5 份结果快照。最终轮开始的 31 表 / 14 原件 / 14 Notebook 及既有页面、语义模型、文件字节和元数据均保留；结束为 37 表 / 15 原件 / 15 Notebook。重复运行只添加本轮合成资源，没有清理以前的验证数据。

重点截图：[来源审阅](../../.runtime/hex-notebook-dashboard-snapshot-2026-09-21/browser-1789976094817/02-table-preview-unconfirmed-1440.png)、[取消后保留数据](../../.runtime/hex-notebook-dashboard-snapshot-2026-09-21/browser-1789976094817/03-cancelled-preview-keeps-snapshot-1024.png)、[历史版本提示](../../.runtime/hex-notebook-dashboard-snapshot-2026-09-21/browser-1789976094817/04-historical-snapshot-review-1440.png)、[撤销](../../.runtime/hex-notebook-dashboard-snapshot-2026-09-21/browser-1789976094817/07-undo-keeps-source-and-definitions-1024.png)、[重开看板](../../.runtime/hex-notebook-dashboard-snapshot-2026-09-21/browser-1789976094817/11-reopened-persistent-dashboard-1024.png)、[真实失败](../../.runtime/hex-notebook-dashboard-snapshot-2026-09-21/browser-1789976094817/12-real-duplicate-category-refusal-1440.png)、[原编辑稿保留](../../.runtime/hex-notebook-dashboard-snapshot-2026-09-21/browser-1789976094817/15-cancel-restores-existing-editor-draft-1440.png)。其余逐图场景见报告。

最终 16 张截图全部实际查看，主代理另复看 02 / 04 / 11 / 15：来源卡与历史版本说明可读，重开表格 / 图表显示 300 / 160，取消后的原 Puck 标题输入仍保留。截图不替代接口、清单与字节核对，也不代表手机端验收。

控制台并非零告警：1 条预期 400、1 条 Puck 的 CSS top NaN；后者经[普通编辑 / 切模式独立探查](../../.runtime/hex-notebook-dashboard-snapshot-2026-09-21/puck-baseline-warning.json)复现，没有任何 Notebook 运行或 snapshot 请求，定义 / 页面 / 表原件均不变。本轮不修改第三方隐藏布局测量；确切原因仍是推测。未预期错误、页面异常、路由异常、违规外网请求均为 0。

前轮记录保留：第一轮 8 组 / 13 图通过，但不是最终补强范围；第二轮误以为生成新快照后整个历史对象字节不变而失败，按原 `synchronizeUploadedDatasetExecution` 正确核对每条历史只同步新增数据源，仍逐项严格比较其余内容；第三轮 9 组交互通过但被字体请求 / NaN 的零错误门槛拒绝，记录为失败，并非丢弃；第四轮 9 组通过但 Puck 标题截图偏底部，最终只修截图定位后完整复跑。没有弱化产品值、历史、来源或保存断言。

## 工作区与启用状态

分支 `feature/eds-analysis-dashboard`，本次和原有修改均未提交 / 推送；未清理数据、改分支或生成便携包。三个受管服务在前后 `npm run site:status` 均健康，supervisor / PID / worker / revision / 启动时间与重启数不变，稳定 release 不变。仅 3001 当前源码验收，未发布 3000。

主要新增文件是 `core/notebook/dashboard-policy.ts` / `dashboard-review.ts`、`core/changesets/confirmation.ts`、`components/studio/notebook/NotebookSnapshotReview.tsx` 及五份测试；改动原 API / 结果可用性 / ChangeSet executor / 工作台 / Canvas 的适配入口，未移动或删除既有模块。以后调整快照显示限制改 policy，修改来源审阅改 review，替换渲染改 Canvas / 图表适配；数据库、模型和 Notebook 执行端口未被重新绑定到 UI。`check-agent-architecture` 增加 ChangeSet 源码跟踪，相关说明维护在唯一架构入口。

## 保留边界

仅验证本机合成项目，不调用真实模型或外部数据库。来源定义比较不是数据新鲜度检查或权限凭证；固定快照不随原步骤重跑更新。项目保存和 Dataset 写入仍是既有独立事务，失败可能留下已保存结果，不能自动删除用户可用数据。本批不实现未知 Cell 兼容、Python 物理卸载或 M7 整体回归。

31 / 100 列、查看者和确认基线竞争由自动化验证，未单独浏览器截图；重开指新标签页，不是服务 / 系统重启。审阅信息最多保留一份窗口内投影，其他预览替换后由 ID 匹配隐藏，部分放弃路径到下一次快照或工作台卸载才释放旧投影，不作跨用户权限机制。CSS top NaN 与已有构建大 chunk 提示保留；未执行全仓 lint 或新一轮真实 AdventureWorks 验收。
