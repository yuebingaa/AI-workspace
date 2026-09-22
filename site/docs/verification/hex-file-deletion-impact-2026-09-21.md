# M6 第五包：原件删除影响审阅

日期：2026-09-21。状态：本包源码、自动化和 3001 真实流程验收完成；不是整个 M6 完成。未发布 3000。

## 冻结范围与实现

- `core/notebook/file-references.ts`：纯函数 `notebookFileReferences(notebooks, fileName)`，读取当前所有 Notebook 的显式 Python `fileNames`，返回身份和每一步的传递下游数量。复用现有依赖图，不访问 React、文件系统、数据库或模型。
- `components/studio/files/FileDeleteDialog.tsx`：两处入口共用影响清单和风险勾选；未勾选不能提交，文件名或完整引用清单改变时旧确认失效。至多展示十条，不截断确认范围；保留焦点、取消、权限 / 忙碌保护与失败重试。
- `FilesPanel.tsx`、`projects/DataBrowser.tsx`、`StudioWorkspace.tsx`：传递当前全部 Notebook，文件 ID 改变重建弹窗。恢复成功提示明确手动重跑。`app/files-panel.css` 仅补充局部暖灰样式。
- 新增纯函数、临时项目真实归档 / 解析 / 恢复及弹窗 SSR 测试；浏览器验收使用隔离合成项目，不运行真实模型、不访问外部数据库。

## 保持与边界

不改变归档 API、持久化、工具协议、数据库权限、输入解析或结果缓存。归档保留原件字节、表和 Notebook 定义；恢复前仍按现有逻辑校验字节，恢复使用原 ID。临时模式无回收站。

引用按精确文件名，不是文件 ID：本次 multipart 文件优先，否则取当前项目唯一未归档同名文件；多份同名拒绝。删除影响只描述可能的重跑失败，不宣称必然断链，也不保证原件身份绑定。已有结果不会自动失效或重新计算，恢复后需手动运行。

UI 影响确认不是服务端安全边界或跨窗口原子锁；不扫描自由代码或未采用草稿，不实现新删除审阅框架、看板快照闭环、通用未知 Cell、Python 物理卸载或整个 M6。

## 验证记录

- 修改前基线：`npm test -- --run components/studio/files/file-list.test.ts core/projects/server/store.test.ts app/api/projects/route.test.ts core/notebook/graph.test.ts --maxWorkers=2`：4 文件 / 54 项应用及 14 项 Node 通过。
- 新增 21 项：`core/notebook/file-references.test.ts` 9 项、`server/file-archive.test.ts` 6 项和 `FileDeleteDialog.test.tsx` 6 项。覆盖跨页 / 完整引用、大小写、下游去重、不可变性；真实临时项目归档 / 同 ID 原字节恢复、multipart 优先、同名歧义和项目隔离；UI 默认禁用 / 无引用 / 查看者锁 / 显示限长 / 临时模式 / 转义。
- 聚焦命令 `npm test -- --run core/notebook/file-references.test.ts core/notebook/server/file-archive.test.ts components/studio/files/FileDeleteDialog.test.tsx components/studio/files/file-list.test.ts core/architecture/module-boundaries.test.ts --maxWorkers=2`：5 文件 / 57 项应用 + 14 项 Node 通过，其中架构边界 27 项。
- `npm test -- --maxWorkers=2`：215 文件 / 2,306 项应用通过，既有 1 文件 / 3 项跳过；14 项 Node 通过，离线 Harness 评测 11/11。没有增加跳过、弱化断言或关闭类型检查。
- `npm run typecheck`、8 个修改 / 新增 TS 与 TSX 的 `npx eslint ... --max-warnings=0` 通过；`node --check scripts/verify-file-deletion-impact.mjs` 及该脚本严格 ESLint 通过。
- `npm run build` 通过，保留既有大于 500 kB chunk 提示。`docs:agent:sync` / `docs:agent:check` 源码指纹 154 文件一致，`docs:agent:test` 1 项通过。未重跑全仓 lint，不声称此前生成物 / worker 基线问题已修复。
- 独立只读复核未发现阻断问题，另跑 SSR 6 项与架构 27 项通过。SSR 不代表动态勾选失效、pending 失败、连点和键盘焦点已完成浏览器测试；这些保护保留代码复核边界。

## 3001 实际执行与截图

命令：`node scripts/verify-file-deletion-impact.mjs --reuse-failed-project .runtime/hex-notebook-capability-toggle-2026-09-20/browser-1789916685499/project`。

[本次完整报告](../../.runtime/hex-file-deletion-impact-2026-09-21/browser-1789971013596/report.json)：首轮 5 组 / 9 图通过，无失败尝试。所有 Notebook 运行都以真实 JSON 请求读取项目原件，未用 multipart 临时上传替代；3 次成功计算均为 East=150 / South=80。

