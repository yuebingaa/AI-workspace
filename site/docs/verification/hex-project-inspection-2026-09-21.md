# M6 第十包：独立只读项目步骤检查

日期：2026-09-21。状态：源码及 3001 限定范围验收完成，未发布 3000。

## 冻结范围

为 Data Browser 增加独立只读查看入口，读取当前格式的项目及 Notebook 基础元数据；当前版本未知的 Cell 仅显示安全身份信息，已知 SQL / Python / 文本源码有界展示。它不是可编辑项目打开，也不是部分 Notebook 执行。

- 不安装到 Studio，不调用项目登记、保存队列、Agent 或执行器，不返回项目句柄。
- 当前执行 Schema、正常打开 / 保存的未知 Cell 拒绝行为不变。
- 坏 JSON、较新格式 / 版本、非法已知 Cell 及非法外围数据继续拒绝。
- 原始未知配置、数据行、历史聊天与运行结果不进入只读 DTO；原始文件字节不改变。
- 仅在 3001 使用合成数据验收，保留成功 / 失败 / 返回或取消截图。没有真实模型、外部数据库调用或站点发布。

## 工作记录

- 已核对项目保存、严格 Notebook 定义、兼容性检测、Data Browser 与客户端 transport；确认不能把移除未知单元后的项目安装到 Studio，否则后续保存会丢失原内容。
- 按职责划分独立 DTO、服务端校验投影、现有安全文件读取适配、只读 API、客户端请求和纯显示组件。
- 前端独立审查发现重读按钮卸载可能丢失键盘焦点，已在进入 loading 前将焦点移到返回按钮，浏览器实际确认。首次截图发现长源码占满内容视口，已限制代码区为 320 px 局部滚动并完整复跑。

## 实际目录与主要变更

```text
site/
  core/projects/
    inspection.ts                    # 独立显示 DTO / Schema / 限量
    inspection-client.ts             # 不携带项目句柄的只读请求
    inspection-client.test.ts
    server/
      inspection.ts                  # 严格验证 + 有界投影
      inspection.test.ts
      inspection-store.test.ts
      store.ts                       # 新增 inspect()；原读写入口保留
  app/api/projects/inspect/
    route.ts                         # 同源 POST {path}，不登记、不保存
    route.test.ts
  components/studio/projects/
    ProjectInspectionPanel.tsx       # 请求生命周期 + 纯展示子组件
    ProjectInspectionPanel.test.tsx
    DataBrowser.tsx                  # 新入口、返回、焦点与弹窗接线
  app/data-browser.css               # 暖灰占位、只读源码局部滚动
  scripts/verify-project-inspection.mjs
```

另修改 `core/architecture/module-boundaries.test.ts` 增加只读依赖边界守卫；同步架构、里程碑与视觉规范。本批没有搬移或删除源码、升级依赖、改锁文件或新增第二份项目存储。

## 模块与兼容边界

- `ProjectInspection` 仅用于显示。浏览器严格校验响应，未知类型不能携带源码；没有 `handle`、可执行文档或持久化状态。UI 不依赖项目安装、保存队列或执行器。
- `inspectProjectManifest(unknown)` 在内部临时副本替换未知单元为验证哨兵，原始 Notebook 数量 / 30 单元 / 80 KB 限制在替换前检查；完整项目 Schema 继续验证已知单元、外围和历史 Artifact。原对象不变，副本不导出，不成为执行或保存对象。只允许当前工作台版本中的陌生 kind；较早版本正常项目仍沿既有只读解析，不写迁移。
- `LocalProjectStore.inspect()` 使用原安全快照适配器的有界读取、普通文件与身份检查；检查前后核对项目目录。新 API 同源 / 本机、JSON 严格请求和 8 KiB 请求上限，响应不超过 512 KiB、无缓存。原 open / save 的拒绝与原子保存语义不变。
- 已知 SQL / Python / 文本最多每单元 2,000、共 20,000 字符；截断 / 省略明确提示。读取 manifest 会解析原 JSON，但未知配置不进入 DTO、不展示、不执行。这里只检查定义，不读取和校验实际数据文件，不验证 SQL / Python、DAG 或业务计算正确性。
- Harness / Agent / Tool / Model、Dataset、SQL 执行、Dashboard 与 ChangeSet 本批未改：仍使用各自既有端口、授权、预览确认及存储。本批不会增强模型推理或生成质量，也不会通过只读入口绕过数据授权进行分析。

