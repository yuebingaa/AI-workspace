# M6 第二包：项目保存失败恢复与重开

日期：2026-09-21。限定范围：本地项目定义的显式保存重试、丢失成功回执核对、真实版本冲突保护，以及 Notebook 保存后重开验证。不是整个 M6 完成，也不是自动冲突合并。源码、自动化检查及 3001 浏览器 4 组 / 11 图验收已通过，3000 未发布。

## 原问题与实际修改

`core/projects/state-repository.ts` 原有保存队列在任何写入错误后都会暂停自动保存并保留 pending，但没有恢复接口；`DataBrowser` 只提供确认放弃修改、重新打开磁盘版本。因此暂时性失败也无法在保留编辑的同时重新保存。

本包保持既有 API、项目清单格式、400 ms 合并保存、原子写入与 `stateRevision` 比较，增加以下窄边界：

| 归属 | 实际接口与职责 |
| --- | --- |
| `core/projects/state-repository.ts` | `ProjectStateReader(handle)`、`ProjectStateWriter(input)`、`retry()`；队列拥有本地最新定义、失败候选、版本、dirty 和恢复单飞，不访问 HTTP、当前选中项目或文件系统 |
| `core/projects/client.ts` | `ProjectStudioRepository` 将原有 `loadProject` 与保存请求接入上述端口，读写始终使用实例固定句柄，不跟随全局活动项目 |
| `core/projects/state-normalization.ts` | `normalizeProjectStateForStorage` 是浏览器与服务器可共用的纯函数；将项目现有表目录中的名称、访问策略和持久标记按原规则应用到工作台定义，不读取文件或整表数据 |
| `core/projects/server/store.ts` | `saveState` 保留身份、引用和乐观并发校验，调用共享规范化，再使用原有清单原子写入；没有迁移格式或新增写入路径 |
| `components/studio/projects/LocalProjectsProvider.tsx` | 对 UI 暴露 `retrySave`，委托 repository，不复制恢复判断 |
| `components/studio/projects/DataBrowser.tsx` | 保存错误时显示“重试保存”和保留编辑说明；等待期间禁用重复操作，失败保留状态；显式放弃仍经过原确认 |
| `app/data-browser.css` | 仅为面板顶层成功提示增加同错误区一致的内边距，不影响资源详情内说明或全局样式 |

这是项目持久化模块变化，没有改 Agent 策略、模型 SDK、Tool 名称、SQL 方言、Dataset 读取权限、Dashboard 渲染或 ChangeSet 确认规则。Notebook、看板等正式定义继续使用同一项目状态所有者，不新建第二份真相来源。

## 恢复规则

1. 失败时保留提交快照和当时版本，后续本地编辑继续合并；不在后台无限重试。
2. 用户点击重试后先读取固定项目，校验句柄和项目 ID。期间不恢复自动写入，后续编辑仍保留。
3. 磁盘版本没有前进：按原版本提交最新待保存定义；服务器继续阻止读取与写入之间发生的竞争。
4. 磁盘恰好前进一次，且内容等于失败快照按相同规则规范化后的定义：确认上次已经落盘，不重复提交；若本地已有更新编辑，再串行保存新版本。比较忽略保存时间，不忽略业务定义。
5. 其他版本、身份或内容不一致：拒绝覆盖，保持 dirty，用户可先导出备份，再明确选择是否放弃。读取或再次提交失败仍可后续显式重试。

成功提示在整条当前待保存队列排空后发出，不在仍有更新编辑等待写入时短暂报告已保存。

## 自动化验证

