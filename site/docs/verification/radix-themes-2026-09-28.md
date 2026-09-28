# Radix Themes 基础控件替换与交互验收

日期：2026-09-28。状态：源码 / 3001 已启用；未发布 3000。

用户确认 Radix Themes 风格并要求替换组件，后续补充要求交互、动态与流畅自然。当前采用固定版本 3.3.0，浅色、mauve 中性色与克制的 violet 强调色。保留原领域逻辑、数据格式和成熟专业组件。

本批基线位于 `.runtime/radix-themes-20260928/source-before`；开始时源码已有其他任务修改，所有对比以本批快照为准。改造前 3001 的实际截图位于 `.runtime/notebook-document-20260927/before-1790558962287`，其中结果页已实际查看。名称中的旧日期来自复用验收脚本，本批文件为本次实际运行新生成，不引用历史验收代替当前结果。

## 已实现

- `components/ui/studio-theme.tsx` 与 `app/layout.tsx` 统一 Theme；`button.tsx`、`fields.tsx`、`dialog.tsx`、`search-select.tsx` 使用 Themes 成品组件。删除旧 `app/ui-controls.css`，移除三个已无直接引用的 Radix primitive 依赖，保留 Themes 所需的传递依赖。
- 多处站内按钮、输入、下拉和复选框通过薄适配层迁移；选项使用字符串回调、复选使用布尔回调，不制造原生事件。Select 对空字符串及任意字段名统一编码；权限、编辑锁、参数校验和提交仍由原模块负责。
- 顶部模式采用 Tabs，工作界面采用 DropdownMenu；工作区和 Notebook 菜单 / 列设置使用 Popover。数据浏览器、导入、API 配置、语义模型与文件删除确认采用 Dialog / AlertDialog；不重写专业编辑器、表格引擎、绘图、看板编辑器和官方 DSH iframe。
- 原 `globals.css` 正文移到 `studio-base.css`；全站原布局样式在 `studio-legacy` 层加载。`theme-controls.css` 只维护主题变量、必要布局和短动效，避免旧的全局 button / input 外观盖过 Themes。
- 悬停 / 焦点反馈 140 ms、按压 1 px、编辑区进入 180 ms；官方弹层进出动画实测 160 ms。系统减少动态效果时关闭动画，按钮和状态仍可用。加载保留 `aria-busy`、可访问名称及官方 Spinner。
- 实际验收修正：ghost 默认负外边距造成点击区域重叠；折叠侧栏按钮意外占位使页面顶部偏移；图表类型按钮文字换行；导航与侧栏对齐；长会话标题挤占旁边操作；Portal 文件删除确认未居中；原生 autofocus 输入覆盖弹窗返回焦点。

## 验证结果

| 检查 | 本次结果 |
| --- | --- |
| 全量离线测试 `npm test -- --exclude '.runtime/**' --maxWorkers=2 --reporter=dot` | 284 个文件通过，1 个跳过；3,616 项通过，3 项按现有条件跳过；随后 26 项 Node 脚本测试通过。排除的是本地历史快照目录。 |
| 最终组件测试 `vitest run components` | 60 个文件 / 732 项通过。原静态 HTML 测试适配 Themes provider、Portal 和真实 checkbox 语义，保留权限、禁用、取消及确认检查。 |
| `npm run typecheck` / `npm run build` | 通过。构建生成独立生产产物；没有将其发布到稳定站。 |
| 源码 ESLint | `app components core test-support` 及本批验收脚本通过，无警告。 |
| 全仓 ESLint | 未通过：原 `scripts/notebook-query-worker.cjs` 的 3 个 require 规则错误、`vendor/python/pyodide.asm.mjs` 的 5 个规则错误，另有 vendored 文件警告；未修改这些无关文件。最初未排除 `.runtime` 的 lint 扫到历史打包产物，已中断，仅记录有明确范围的检查。 |
| 架构文档 | 同步正文 / 变更记录并运行 `docs:agent:sync`、`docs:agent:check`，247 个源码指纹一致。 |
| 3001 Notebook 文档 | 十单元真实执行；源码 / 图表 / 数据切换、大纲、菜单、删除取消、SQL 失败 / 恢复、挂起请求取消、1024、粘性栏和保存重开通过。 |
| 3001 Notebook 编辑工作台 | CodeMirror、TanStack 搜索 / 列 / 导出、图表字段及预览、校验 / 取消、真实 SQL、保存 Dataset、合成 Agent 回执驱动的真实预览 / 确认 / 撤销通过。 |
| 3001 语义模型 | 缺少必填、重复标识、键盘搜索选择、真实分组 150 / 80、嵌套来源确认 / 取消、保存 / 重开、1024 通过。 |
| 3001 Themes 交互 | 菜单、按压、下拉 / 弹窗焦点、模拟设置成功 / 挂起 / 失败 / 取消、真实合成 CSV 导入、嵌套文件删除取消、减少动态效果及键盘 Tabs 通过。 |

完整日志在 `.runtime/radix-themes-20260928/`：`tests-source.log`、`components-final.log`、`typecheck-final.log`、`lint-delivery.log`、`build-final.log`。初次回归暴露的 provider / Portal / 属性顺序测试问题、aria-busy 覆盖和焦点问题均修复后重新验证；早期失败截图和中断的检查不计作通过结果。

## 实际截图与查看

以下链接均为本次在 **3001、全新浏览器存储、隔离项目、合成数据** 下截取并实际查看的图。没有查看的其他自动截图不标记为人工通过；没有以 DOM 断言代替截图检查。脚本保留了 `report.json` 的场景、尺寸和逐图 `visuallyReviewed` 标记。