## 验证结果

所有 npm / npx 命令在 `site/` 执行。

| 实际检查 | 结果 |
| --- | --- |
| 修改前 `npm test -- --maxWorkers=2` | 2,447 应用 + 26 Node 通过；原 1 文件 / 3 项跳过保留；日志 `.runtime/m6-inspection-baseline.log` |
| 服务端 `npx vitest run core/projects/server/inspection.test.ts core/projects/server/inspection-store.test.ts app/api/projects/inspect/route.test.ts core/projects/server/store.test.ts core/projects/server/compatibility.test.ts app/api/projects/route.test.ts app/api/projects/compatibility.test.ts --maxWorkers=2` | 7 文件 / 73 项通过，其中本批新增 29 项；原件 / 清单不变、无登记、拒绝已知坏定义 / 历史产物 / 未来版本 / 超限等 |
| 客户端、SSR、既有兼容 UI 和架构守卫定向 Vitest | 4 文件 / 52 项通过，含 32 项架构边界；日志 `.runtime/m6-inspection-client.log` |
| 最终 `npm test -- --maxWorkers=2` | 235 应用文件 / 2,495 项 + 26 Node 通过；新增 48 项；原 3 项跳过未增加；离线 Harness 11/11；日志 `.runtime/m6-inspection-tests.log` |
| `npm run typecheck` | 退出 0，日志 `.runtime/m6-inspection-typecheck.log` |
| 本批 13 个 TS / TSX 与 1 个 MJS 严格 `eslint --max-warnings=0` | 退出 0，日志 `.runtime/m6-inspection-lint.log` |
| `npm run build` | 默认完整构建通过；长源码 CSS 收敛后另有最终构建日志 `.runtime/m6-inspection-build-final.log`；不发布 |
| `npm run docs:agent:sync` / `docs:agent:check` / `docs:agent:test` | 167 文件指纹一致，检查器测试 1 项通过；正文与变更记录同步 |
| 局部 `git diff --check` / 脚本语法 | 通过；Windows 行尾转换提示不是测试失败 |

没有删除、跳过或弱化失败测试。功能自动化首轮没有失败；两处 UI 可访问性 / 布局改进已完成，浏览器最终证据以下述轮次为准。全量未运行真实模型；既有跳过测试不记为通过。

## 本次 3001 截图与交互

命令 `node scripts/verify-project-inspection.mjs`。最终 [report.json](../../.runtime/hex-project-inspection-2026-09-21/browser-1789981626151/report.json)：8 组 / 11 张图，1440 与 1024 桌面。