- 修改前基线：`npm test -- --run core/projects/state-repository.test.ts core/projects/client.test.ts core/projects/server/store.test.ts components/studio/workspace/persistence-controller.test.ts --maxWorkers=2`：4 文件 / 46 项应用测试及 14 项 Node 工具测试通过。
- 新增 16 项：队列 10 项，固定句柄客户端 1 项，真实临时目录存储集成 5 项；覆盖无写入失败、丢失回执、在途 / 检查期间编辑、重复重试、读取失败、身份变化、不同版本及检查后的写入竞争。
- `core/projects/server/save-recovery.test.ts` 使用真实 `LocalProjectStore` 与独立临时项目验证保存后重开、原表字节不变、表名 / consent 规范化和真实第二写入者冲突。没有使用用户数据、真实模型或远端数据库。
- 最终 `npm test -- --maxWorkers=2`：205 文件通过、1 文件既有跳过；2,222 项应用测试通过、3 项既有跳过；14 项 Node 测试通过；离线 Harness 评测 11/11。退出码 0。
- `npm run typecheck`、9 个本批 TypeScript / TSX 文件严格 ESLint、`npm run build` 通过；构建保留原有大 chunk 提示。
- Agent 文档正文与变更记录同步；`npm run docs:agent:sync` / `npm run docs:agent:check` 为 152 文件一致，`npm run docs:agent:test` 的 1 项文档守卫测试通过。
- `node --check scripts/verify-project-save-recovery.mjs` 与该脚本严格 ESLint 通过。成功提示内边距修正后重新运行完整测试、构建和全部浏览器场景，结果不变。
- 独立只读审查未发现本包阻断问题。全仓 lint 本次未执行；上一包已记录 `.runtime` / `vendor` 扫描造成的基线问题，不能把定向 lint 当成全仓通过。

## 浏览器证据与限制

使用 `scripts/verify-project-save-recovery.mjs`，目标只允许受管 `127.0.0.1:3001`，阻断模型与远端请求，使用合成数据。

首轮新建项目被真实服务拒绝：最近项目已达到 100 条上限，未执行保存恢复场景。失败证据保留在 `site/.runtime/hex-project-save-recovery-2026-09-21/browser-1789956538810/`，没有删除登记、提高上限或清理历史项目。后续改为核验归属后复用上一包失败验收的合成项目，仅新增独立工作界面与测试资源，保存原清单并核对旧资源不变；这不作为新建项目成功证据。

第二轮已验证重开和未落盘重试，丢失回执核对也返回成功，但脚本等待 1024 px 下既有布局隐藏的冗余状态栏“可见”而超时。保留 `browser-1789956976769/`，不计完整通过；修正为核对可见成功说明与已附着的 saved 状态，不修改产品来迎合测试。第三轮 `browser-1789957056863/` 全通过，截图复核发现顶层成功提示缺内边距；补齐局部 CSS 后完整复跑，最终采用下面第四轮证据。

执行命令（在 `site/`）：

```text
node scripts/verify-project-save-recovery.mjs --reuse-failed-project .runtime/hex-notebook-capability-toggle-2026-09-20/browser-1789916685499/project
```

最终[机器报告](../../.runtime/hex-project-save-recovery-2026-09-21/browser-1789957302785/report.json)：4 组 / 11 图、两次真实本地 SQL 均通过。复用前备份清单；最终核对原有 3 表 / 3 原件的描述、ID、SHA-256 与 3 个旧 Notebook 定义均保持。只新增本轮独立工作界面、合成表与原件，不声称整个旧工作台状态完全不变。

