# 网站视觉设计规范

最后更新：2026-09-13。用户确认方向：简洁精致、浅色、留白；配色参照用户提供的 APIMART 截图，以黑白灰与略暖的纸张底色为主。

每次任务的修改内容统一追加到根目录 [TASK-LOG.md](../../TASK-LOG.md)。本文维护当前视觉规范和本轮验收入口，不替代任务历史或 Agent 架构文档。

## 配色与布局

| 用途 | 颜色 / 约定 |
| --- | --- |
| 页面底色 | `#F7F6F3`，略暖的浅灰 |
| 内容表面 | `#FDFCFB`，接近白色 |
| 次级表面 | `#EFEDE9`，浅灰层次 |
| 主文字 / 主按钮 | `#20201E`，炭黑；主按钮白字 |
| 次级文字 | `#65625E` |
| 辅助文字 | `#767574` |
| 普通边框 | `#D7D6D5` |
| 强调边框 | `#B4B3B2` |
| 圆角 | 按钮与菜单以 3–5 px 为主，弹窗以 6–8 px 为主 |
| 间距 | 导航紧凑，内容区域留白；通过细边框和对齐建立层次 |
| 装饰 | 原生 SVG 灰度线条插画；AI 欢迎页有低对比点阵纹理 |
| 字体 | 系统无衬线字体，中文优先 Noto Sans SC / 苹方 / 微软雅黑回退；不新增远程字体依赖 |

全站配色入口为 [`app/studio-theme.css`](../app/studio-theme.css)，由 `app/layout.tsx` 在功能样式后载入。功能 CSS 直接引用 `--studio-*` 变量，不能只依赖首页的覆盖规则。新增界面、CSS Module、挂在 body 下的弹窗及编辑器浮层都须接入同一色板；避免重新引入成片绿色、紫色、彩色渐变或过重阴影。Puck 使用官方 root 主题变量，预览 iframe 同步宿主样式；数据图表的显式系列颜色保持独立。

成功、警告、错误仍可使用有语义的状态色，并同时保留文字说明。不能用全局灰度滤镜处理网站，以免改变用户上传图片、图表中的业务颜色或状态辨识。

## 当前页面规则

- 顶部：品牌与工作界面切换在左侧，任务历史、备份、更多和发布在右侧；角色演示与撤销保留在“更多”菜单中。展示真实保存状态。
- 模式导航：AI 工作台、Notebook、看板使用独立线条图标，当前模式黑底白字；保留方向键、Home / End 切换。
- AI 工作台：灰度插画、清晰标题、三个带说明的建议入口。建议仍只填入草稿。输入框与上下文菜单保持共享，不因模式切换而重建。
- 看板：空白态以左侧说明和右侧插画组成，导入按钮清晰可见。只让空白桌面画布自适应可用宽度，已有数据看板继续使用原来的画布尺寸与滚动方式。
- Notebook、Data Browser、导入、历史、API 设置、企业微信弹窗：统一表面、边框、按钮和字体；有数据的表格、编辑表单、选中态、结果预览与空白态使用同一色板。保留状态含义与原有功能。
- 语义模型：编辑、维度 / 指标、计算预览、保存与侧栏选中态统一黑白灰。原生 dialog 使用公共字体，底部操作区固定可见，手机表单单列排列。
- 数据源与 EDS：详情标签、字段类型、数据配方、原始工作簿、导入与结果卡片统一表面与边框；详情和帮助文字优先 11–12 px，手机说明自然换行。
- 看板编辑与历史：编辑器组件库、属性面板、选中框及变更预览使用灰度强调；定位文案为“边框标记区域”。历史详情字号提高，手机长记录分行，避免把预览强调色误当成成功状态。
- 可视化测试页：独立路由 `/visualization-lab` 的导航、选题、指令、预览标签和历史也使用同一色板；运行结果和人工评定保持明确的状态说明。
- 手机：隐藏重复的模式上下文文字；保留所有工作入口和共享输入框。低高度屏幕收起装饰插画，避免建议入口被输入区遮挡。
- 动效：悬停反馈简短克制；尊重 `prefers-reduced-motion`。
- 可视化测试页 `/visualization-lab`：复用 `--studio-*` 色板，桌面左侧选题与指令、右侧预览与检查，手机堆叠显示；单图预览填满可用区域。图表系列保留模型生成的颜色，自动规则与人工评定分别展示，不以绿色状态代表视觉质量通过。

