# 工作台前端模块边界

这一层拆分工作台的状态与操作；项目会话使用现有 v7 快照，沿用既有请求接口和权限规则。

工作台目前只维护桌面布局，最小宽度 1024 px。侧栏以并排列的展开 / 收起状态控制，保留助手拖动调宽；不再使用手机媒体查询、抽屉状态或遮罩。Notebook 根据自身编辑区域宽度排列配置与结果，避免侧栏展开时挤压内容。

| 模块 | 职责 |
| --- | --- |
| `assistant.ts` | 当前项目会话选择 / 新建、独立消息与草稿 / 图片状态、Harness 请求和 SSE 进度、取消、重试、当前会话清除 |
| `datasets.ts` | 文件导入、数据源选择与授权、会话内原始工作簿、现有 EDS 导入协调 |
| `pages.ts` | 工作界面选择、新增、重命名、删除 |
| `persistence.ts` | 自动保存的 React 生命周期和显式保存入口，复用当前文档和选中的 Repository |
| `persistence-controller.ts` | 无 React 的自动保存调度、取消与备份恢复查询标记，不持有第二份文档 |
| `restore-projection.ts` | 启动恢复和备份恢复共用的纯状态投影；不读写浏览器存储，也不触发数据集加载 |
| `contracts.ts` | 复用现有模型类型的协调接口，不是新的存储或网络格式 |
| `../StudioWorkspace.tsx` | 组合界面，持有文档和选中的 Repository；协调恢复、审计、ChangeSet 确认与撤销、备份和布局 |

## 调用约定

- `useStudio*State` 管理各模块的 React 状态和派生值。
- 组件通过 `useStudio*Actions` 绑定本次渲染的状态与跨模块依赖。`createStudio*Actions` 是供这些 Hook 和独立单元测试使用的控制器工厂；创建控制器不会发请求或改文档。
- 不缓存包含本次渲染状态的控制器。异步操作需要读取最新文档时，继续使用已有的 `latestDatasetWorkspaceRef`；连续导入和创建界面仍同步更新该快照。
- 通用导入和已有 EDS 流程共享一个文档及持久化入口；不要在模块内另建文档存储。
- 需要确认的修改仍生成 ChangeSet 预览，由主组件统一应用、取消和记录审计。不要在抽取模块时新增绕过权限或确认的写入路径。
- 原始 `File` 仍限当前浏览器会话，不加入持久化数据格式；敏感字段和原始数据的 AI 授权沿用原逻辑。
- `useStudioPersistence` 在恢复完成后调度可取消的微任务，自动保存失败通过异步回调显示原警告；清理、更新的显式保存或备份恢复会取消过时的自动保存。临时模式由查询记录或会话 / 草稿变化触发自动保存，项目模式跟随文档变化。
- `StudioWorkspace` 在应用一次恢复后推进恢复代次。异步 CSV 回填及其状态更新只允许写入发起它的那一代；备份恢复覆盖旧代，过期回执不能把旧数据源加回新工作区。
- `persistExplicitly` 增加末尾可选会话列表参数，同步返回和错误提示语义不变。项目 Repository 接受快照不等于磁盘写入成功；异步保存状态及切换前 `flush` 仍由 `LocalProjectsProvider` 管理。
- `core/harness/assistant-sessions.ts` 是会话数据契约和恢复逻辑，v7 工作区快照随当前项目保存全部会话。聊天 Hook 只从活动会话派生消息和文字草稿；切换时恢复当前会话任务，禁止借用项目全局最后任务。会话图片保留于内存，导出不包含文件字节。旧快照迁移保留历史，备份恢复轮换服务端上下文，刷新后的取消任务归回所属会话。
- `core/projects/state-repository.ts` 通过 `ProjectStateWriter` 隔离保存传输，负责 400 ms 合并、串行修订、冲突冻结。HTTP 及当前标签页选择留在 `core/projects/client.ts`，不得从队列或保存调度反向导入该客户端。

## 回归检查

在 `site/` 执行：

```text
npm test -- components/studio/workspace
npx eslint components/studio/workspace components/studio/StudioWorkspace.tsx
npm test
npm run build
node scripts/verify-harness-stream-ui.mjs
node scripts/studio-persistence-browser-acceptance.mjs
node scripts/local-project-browser-acceptance.mjs
```

表格与界面操作的浏览器检查必须显式指向开发站（PowerShell）：

```powershell
$env:SPREADSHEET_WORKSPACE_BASE_URL = 'http://127.0.0.1:3001'
node scripts/verify-spreadsheet-workspace.mjs
```

浏览器检查使用隔离会话及合成数据；聊天检查使用模拟 SSE，不调用模型。视觉证据分别写入 `.runtime/harness-stream-ui/` 和 `evidence/spreadsheet-workspace/`。运行与发布仍遵循 `STABLE-RUNTIME.md`，不自动发布到 3000。
