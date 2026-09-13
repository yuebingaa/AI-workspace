# 工作台前端模块边界

这一层拆分工作台的状态与操作，不改变请求协议、持久化格式或权限规则。

| 模块 | 职责 |
| --- | --- |
| `assistant.ts` | 聊天与图片状态、Harness 请求和 SSE 进度、取消、重试、清除会话 |
| `datasets.ts` | 文件导入、数据源选择与授权、会话内原始工作簿、现有 EDS 导入协调 |
| `pages.ts` | 工作界面选择、新增、重命名、删除 |
| `contracts.ts` | 复用现有模型类型的协调接口，不是新的存储或网络格式 |
| `../StudioWorkspace.tsx` | 组合界面，协调文档、审计、持久化、ChangeSet 确认与撤销、备份和布局 |

## 调用约定

- `useStudio*State` 管理各模块的 React 状态和派生值。
- 组件通过 `useStudio*Actions` 绑定本次渲染的状态与跨模块依赖。`createStudio*Actions` 是供这些 Hook 和独立单元测试使用的控制器工厂；创建控制器不会发请求或改文档。
- 不缓存包含本次渲染状态的控制器。异步操作需要读取最新文档时，继续使用已有的 `latestDatasetWorkspaceRef`；连续导入和创建界面仍同步更新该快照。
- 通用导入和已有 EDS 流程共享一个文档及持久化入口；不要在模块内另建文档存储。
- 需要确认的修改仍生成 ChangeSet 预览，由主组件统一应用、取消和记录审计。不要在抽取模块时新增绕过权限或确认的写入路径。
- 原始 `File` 仍限当前浏览器会话，不加入持久化数据格式；敏感字段和原始数据的 AI 授权沿用原逻辑。

## 回归检查

在 `site/` 执行：

```text
npm test -- components/studio/workspace
npx eslint components/studio/workspace components/studio/StudioWorkspace.tsx
npm test
npm run build
node scripts/verify-harness-stream-ui.mjs
```

表格与界面操作的浏览器检查必须显式指向开发站（PowerShell）：

```powershell
$env:SPREADSHEET_WORKSPACE_BASE_URL = 'http://127.0.0.1:3001'
node scripts/verify-spreadsheet-workspace.mjs
```

浏览器检查使用隔离会话及合成数据；聊天检查使用模拟 SSE，不调用模型。视觉证据分别写入 `.runtime/harness-stream-ui/` 和 `evidence/spreadsheet-workspace/`。运行与发布仍遵循 `STABLE-RUNTIME.md`，不自动发布到 3000。