## 2026-09-13 首轮实现与验收

本轮包括主题、品牌图形与 favicon、工作台欢迎区、空白看板、导航、常用菜单与弹窗。界面提示中的部分实现术语改成“先预览，确认后应用”等用户可理解的措辞。模型请求、数据授权、预算、预览确认、Notebook 执行和持久化没有调整。

源码已实现，开发站 `http://127.0.0.1:3001` 已载入。稳定站 `http://127.0.0.1:3000` 尚未发布；这份规范不代表稳定站或便携包已经更新。

验收结果：

- 现有组件测试 6 个文件、18 项全部通过，覆盖顶部操作、侧栏、AI 助手、组件渲染、面板尺寸与导入对话框。
- `npm run typecheck`、本轮 TSX 文件的 ESLint、架构文档同步与检查、`npm run build` 通过。已确认生成的生产 CSS 包含主题变量。构建仍提示部分客户端 chunk 大于 500 kB。
- 隔离 Edge 验证 1440×960、1280×720、820×900、390×844、360×740、375×667：无整页横向溢出，建议入口完整可见，输入框无遮挡，上下文子菜单不越出屏幕。已人工查看主页面、Notebook、资源库、导入/API 弹窗和窄屏截图。
- 建议只填入草稿；附件与草稿跨三种模式保留；方向键、Home / End 导航正常；导入、设置、备份、更多和手机侧栏入口正常；刷新保留模式。浏览器异常为 0，模型请求为 0，没有执行真实数据导入或修改密钥。
- 验收中修正了低高度屏幕的建议卡片遮挡；恢复公共布局中被移除的主题引用，并为顶部 SVG 添加固有尺寸。最后重新完成浏览器检查与包含主题的生产构建。

本机证据与对比：

| 内容 | 链接 |
| --- | --- |
| 用户配色参考 | [参考截图](../.runtime/visual-refresh/reference.png) |
| AI 工作台 | [修改前](../.runtime/visual-refresh/before-agent.png) / [修改后](../.runtime/visual-refresh/after-agent.png) |
| 空白看板 | [修改前](../.runtime/visual-refresh/before-home.png) / [修改后](../.runtime/visual-refresh/after-canvas.png) |
| Notebook | [新版截图](../.runtime/visual-refresh/after-notebook.png) |
| 手机 | [新版截图](../.runtime/visual-refresh/after-mobile.png) / [上下文菜单](../.runtime/visual-refresh/after-mobile-submenu.png) |
| 浏览器检查 | [页面报告](../.runtime/visual-refresh/review.json) / [交互报告](../.runtime/visual-refresh/interactions.json) |

截图与检查脚本保存在 `site/.runtime/visual-refresh/`，属于本机验收证据，不自动进入 Git，也不能替代版本历史。没有将其他任务的可视化试验页、模型评测或历史测试结果归入本轮完成范围。

## 2026-09-13 二轮遗漏复核

用户反馈部分页面未按要求修改。重新使用有数据的工作区检查后，确认首轮空白页验收不足：语义模型原生弹窗、数据源内页、Notebook 编辑状态、EDS 和历史详情仍存在写死的旧绿色 / 紫色，编辑器还有单独的配色变量。本轮直接修正各功能样式来源，并补齐预览选中框、细边框、圆角及较小的详情字号。Data Browser 主按钮悬停改成炭灰白字，实测文字对比度约 12.08:1。

本轮修改 `app/globals.css`、`studio-theme.css`、`semantic-models.css`、`data-browser.css`、`notebook.css`、`agent-workspace.css`、`agent-chat-typography.css`、`composer-context-menu.css`、`harness-trace.css`、`components/studio/wecom-settings.css`，以及 `DataProductCanvas.tsx` 的预览定位说明。可视化测试页在本轮复核时自身已接入公共色板，本轮验收其空白 / 结果 / 数据 / 配置 / 历史 / 窄屏状态，没有改写其业务实现。