| 页面 / 场景 | 本次实际截图 | 结论 |
| --- | --- | --- |
| Notebook 文档正常执行 | [结果](../../.runtime/notebook-document-20260927/after-1790560870936/02-default-results.png) | 10 / 10 成功；新控件、结果和来源清晰。 |
| Notebook 失败 / 取消 | [SQL 报错](../../.runtime/notebook-document-20260927/after-1790560870936/06-query-failed.png)、[取消](../../.runtime/notebook-document-20260927/after-1790560870936/08-cancelled.png) | 错误 / 取消保留真实结果状态。 |
| Notebook 窄桌面 / 滚动 | [1024](../../.runtime/notebook-document-20260927/after-1790560870936/09-default-1024.png)、[固定工具栏](../../.runtime/notebook-document-20260927/after-1790560870936/10-sticky-toolbar.png) | 页面顶部未被侧栏挤出，运行入口保持可见。 |
| 语义模型失败 | [必填错误](../../.runtime/semantic-form-ui-20260927/browser-1790560870810/02-required-error-1440.png) | 错误定位到字段，首个错误获焦。 |
| 语义模型成功 / 取消 | [真实预览](../../.runtime/semantic-form-ui-20260927/browser-1790560870810/05-preview-success-1440.png)、[取消换表](../../.runtime/semantic-form-ui-20260927/browser-1790560870810/07-source-cancelled-1440.png) | 150 / 80 数值正确，取消保留草稿来源与成员。 |
| 语义模型窄桌面 | [1024 预览](../../.runtime/semantic-form-ui-20260927/browser-1790560870810/09-preview-1024.png) | 表单可滚动、底部按钮完整，模型条目对齐。 |
| 菜单与 API 设置 | [菜单](../../.runtime/radix-themes-20260928/browser-1790560998101/01-menu.png)、[弹窗内下拉](../../.runtime/radix-themes-20260928/browser-1790560998101/03-select-in-dialog.png)、[成功](../../.runtime/radix-themes-20260928/browser-1790560998101/04-settings-success.png) | 无双重输入边框；下拉正常位于弹窗之上。设置回执为显式测试夹具，没有修改实际配置。 |
| API 忙碌 / 失败 | [加载](../../.runtime/radix-themes-20260928/browser-1790560998101/05-settings-loading.png)、[失败](../../.runtime/radix-themes-20260928/browser-1790560998101/06-settings-failure.png) | 显示 Spinner、禁止重复提交，失败后可修正 / 取消；使用虚构密钥。 |
| 文件删除确认 / 取消 | [居中确认](../../.runtime/radix-themes-20260928/browser-1790561125503/07-delete-confirmation.png)、[取消后保留文件](../../.runtime/radix-themes-20260928/browser-1790561125503/08-delete-cancelled.png) | 对话框居中，默认焦点在取消，Escape 只关闭内层并回到删除入口。 |
| 减少动态效果 / 键盘 Tabs | [1024 菜单](../../.runtime/radix-themes-20260928/browser-1790561125503/09-reduced-motion-1024.png)、[键盘切换](../../.runtime/radix-themes-20260928/browser-1790561125503/10-notebook-1024.png) | 菜单位于视口内；键盘焦点清晰。动画关闭由同次真实浏览器计算样式验证。 |

Notebook 编辑工作台最终运行：[完整机器报告](../../.runtime/notebook-workbench-20260927/browser-1790561231780/report.json)。以下 7 图已实际查看：

- [SQL 编辑器](../../.runtime/notebook-workbench-20260927/browser-1790561231780/01-sql-editor-1680.png)：Themes 输入与复选、CodeMirror、保存 / 取消可见。
- [图表配置成功](../../.runtime/notebook-workbench-20260927/browser-1790561231780/04-chart-builder-1680.png)、[缺少字段](../../.runtime/notebook-workbench-20260927/browser-1790561231780/05-chart-required-error.png)、[1024 图表](../../.runtime/notebook-workbench-20260927/browser-1790561231780/06-chart-builder-1024.png)：按钮文字无竖向换行，字段、预览和错误完整。
- [取消运行](../../.runtime/notebook-workbench-20260927/browser-1790561231780/08-run-cancelled.png)：取消未被显示为成功。
- [待确认](../../.runtime/notebook-workbench-20260927/browser-1790561231780/10-agent-pending-confirmation.png)、[撤销预览](../../.runtime/notebook-workbench-20260927/browser-1790561231780/11-agent-preview-undone.png)：明确合成 Agent 回执，正式步骤需确认；长会话名称截断后不再覆盖右侧数据 / 展开按钮。自动截图也检查标题不会越出自身容器。

上述表格与列表共链接 25 张已查看的实际截图。其余自动截图保留在报告目录中，不把未查看图片计入人工验收。图表类型换行、长标题覆盖、删除弹窗靠左等早期失败图仅作为本次修复依据。

## 边界与运行状态

基础控件迁移已生效，不等于 Hex 功能或执行机制复刻。原生文件选择、个别专用开关 / 列宽拖动、业务表单布局，以及 CodeMirror / TanStack / Recharts / Puck / DSH 内部控件保留；没有引入 marimo 或新增动效库。本批不做手机适配、真实付费模型、外部仓库 / 企业微信联调或发布验收。

稳定站仍是原独立构建。开始及收尾执行 `site:status`，3000 / 3001 / 3198 均健康；稳定站和截图服务的 PID 与重启计数未变。开发站管理器期间记录了 1 次重启，本任务没有调用 `site:start/restart/stop/publish`，不将其原因推断为本次代码或某个测试。没有打开、导出或修改用户项目，所有验收项目留在各自 `.runtime` 子目录。