| 场景 | 本次实际截图 |
| --- | --- |
| 当前版本未知单元安全占位 | [01 只读项目](../../.runtime/hex-project-inspection-2026-09-21/browser-1789981626151/01-unknown-read-only-1440.png) |
| 已知 SQL 纯文本；长源码截断及局部滚动 | [02 SQL](../../.runtime/hex-project-inspection-2026-09-21/browser-1789981626151/02-known-sql-source-1440.png)、[03 长源码](../../.runtime/hex-project-inspection-2026-09-21/browser-1789981626151/03-bounded-long-source-1024.png) |
| 返回后项目仍未打开；正常项目也可只读查看 | [04 返回](../../.runtime/hex-project-inspection-2026-09-21/browser-1789981626151/04-return-to-project-list-1024.png)、[05 正常项目](../../.runtime/hex-project-inspection-2026-09-21/browser-1789981626151/05-known-project-read-only-1440.png) |
| 非法已知定义、未来版本、坏 JSON 真实拒绝 | [06 非法单元](../../.runtime/hex-project-inspection-2026-09-21/browser-1789981626151/06-invalid-known-rejected-1024.png)、[07 未来版本](../../.runtime/hex-project-inspection-2026-09-21/browser-1789981626151/07-future-version-rejected-1024.png)、[08 坏 JSON](../../.runtime/hex-project-inspection-2026-09-21/browser-1789981626151/08-invalid-json-rejected-1440.png) |
| 重读加载保持焦点；返回中止，晚到结果不覆盖 | [09 加载](../../.runtime/hex-project-inspection-2026-09-21/browser-1789981626151/09-reread-loading-retains-focus-1440.png)、[10 取消](../../.runtime/hex-project-inspection-2026-09-21/browser-1789981626151/10-cancelled-inspection-keeps-list-1024.png) |
| 关闭后刷新，不自动查看 / 打开 / 运行 | [11 刷新](../../.runtime/hex-project-inspection-2026-09-21/browser-1789981626151/11-reloaded-temporary-workspace-1024.png) |

全部 `/inspect` 使用真实 3001；取消组只延迟真实响应交付，不伪造成功数据。8 次浏览器请求 / 7 个响应，1 次预期取消；三个实际失败分别为 409 / 409 / 500，对应三条预期 HTTP console error，非预期 console / page / route / 违规请求为零。连接目录、最近项目列表和字体使用隔离替身，避免展示本机其他数据；没有数据查询或模型调用。

本轮新建五个**未登记**合成项目，所有清单、目录及项目登记文件前后字节 / SHA 保持；只读请求不创建句柄、不修改项目 index，证据项目保留。三轮截图目录均保留；前两轮功能断言已通过，最终轮补齐长源码视口与截图锚点优化，不冒充只跑一次。逐图复核完成状态见最终报告，主代理另复核 01 / 03 / 09 / 10。

## 保留事项、后续替换与工作区

- 不支持未知项目可编辑打开、部分执行、未知历史 Agent Artifact、任意未来版本或自动修复 / 强制覆盖；它们仍拒绝。元数据总量达响应上限也明确拒绝，不静默删单元。
- 本次没有重新验收实库到图表、Python 执行、实际损坏数据文件、已打开且有未保存编辑的项目 UI、新电脑或进程重启；相关既有离线测试通过不代替这些新截图。没有稳定站发布。
- 后续调整只读投影在 `server/inspection.ts`，调整展示在 `ProjectInspectionPanel.tsx`；两者通过显示 DTO 协作。若要实现未知单元可编辑兼容，需要另设计存储文档与可执行文档的双边界及无损保存，不能把本次验证副本安装到 Studio。模型 / 数据库替换仍用既有 HarnessModel / 查询驱动端口，本批未重建它们。
- 当前分支 `feature/eds-analysis-dashboard`。原有大量未提交 / 未跟踪修改保留，本轮源码和测试亦未提交；未 push、合并、切分支、清理历史或删除用户文件。新文件需与消费者一起纳入未来提交；运行证据和任务日志依既有忽略策略本地保留，没有改忽略规则。
- 日志收尾首次历史前缀校验不符：另一会话已追加说明条目，本批按较早定位插在其前，并改变一个空行 CRLF。只读审查在内存精确恢复原 404,724 字节及原 SHA 后，才机械重排本轮自有区段到文件末尾；再次校验原前缀完全一致。他人条目没有删除或覆盖，重排前副本保留于本次忽略证据目录；不是靠猜测统一换行或重写历史通过检查。
- 3000 / 3001 / 3198 前后健康，服务 PID、worker、revision、启动时间、重启数及稳定 release 均与开始一致。仅开发站源码热更新；没有启停、重启或发布操作。