| 复核范围 | 实际结果与本机证据 |
| --- | --- |
| EDS 导入与 CSV 文件选中 | [EDS 桌面](../.runtime/visual-audit-2026-09-13/after/eds-import.png)、[EDS 手机](../.runtime/visual-audit-2026-09-13/after/eds-import-mobile.png)、[CSV](../.runtime/visual-audit-2026-09-13/after/csv-selected.png)；手机帮助文字已提高字号 |
| 数据源五个标签 | [概览](../.runtime/visual-audit-2026-09-13/after/source-概览.png)、[字段](../.runtime/visual-audit-2026-09-13/after/source-字段.png)、[配方](../.runtime/visual-audit-2026-09-13/after/source-数据配方.png)；同时检查数据预览和执行记录 |
| 语义模型编辑、预览与选择 | [修改前](../.runtime/visual-audit-2026-09-13/before/semantic-editor.png)、[修改后](../.runtime/visual-audit-2026-09-13/after/semantic-editor.png)、[手机](../.runtime/visual-audit-2026-09-13/after/semantic-editor-mobile.png)；真实合成 CSV 求和得到 150 / 80，保存选中正常 |
| Notebook 数据与 SQL 编辑、结果、图表 | [SQL 编辑](../.runtime/visual-audit-2026-09-13/after/notebook-sql-editor.png)、[查询结果](../.runtime/visual-audit-2026-09-13/after/notebook-query-results.png)、[图表手机](../.runtime/visual-audit-2026-09-13/after/notebook-chart-mobile.png)；本机 SQL 运算通过，图表保留数据系列颜色 |
| 看板预览与编辑器 | [变更预览](../.runtime/visual-audit-2026-09-13/after/dashboard-preview.png)、[组件选中](../.runtime/visual-audit-2026-09-13/after/canvas-editor-selection.png)；确认后进入编辑，组件库、属性面板与预览框不再使用旧紫色 |
| 任务与变更历史、发布准备说明 | [历史桌面](../.runtime/visual-audit-2026-09-13/after/history-changesets.png)、[历史手机](../.runtime/visual-audit-2026-09-13/after/history-changesets-mobile.png)、[发布准备](../.runtime/visual-audit-2026-09-13/after/publish-readiness.png)；没有执行发布 |
| Data Browser 本地项目 | [资源详情](../.runtime/local-project-browser-2026-09-13T14-44-02-567Z/data-browser-desktop.png)、[手机](../.runtime/local-project-browser-2026-09-13T14-44-02-567Z/data-browser-mobile.png)；10 项既有检查通过，覆盖 CSV / XLSX 原件、重命名、回收站、模型、查询、刷新及退出 |
| 聊天与企业微信弹窗 | [执行记录](../.runtime/visual-audit-2026-09-13/stream/desktop-completed-expanded.png)、[企业微信手机](../.runtime/visual-audit-2026-09-13/wecom/wecom-disconnected-mobile.png)；合成事件验证成功 / 失败 / 取消及模拟授权状态，没有真实连接账号 |
| 可视化测试独立页面 | [空白页面](../evidence/visualization-lab-2026-09-13T14-44-02-479Z/01-empty.png)、[结果](../evidence/visualization-lab-2026-09-13T14-44-02-479Z/02-chart.png)、[手机](../evidence/visualization-lab-2026-09-13T14-44-02-479Z/03-mobile.png)；8 项合成 SSE 回放检查通过，非真实模型评测 |

验证：11 个现有组件测试文件、50 项测试通过；类型检查、修改 TSX 的 ESLint、架构正文更新和指纹检查、生产构建通过。主流程完成 30 个桌面 / 手机状态，检查实际计算样式中的彩色元素，剩余为明确的成功、错误、删除及保留期提示；另外重新验证 1440×960、1280×720、820×900、390×844、360×740、375×667 六种尺寸的导航、共享输入、上下文菜单和侧栏。浏览器异常为 0，没有付费模型调用。主流程创建的临时 Dataset 均已按 ID 删除；本地项目专项脚本按原规则保留自己的合成项目及证据。

完整报告：[页面与配色检查](../.runtime/visual-audit-2026-09-13/after/report.json)、[六尺寸交互检查](../.runtime/visual-audit-2026-09-13/chrome/interactions.json)、[悬停对比度](../.runtime/visual-audit-2026-09-13/primary-hover.json)、[构建日志](../.runtime/visual-audit-2026-09-13/build.log)。首个合成预览检查因脚本未选择“求和”而失败，补齐脚本后完整重跑通过；不是产品计算失败。本轮没有运行全量业务测试、真实企业账号 / 数据库联调或真实模型评测。

启用状态：源码与开发站 `http://127.0.0.1:3001` 生效；稳定站 `http://127.0.0.1:3000` 仍是原验收版本，未发布或更新便携包。交付检查时稳定站、开发站、截图服务均健康，未启停任何服务。构建保留大于 500 kB 的客户端 chunk 提示。