| 页面 / 场景 | 本次截图 | 验收结果 |
| --- | --- | --- |
| Notebook / 项目原件 Python → SQL | [01 · 1440](../../.runtime/hex-file-deletion-impact-2026-09-21/browser-1789971013596/01-project-original-python-success-1440.png) | 真实读取原件，回执来源 SHA 与文件一致 |
| 原始文件侧栏 / 未勾选 | [02 · 1440](../../.runtime/hex-file-deletion-impact-2026-09-21/browser-1789971013596/02-sidebar-risk-unacknowledged-1440.png) | 引用步骤及下游 1 步可见，删除禁用 |
| 原始文件侧栏 / 勾选后取消 | [03 · 1440](../../.runtime/hex-file-deletion-impact-2026-09-21/browser-1789971013596/03-sidebar-deletion-cancelled-1440.png) | 无归档请求、清单及原件不变 |
| Data Browser / 另一入口未勾选 | [04 · 1024](../../.runtime/hex-file-deletion-impact-2026-09-21/browser-1789971013596/04-data-browser-risk-unacknowledged-1024.png) | 同样的影响说明，前次取消勾选不复用 |
| Data Browser / 确认归档 | [05 · 1024](../../.runtime/hex-file-deletion-impact-2026-09-21/browser-1789971013596/05-file-archived-definitions-retained-1024.png) | 原件退出活动目录；真实 API 版本 41→41，表 / 定义 / 文件字节保留 |
| Notebook / 缺原件真实失败 | [06 · 1440](../../.runtime/hex-file-deletion-impact-2026-09-21/browser-1789971013596/06-python-missing-original-downstream-blocked-1440.png) | HTTP 200 携带 run.failure；Python 缺件，下游 SQL blocked，不复用旧成功结果 |
| Notebook / 独立表链继续运行 | [07 · 1024](../../.runtime/hex-file-deletion-impact-2026-09-21/browser-1789971013596/07-independent-data-sql-still-runs-1024.png) | 原件仍归档，持久表 Data → SQL 结果正确 |
| Data Browser / 同 ID 原件恢复 | [08 · 1024](../../.runtime/hex-file-deletion-impact-2026-09-21/browser-1789971013596/08-same-original-restored-no-auto-run-1024.png) | 原 ID / 关联 / SHA 不变；未产生自动 Notebook 请求 |
| Notebook / 手动重跑恢复 | [09 · 1440](../../.runtime/hex-file-deletion-impact-2026-09-21/browser-1789971013596/09-explicit-python-rerun-restored-1440.png) | Python → SQL 成功，结果和来源 SHA 与首次一致 |

9 张截图全部实际查看，报告 `visualReview.completed=true`；主代理另复看 02 / 04 / 06 / 09，弹窗和错误 / 成功结果可读，无页面横向溢出。截图可见性与清单 / HTTP 证据分别验证，不把图 05 当作显示文件字节不变的证明；图 08 显示恢复提示与计数，屏外原件行不宣称已直接截图，ID / SHA 由真实 API 和字节校验确认。

仅连接目录 GET 与不带项目句柄的最近项目列表 GET 用空列表隐藏其他记录；导入 / 新界面 / 两入口归档 / 恢复通过 UI，Notebook 四单元定义为真实项目 API 保存的明确合成夹具，不代表单元编辑器创建流程验收。缺件来自真实归档，不替换执行结果；浏览器控制台、页面、路由及违规请求错误为 0。

登记已有 100 条，未增加限制或清理登记。先核验旧失败合成项目归属、固定合成行与全部摘要并备份清单，仅新增本轮工作界面 / CSV 表 / 原件 / Notebook；原 9 表、7 原件、7 Notebook、语义层和旧页面及所有旧文件摘要不变。本轮原件归档后已恢复，没有物理删除数据，`cleanupErrors` 为空。

## 未验证与后续边界

- 跨页引用与超过十条由纯函数 / SSR 测试覆盖，浏览器采用一页一个 Python 引用；未截图验证无引用 / 临时文件 / 查看者分支。
- 同名原件和 multipart 优先由真实临时项目集成测试覆盖，浏览器仅验证唯一项目文件名。
- 动态引用变化使勾选失效经过代码复核；不是跨窗口锁，异步提交开始后不再次检查影响指纹。忙碌关闭 / 连点、归档 API 网络失败与焦点圈定本包未单独做浏览器交互验收。
- 不新增自动缓存失效，真实模型、外部数据库、物理 Python 卸载、通用 Cell 删除审阅、看板快照完整闭环及 M7 未在本包执行。

## 实际模块边界

Notebook 领域拥有文件依赖分析与图遍历；UI 只接收当前状态并呈现确认；项目客户端 / Store 继续拥有归档与完整性校验；服务端 Notebook 文件解析继续拥有请求 / 项目文件选择，执行器负责缺件失败和下游阻断。Agent、Harness、模型 / 数据库适配和 Dashboard 执行接口未改。

后续扩充文件型单元主要修改 `file-references.ts` 及对应解析适配，不需在两个弹窗重复实现规则。若要改变文件身份绑定或缓存失效，需要单独设计契约和兼容迁移，不能仅替换本次提示函数。

## 服务与工作区

分支 `feature/eds-analysis-dashboard`，HEAD `df5bbaeda3f2c95465949b5a71dec9956ff00823`；保留已有未提交修改，不提交、推送、合并、切换、stash 或清理。开工及收尾 `npm run site:status` 均为 stable / dev / capture 健康，PID / 运行修订 / 重启次数不变，不启停、重启、改配或换端口；3000 保持 `2026-09-09T06-17-07-261Z-36adf84e`，本批仅 3001 热更新验收。