| 场景 | 实际结果与截图 |
| --- | --- |
| 保存、关闭标签页、重开、再次执行 | 定义与数据保留，旧临时结果不恢复、不会自动运行；显式重跑仍为 East=150 / South=80。[重开待运行](../../.runtime/hex-project-save-recovery-2026-09-21/browser-1789957302785/02-reopened-without-run-cache-1024.png)、[真实重跑](../../.runtime/hex-project-save-recovery-2026-09-21/browser-1789957302785/03-reopened-real-sql-rerun-1024.png) |
| 保存尚未到达服务器 | 首次 POST 由明确 503 fixture 拦截，不写磁盘；点击重试使用真实 GET 和一次 POST，版本 20→21。[失败](../../.runtime/hex-project-save-recovery-2026-09-21/browser-1789957302785/04-uncommitted-save-failure-1440.png)、[恢复成功](../../.runtime/hex-project-save-recovery-2026-09-21/browser-1789957302785/05-uncommitted-retry-saved-1440.png) |
| 已落盘但成功响应丢失 | 先转发真实 POST 得到 200、版本 21→22，再将浏览器响应替换为 503；重试真实 GET 后仍为 22，没有第二次 POST。[失败](../../.runtime/hex-project-save-recovery-2026-09-21/browser-1789957302785/06-lost-response-failure-1024.png)、[确认已保存](../../.runtime/hex-project-save-recovery-2026-09-21/browser-1789957302785/07-lost-response-reconciled-1024.png) |
| 独立写入、冲突、取消和放弃重开 | 独立 API 写入方将版本 22→23；当前页面保存收到真实 409。重试只读不覆盖，取消实际 confirm 不发项目请求且本地标题保留，确认后恢复磁盘标题与版本 23。[拒绝覆盖](../../.runtime/hex-project-save-recovery-2026-09-21/browser-1789957302785/09-real-conflict-retry-refused-1440.png)、[取消后](../../.runtime/hex-project-save-recovery-2026-09-21/browser-1789957302785/10-discard-cancelled-1024.png)、[确认重开](../../.runtime/hex-project-save-recovery-2026-09-21/browser-1789957302785/11-confirmed-discard-reopened-1024.png) |

11 张最终图均由验收代理实际打开查看，主代理另看 05 / 07 / 09 / 10 / 11，包含 1440 与 1024 px，成功提示内边距、错误说明和恢复按钮没有重叠。控制台记录预期 2 次注入 503、1 次真实 409；意外控制台、页面、路由错误及禁止请求均为 0。连接目录 GET 和无句柄 recent-project GET 为显式空列表 fixture，避免读取或展示用户记录；其余本地导入、数据读取、执行、保存与核对为真实 3001。

此处重开指同一隔离浏览器上下文关闭旧标签页、打开新标签页，不是浏览器或服务进程重启。冲突使用独立 API 写入方，不是第二个真实浏览器窗口。没有测试真实断网 / 进程崩溃、浏览器查看者权限或忙碌时连点；并发重试合并由队列单测覆盖。实际模型、远端连接与手机端未验收。

## 保留范围、替换方式和剩余风险

- 项目实现未来替换时主要提供 `ProjectStateReader` / `ProjectStateWriter` 适配；必须保持身份、版本和规范化的一致性，不能只把两个方法换成任意无版本存储。旧三参数构造仍可用，但未注入 reader 的实例不具备恢复核对能力。
- 规范化抽取不增加存储中的冗余数据；没有为了重试加载全部数据行。
- 若丢失回执后表目录又单独修改名称 / 访问策略，磁盘快照与当前目录规范化可能不同，恢复会保守拒绝，而非猜测或覆盖。没有自动合并外部编辑。
- 现有通用放弃 / 重新打开流程未重写；本批 UI 仅从已经暂停的错误状态进入，重试与放弃由面板操作锁互斥。本报告不声称完成任意调用者下的全部刷新 / 在途写入竞态治理。
- 新建项目数量上限未修改；缺失文件诊断、通用未知 Cell、删除影响、看板快照完整闭环、物理卸载 Python 与 M7 仍独立推进。没有重新执行 AdventureWorks 实库或真实模型验证，不引用旧结果冒充本批通过。
- 无 API 路径、工具参数、项目格式、依赖或锁文件变更，无源码或用户文件删除，无生产系统操作。测试仅清理自身经路径校验的临时目录；浏览器证据保留。开发站热更新承载源码，稳定站未发布。
- 分支 `feature/eds-analysis-dashboard`，保持用户和此前各批未提交内容；未提交、推送、切换、合并、stash 或清理 Git。
- 受管 stable / dev / capture 检查均健康，进程、服务修订与重启次数和开工时相同；稳定版仍为 `2026-09-09T06-17-07-261Z-36adf84e`。没有启停、重启或改配服务。
