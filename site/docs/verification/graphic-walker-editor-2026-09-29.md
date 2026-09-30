# Graphic Walker 单图编辑器 · 2026-09-29

本日第二批补充见文末「编辑闭环与图片导出」。下方首批记录保留；最新退出保护、导出和详情入口验收以第二批为准。

## 当前交付与入口

- 开发站：`http://127.0.0.1:3001/charts`，打开即显示明确标注的模拟季度销售图。
- 现有工作台：看板工具栏「图表分析」，使用当前选中的数据源；数据源详情也增加同名入口。没有选中数据源时使用模拟样例。
- 当前是独立单图编辑试用，配置保存到当前浏览器，也可导出 / 导入 JSON。**没有写入项目清单或备份，不会替换现有 Notebook 单元、看板结果或正式布局。** 关闭前需保存配置，未保存编辑关闭后不保留。
- 原 Puck 负责多图看板布局，入口更名「布局编辑」以免混淆；原 Notebook / Recharts 不在本次范围，未删除。没有开发 AI 对话、报告或发布流程。

仅当前源码 / 3001 可用；未发布 3000，未提交、推送或制作运行包。

## 技术与模块边界

现有 React 19、TypeScript、vinext 和 Radix Themes 保留。新增固定 `@kanaries/graphic-walker@0.5.2` 与其 peer `styled-components@6.1.19`，更新 pnpm 锁文件。核对[官方仓库](https://github.com/Kanaries/graphic-walker)、实际安装包的声明 / 源码 / 导出，再使用已确认接口；没有替换计算引擎、收费依赖或直接修改 node_modules。

| 模块 | 实际职责 |
| --- | --- |
| `core/chart-editor/config.ts` | 唯一可编辑配置、字段与导入校验；映射官方 TerseSpec、IMutField 和 VegaGlobalConfig |
| `core/chart-editor/sample.ts` | 48 行明确模拟的交易数据，故意倒序输入，用于验证季度聚合与排序 |
| `components/chart-editor/ChartEditor.tsx` | 配置状态、Data / Style、搜索、浏览器保存与 JSON 导入导出 |
| `FieldShelf.tsx` / `FilterPanel.tsx` | 点击与拖拽字段、移除、Tooltip 重排、聚合 / 日期粒度 / 筛选输入 |
| `ChartCanvas.tsx` | 官方 normalize → getComputation → PureRenderer；响应尺寸、错误状态、同源计算结果表 |
| `ChartEditorBoundary.tsx` | 浏览器端延迟加载及失败提示，避免服务端执行依赖 DOM 的组件 |
| `ChartEditorDialog.tsx` | 现有数据源 / rows 到图表数据的薄适配，不查询数据库、不修改来源数据 |
| `app/charts/page.tsx` | 独立单图预览入口 |
| `DataProductCanvas.tsx` / `DataSourceDetailsPanel.tsx` | 工作台入口，不承担图表计算 |

编辑面板和画布共享 ChartConfig，官方规格是派生值，不维护第二份可编辑图表状态。筛选、聚合和日期钻取均交给 Graphic Walker；底部表格直接显示这次计算返回的结果，不另写一套聚合逻辑。PureRenderer 的 `type="remote"` 是其计算回调协议；本次回调实际调用浏览器内 `getComputation(rows)`，不是远端服务。

当前输入为工作台已经载入的 rows。底部显示参与行数；若小于数据源总行数，明确标注「非全量」。不把预览数据冒充数据库全量分析，也不自行扩大授权读取。配置文件不包含 rows、密钥或可执行表达式；恢复时检查版本、来源、字段存在性、类型和范围。

## 已实现功能

- 按用户 Hex 截图拆成独立字段库 + 配置列 + 右侧大画布；浅色、暖白外层、细边框、克制紫色。基础控件复用站内 Radix 组件。
- Data：面积 / 柱状 / 折线 / 散点图，搜索与分组字段，X / Y / 颜色，7 种数值聚合，原日期及年 / 季度 / 月 / 周 / 日，分类选择 / 数值区间 / 日期区间筛选，横向 / 纵向分面，Tooltip 字段。
- 字段可拖入或点击选择、移除。X / Y / 颜色 / 每个分面为单字段；Tooltip 支持多字段、拖动及上下按钮重排。Y 仅接受数值，颜色和分面仅接受维度；不放置无效字段选项，错误拖入也会说明原因。
- Style：标题及显隐，3 组配色，2 类字体、字号，数值格式，堆叠 / 百分比堆叠 / 不堆叠，轴 / 网格 / 图例显隐与图例位置。仅面积 / 柱状图展示堆叠设置。
- 加载、缺少轴字段、筛选无结果、非法字段、导入失败、计算 / 渲染失败有对应提示；错误导入不覆盖当前配置。切换标签页保留状态，保存后刷新 / 重开可恢复。
- 默认单张堆叠面积图：季度按时间排序、成交金额求和、客户类型分系列；中文悬浮提示含季度、类型及对应金额。

## 实际验证

命令均在 `site/` 执行：

| 命令 / 检查 | 本次结果 |
| --- | --- |
| `npm run site:status`，前后检查 | 3000 / 3001 / 3198 健康；PID、revision、重启数未变；未启停服务 |
| `pnpm install --frozen-lockfile --ignore-scripts` | 成功；未知 `postinstall-postinstall` 显式禁用，不批准全部脚本 |
| `node node_modules/vitest/vitest.mjs run core/notebook/presentation-table.test.ts core/visualization-lab/evaluate.test.ts` | 改前相关基线 19 项通过 |
| `node node_modules/vitest/vitest.mjs run core/chart-editor/config.test.ts` | 新增 7 项通过；末次样式调整后重跑通过 |
| `npm test` | 首次默认并发时 49 项失败、9 文件失败，包含 SQL / Python / DSH 超时及后续连带失败；未作为通过记录 |
| `npm test -- --maxWorkers=2` | 同一套全量检查 3637 通过、3 既有跳过；288 文件通过 / 1 跳过；随后 26 项 Node 工具单测通过 |
| `npm run typecheck` | 最后一次源码调整后通过 |
| 本批文件 ESLint | 通过；见下方实际范围；未宣称全仓 lint 无问题 |
| `npm run docs:agent:check` | 253 文件指纹一致；本批未改 Agent / Notebook 执行契约，不另同步已有架构修改 |
| `npm run build` | 末次源码通过生产构建；仍有大于 500 kB chunk 及插件耗时提示，未发布构建 |
| `node scripts/verify-graphic-walker.mjs` | 最终 14 组浏览器检查通过、13 张截图、页面错误 0 |
| `node scripts/verify-graphic-walker-workspace.mjs` | 隔离项目真实 CSV → 工作台 → 编辑器 → 保存 / 重开 / 关闭与 Esc 通过，2 张截图，错误 / 意外 API 请求 0 |
| `git diff --check` | 无空白错误，只有工作区 LF / CRLF 提示 |

ESLint 实际范围：`components/chart-editor core/chart-editor app/charts scripts/verify-graphic-walker.mjs scripts/verify-graphic-walker-workspace.mjs components/studio/DataProductCanvas.tsx components/studio/DataSourceDetailsPanel.tsx`，通过 `node node_modules/eslint/bin/eslint.js` 执行。

全量测试记录：[限制并发后的完整日志](../../.runtime/graphic-walker-20260929/offline-tests.log)；[最终构建日志](../../.runtime/graphic-walker-20260929/build-final.log)。首次全量失败发生在同时进行浏览器检查的环境；降低并发后相同断言通过，推断与资源争用有关，不将初次失败隐去，也未增加 skip 或放宽断言。

数据核对：模拟 48 行 → 24 个季度 / 客户组，总成交金额 **6,408,000**；2024 Q1 企业客户 **147,000**，平均值 **73,500**。年粒度为 6 组，企业过滤为 8 组，2024 日期过滤为 12 组。实际导入的合成 CSV 5 行 → 4 组，Q1 企业金额 **150**。没有使用用户截图中的业务记录。

浏览器使用隔离存储 / 自建临时项目，真实 Graphic Walker、真实 CSV 导入及本地项目路径。仅屏蔽用户已有项目列表 / 连接 / 模型设置的读取并提供空配置；没有 mock 图表计算，没有模型、收费调用或实库查询。拖拽、点击、日期粒度、求和 / 平均、过滤、两个分面方向、四类图表、主题实际 SVG、保存重载、下载 / 非法导入 / 正常导入与恢复均检查。其余聚合 / 日期选项已映射官方接口，但未逐个穷举验算；渲染异常兜底代码未做故意崩溃注入。

开发中已修正：SDK 直接服务端导入不兼容 → 客户端隔离；主题传入后被上游缓存 → 按主题重新挂载；固定尺寸分面裁切图例 → 官方 auto 模式配合 Vega view 尺寸。早期验收脚本的 SVG innerText / 隐藏 details 读取问题也已修正，最终重跑通过，早期失败目录保留。

## 3001 实际截图

以下 **15 张均于本批实际打开查看**，不是设计稿。主预览为 1440 px；窄屏 1024 px；工作台 1680 px。机器报告：[单图编辑器](../../.runtime/graphic-walker-20260929/browser-1790648452188/report.json)、[真实 CSV 接入](../../.runtime/graphic-walker-20260929/workspace-1790648398990/report.json)。

| 场景 | 截图与复核结论 |
| --- | --- |
| 00 加载 | [加载提示](../../.runtime/graphic-walker-20260929/browser-1790648452188/00-loading.png)：测试显式延迟编辑器模块响应；提示可见，无假图 |
| 01 默认 | [堆叠面积图](../../.runtime/graphic-walker-20260929/browser-1790648452188/01-stacked-area.png)：字段库 / 配置 / 画布分列，季度有序，右侧图例完整 |
| 02 悬浮 | [Tooltip](../../.runtime/graphic-walker-20260929/browser-1790648452188/02-tooltip.png)：中文季度、客户和金额清晰 |
| 03 空态 | [移除 Y 轴](../../.runtime/graphic-walker-20260929/browser-1790648452188/03-empty.png)：有字段操作指引，不残留旧结果 |
| 04 校验失败 | [非法字段拖入](../../.runtime/graphic-walker-20260929/browser-1790648452188/04-invalid-drop.png)：提示 Y 轴类型不支持，配置仍可修改 |
| 05 分类过滤 | [仅企业客户](../../.runtime/graphic-walker-20260929/browser-1790648452188/05-filtered.png)：单系列、8 个结果 |
| 06 无结果 | [区间无匹配](../../.runtime/graphic-walker-20260929/browser-1790648452188/06-no-results.png)：提示调整筛选、结果数为 0 |
| 07 横向分面 | [横向](../../.runtime/graphic-walker-20260929/browser-1790648452188/07-horizontal-facet.png)：三个面板和右侧图例完整 |
| 08 纵向分面 | [纵向](../../.runtime/graphic-walker-20260929/browser-1790648452188/08-vertical-facet.png)：三个面板，字段及坐标可读 |
| 09 样式 | [Style](../../.runtime/graphic-walker-20260929/browser-1790648452188/09-style.png)：标题 / 蓝色 / 衬线 / 两位小数实际生效，网格消失 |
| 10 显隐 | [关闭轴与图例](../../.runtime/graphic-walker-20260929/browser-1790648452188/10-hidden-axis-legend.png)：线、标签、轴标题和图例均隐藏 |
| 11 导入失败 | [非法 JSON](../../.runtime/graphic-walker-20260929/browser-1790648452188/11-invalid-import.png)：明确错误，已有样式保留 |
| 12 窄桌面 | [1024 px](../../.runtime/graphic-walker-20260929/browser-1790648452188/12-narrow.png)：无页面水平溢出，配置独立滚动；长数值 / 大字体会压缩绘图区 |
| 13 当前数据 | [真实 CSV 编辑](../../.runtime/graphic-walker-20260929/workspace-1790648398990/13-real-csv-workspace.png)：读取真实导入的模拟数据，5 行 / 4 个聚合结果，保存反馈可见 |
| 14 退出 | [返回工作台](../../.runtime/graphic-walker-20260929/workspace-1790648398990/14-close-restores-workspace.png)：关闭 / Esc 后正常返回，焦点回到入口 |

## 与 Hex 的差异、源码需求和剩余风险

1. 复现的是字段库、Data / Style、字段标签、分面、右侧图例及大画布层次，不复制品牌或截图 SQL / Notebook / 聊天布局。样例使用 3 类客户、8 个季度，并非截图中的原业务数据和走势。
2. Tooltip 目前沿用 GW 单系列命中提示，不是 Hex 同季度全系列联合提示 / 十字线。坐标标题仍可能显示 `sum(成交金额)` / `quarter(季度)`。后续若要求完全一致，应先增加独立 Vega 交互适配；本轮未确认必须 fork，不能声称已完成。
3. 当前只开放上述稳定配置，不是完整 GW 原生编辑器：地理图、箱线图、任意计算字段、连续数值颜色、双轴和多个数值序列未开放。分类 Tooltip 字段会改变聚合粒度，界面已明确提示。高基数分面可在画布滚动，未做大数据性能保证。
4. **本批已交付功能不需要改 GW 源码。** 但 0.5.2 的 ShadowDOM 包装会无条件插入 `https://unpkg.com/leaflet@1.9.4/dist/leaflet.css`，尚未找到公开关闭选项。浏览器验收阻断了该可选 CSS（主脚本记录 42 次），本批非地图图表全部工作，没有其他外联请求。实际应用仍会尝试请求该静态样式；没有将阻断夹具冒充产品零外联实现。若要求组件自身完全不生成这个请求，需要上游修正或集中维护补丁；没有直接改 node_modules。
5. SDK 体积较大，使用懒加载避免首页立即加载；生产构建的 chunk 体积提示仍保留。安装还有 Apache Arrow `arrow2csv.cjs.EXE` 命令入口警告，未使用该 CLI，图表和构建已验证；不宣称所有附带工具可用。新增依赖的完整供应链审计与便携包验收未做。
6. 保存当前仅限该浏览器 / 数据源 ID，JSON 可用于同来源恢复；不是跨项目图表资产管理，不进入原项目备份。数据源详情的第二入口已接线，但本次浏览器完整链路走的是看板入口；未单独复测嵌套详情弹窗。
7. 目前验证桌面 Edge；移动端、Safari / Firefox、超大数据、复杂时区、异常日期混合类型与高基数分面未穷举。已有用户项目未读取或修改。

工作区分支 `feature/eds-analysis-dashboard`；此前 Notebook 实时过程、DSH 插件、架构及打包相关未提交修改完整保留，不归入本批成果。本次无删除、提交、推送或稳定站发布。

## 第二批：编辑闭环与图片导出

用户要求继续后，本批保持单图范围；无新增运行依赖，无 Graphic Walker 源码 / node_modules 修改，无 Agent 或 Notebook 契约变化。

### 实际修改

- `core/chart-editor/history.ts` / `history.test.ts`：纯配置撤销 / 重做，只保留最近 50 个配置快照，不复制原始行。新编辑清除重做分支，同值操作不增加历史；导入 / 恢复也是可撤销修改。历史仅本次打开有效，不写浏览器或项目文件。
- `ChartEditor.tsx`：接入历史、保存基线和真实 dirty 状态；撤销回保存点后不再误报未保存。新增字段库展开 / 收起，1024 px 时释放约 142 px 绘图区；字段选择下拉仍可用，不改变配置。
- `useChartExitGuard.tsx`、`ChartEditorDialog.tsx`、`ChartEditorPage.tsx` / `app/charts/page.tsx`：复用 Radix AlertDialog。编辑器关闭、Esc 和独立页「返回工作台」在有修改时提醒，可继续编辑或放弃；取消不丢配置，保存失败不解除保护。真正浏览器刷新 / 关闭使用 beforeunload，不自行接管浏览器提示文本。
- `ChartImageExport.tsx`、`core/chart-editor/image-export.ts` / 测试：通过已安装 0.5.2 的 **公开 PureRenderer ref.getSVGData / getCanvasData** 导出，不抓取内部 DOM、不截图替代矢量图、不访问远端绘图服务。验证返回内容后下载，保留中文并规范文件名；图形为空、计算失败或未得到有效输出不下载伪文件。导出期间若配置 / 组件实例更换，放弃旧回执。
- `ChartCanvas.tsx`：按配置 / 主题隔离渲染实例，避免将前一个图导出为新配置；普通尺寸变化仍使用官方 overrideSize，不因此反复重建计算。按钮在缺轴 / 无结果 / 计算错误时禁用。PNG / SVG **只含图形、坐标和图例，不含页面标题、配置面板或源数据表**，界面明确说明；分面按官方渲染结果导出。
- `chart-editor.css`：折叠布局、较窄字段标签及图片操作区，沿用原白色画布 / Radix 控件。不是另造可视化引擎。

### 本批浏览器证据

新增 `node scripts/verify-graphic-walker-editing.mjs`，8 组检查通过，覆盖撤销 / 重做、保存点、取消退出、保存失败、有效图片下载、导出失败及重试、分面导出、窄屏和空态禁用。下方 6 张实际截图及下载 PNG 均已逐张打开查看；错误注入分别为模拟 Storage 写入失败和 Blob 创建失败，不冒充真实磁盘故障。

| 场景 | 本批截图与结论 |
| --- | --- |
| 未保存退出 | [确认弹窗](../../.runtime/graphic-walker-20260929/editing-1790649575302/01-unsaved-exit.png)：保留继续编辑 / 放弃两个明确操作 |
| 保存失败 | [保留编辑](../../.runtime/graphic-walker-20260929/editing-1790649575302/02-save-failure.png)：错误可读，图形 / 输入不丢失，退出仍受保护 |
| 图片成功 | [PNG 下载反馈](../../.runtime/graphic-walker-20260929/editing-1790649575302/03-image-export.png)：图形与蓝色配色正确；[实际下载的 PNG](../../.runtime/graphic-walker-20260929/editing-1790649575302/chart.png) 已查看 |
| 导出失败 | [模拟文件创建被拒](../../.runtime/graphic-walker-20260929/editing-1790649575302/04-export-failure.png)：就地报错，移除故障夹具后重试成功 |
| 窄屏收起 | [1024 px](../../.runtime/graphic-walker-20260929/editing-1790649575302/05-collapsed-1024.png)：字段库隐藏后画布变宽，图表类型仍可切换，无页面水平溢出 |
| 无效图形 | [空态禁用导出](../../.runtime/graphic-walker-20260929/editing-1790649575302/06-empty-export-disabled.png)：无 Y 轴时不能导出空图，撤销可恢复 |

[新增交互机器报告](../../.runtime/graphic-walker-20260929/editing-1790649575302/report.json)；[实际 SVG](../../.runtime/graphic-walker-20260929/editing-1790649575302/chart.svg)、[三个客户分面的 SVG](../../.runtime/graphic-walker-20260929/editing-1790649575302/faceted.svg) 的内容经自动检查。PNG 检查签名及尺寸并实际查看；SVG 不包含编辑面板，保留中文标签与选定配色。

原 `verify-graphic-walker.mjs` 本批重新运行，14 组检查通过；[本次回归报告](../../.runtime/graphic-walker-20260929/browser-1790649599732/report.json)对应的 00–12 共 13 张新截图均已实际查看，字段 / 筛选 / 分面 / 样式 / 持久化未见回退，不拿首批旧图作本批验证。

扩展后的 `node scripts/verify-graphic-walker-workspace.mjs` 也重新通过，使用本轮自建隔离项目和合成 CSV。补验详情入口、未保存取消 / 放弃、嵌套弹窗焦点；[工作台报告](../../.runtime/graphic-walker-20260929/workspace-1790649871542/report.json)的以下 5 张均已查看：

| 场景 | 截图与结论 |
| --- | --- |
| 当前 CSV | [真实导入数据](../../.runtime/graphic-walker-20260929/workspace-1790649871542/13-real-csv-workspace.png)：5 行 / 4 组，保存生效 |
| 普通退出 | [返回看板](../../.runtime/graphic-walker-20260929/workspace-1790649871542/14-close-restores-workspace.png)：关闭和 Esc 正常，焦点返回入口 |
| 未保存弹窗 | [保护编辑](../../.runtime/graphic-walker-20260929/workspace-1790649871542/15-dialog-unsaved.png)：Esc 先确认；继续编辑保留修改，放弃后重开读取保存点 |
| 详情内入口 | [嵌套编辑器](../../.runtime/graphic-walker-20260929/workspace-1790649871542/16-source-details-entry.png)：同一数据及配置，无第二份计算状态 |
| 嵌套退出 | [退出后的工作台](../../.runtime/graphic-walker-20260929/workspace-1790649871542/17-nested-close.png)：Esc 仅关闭编辑器，验证回到详情焦点后再关闭详情 |

第二批合计 **24 张网页截图 + 1 个实际下载 PNG 已查看**；此前快速截图捕获过弹窗进场 / 图表加载，已在关闭动效并等待稳定状态后重新截图，不用过渡帧作为最终验收。

### 本批命令与结果

- 改前 `node node_modules/vitest/vitest.mjs run core/chart-editor/config.test.ts`：7 项通过。
- 改后 `node node_modules/vitest/vitest.mjs run core/chart-editor`：14 项通过，新增历史 4 项与导出边界 3 项。
- `npm test -- --maxWorkers=2`：**3644 通过、3 既有跳过**，290 文件通过 / 1 跳过；随后 **26 项 Node 工具测试通过**，没有新 skip。本批不重新使用已知资源争用的默认高并发。[完整日志](../../.runtime/graphic-walker-20260929/editing-tests.log)。
- `npm run typecheck`、`node node_modules/eslint/bin/eslint.js components/chart-editor core/chart-editor app/charts scripts/verify-graphic-walker-editing.mjs scripts/verify-graphic-walker-workspace.mjs` 通过；最后截图脚本改动后对该脚本再次 lint 通过。
- `npm run build` 通过；仍有 chunk 体积和插件耗时提示。[本批构建日志](../../.runtime/graphic-walker-20260929/editing-build.log)。没有覆盖稳定站运行目录。
- `npm run docs:agent:check`：253 文件一致；`git diff --check` 无空白错误；本批不改变执行架构，不借机同步前一任务的正文 / 指纹。
- 三份本批浏览器报告通过；新交互 8 组、基础回归 14 组、工作台 3 组。页面错误均为 0。可选地图 CSS 被测试阻断，产品仍有该已知请求，没有把测试拦截当作产品修复。未调用模型 / 实库，未读取用户项目。
- 前后 `npm run site:status`：3000 / 3001 / 3198 健康，服务 / 工作进程 PID、revision、重启数不变。当前分支 `feature/eds-analysis-dashboard`，本批和此前未提交内容保留，无提交、推送、删除、发布或新依赖安装。

### 仍未改变的边界

公开 PureRenderer ref 本次确认只暴露 SVG / Canvas 导出，不含 Vega View 或悬浮事件编辑钩子；联合 Tooltip 本批未实施，未以私有 DOM 选择器模拟它。可选 Leaflet CDN 请求风险与组件体积提示仍保留。配置仍仅浏览器 / JSON，尚未接入项目清单和备份；导出没有增加报告 / 发布能力。

浏览器关闭保护本次验证的是事件注册 / 解除，未对每种浏览器的原生提示、历史后退或外部脚本强制卸载作完整保证。异常文件写入用显式夹具，未测试真实磁盘已满或操作系统下载失败。图片采用官方导出能力，未修改上游排版；在不同机器上系统字体可能有差异。

## 第三批：Notebook 内嵌编辑与显示

用户后续明确要求像 Hex 一样直接显示到 Notebook，因此本批将原本独立的编辑器接入现有 chart 单元，不扩展聊天、多图报告或发布。入口：`http://127.0.0.1:3001` → Notebook → 先运行上游 Data / SQL → 新增「图表」或编辑已有单数值柱 / 线 / 面积图 → 保存单元 → 运行。旧多指标、饼图和环形图仍用兼容编辑器，原定义不自动迁移。`/charts` 独立入口仍可试用。

### 真实落地的边界

- `core/notebook/graphic-walker.ts` 是薄适配层：将当前有效上游表映射为 ChartDataset、转换旧图的编辑预览、校验字段并列出所有引用。`definition.ts` 为原 chart 增加可选 `graphicWalker`，严格验证单元 ID / 输入、图表类型、标题及 X / Y 一致性，没有第二份互相冲突的图表状态。
- `components/chart-editor/ChartEditor.tsx` 增加可选 owner 接口；Notebook 由 owner 提供配置与保存回调，不读写独立图表 localStorage。字段、聚合、筛选、分面、Data / Style、历史和图片导出共用原组件；取消不影响正式单元，修改后需确认放弃。
- `NotebookChartEditor.tsx` 在单元内嵌入左配置 / 右画布，兼容编辑器集中到 `LegacyNotebookChartEditor.tsx`。`NotebookChart.tsx` 使用浏览器懒加载边界显示正式 GW 图；局部尺寸在 `notebook-graphic-walker.css`。无 node_modules、GW 源码或新依赖修改。
- `projectPresentationTable` 保留颜色、Tooltip、筛选、分面使用的输入列和原行，不在服务器重写 Graphic Walker 聚合。`NotebookResult` / `NotebookPanel` 明示「输入数据」「保存输入为 Dataset」；聚合结果查看位于图内。非全量输入提示先 SQL 聚合，不能将当前预览宣称为全量业务结论。
- 原看板无法等价表达高级图表，`dashboard-policy.ts` 与界面均阻止新版图转旧快照，避免静默丢失分组 / 筛选。现有图仍可保存输入表，图片可导出；本批不增加看板图表类型。
- 保存仍经过原 Notebook revision、项目自动保存和运行新鲜度机制；重开项目保留配置，但数据必须重新运行，不读取用户历史结果冒充新结果。单元运行回执只证明输入投影，不证明浏览器视觉效果或聚合结果。

### 验收中发现并修复

1. SQL worker 原来把 DATE 标成 string，无法选择日期粒度。现在仅对 DuckDB 明确声明的 DATE 保留 `date` 元数据，以原日历字符串 / NULL 返回，时间戳及高精度数值继续无损 string。真实 DuckDB 单测覆盖非空、NULL、空结果字段和微秒时间戳。
2. 纯日期在本机时区下被归到前一季度：通过 GW 公开 `IMutField.offset=0` 配合已有 `timezoneDisplayOffset=0` 修正，最终浏览器断言首尾为 **2024 Q1 / 2025 Q4**，并核对图形可访问标签。不是手工修改聚合结果。
3. 完整可视化 Schema 撑大旧 Harness 的普通模型请求，引起显式 10,000 字符预算和普通请求体积测试失败。参数投影仅在已有 GW 图或明确请求 Graphic Walker 时携带高级配置；普通任务不携带无关配置，运行时校验完整保留。没有调整原额度、放松断言或增加跳过项。
4. 更新旧编辑器的原生 select 断言为新版入口 / 等待数据检查，另加多指标兼容测试；模块边界现在明确只允许输入投影依赖纯适配 / Zod 配置，不加载 React、浏览器计算器、模型或服务器能力。开发中还修正了测试夹具类型和 Hook 回调名称。

### 3001 本批实际截图

`node scripts/verify-notebook-graphic-walker.mjs` 使用新建隔离项目、合成 CSV 和真实 HTTP / DuckDB / 项目保存；模型、连接列表等读取使用空夹具，不读用户数据或密钥。4 次 Notebook 运行成功，无页面异常 / 意外业务请求。48 行明细形成 24 个季度 / 客户组合，首季度企业金额 **150,000**；筛选企业后剩 8 个季度。保存后 JSON 保留字段、筛选及配色，独立图表 localStorage 无记录。

以下 **9 张网页截图和 1 张实际下载 PNG 均已打开查看**：

| 场景 | 截图与结论 |
| --- | --- |
| 单元内编辑 | [左配置 / 右面积图](../../.runtime/graphic-walker-20260929/notebook-1790651194297/01-notebook-inline-area.png)：3 系列与季度聚合正确，Data / Style 复用原组件 |
| 取消保护 | [确认后继续编辑](../../.runtime/graphic-walker-20260929/notebook-1790651194297/02-cancel-confirmation.png)：配置不丢；末尾另测确认放弃，正式标题保持 |
| 缺少字段 | [移除 Y 轴后保存被拒](../../.runtime/graphic-walker-20260929/notebook-1790651194297/03-missing-axis.png)：明确错误 / 空态，撤销恢复 |
| 正式结果 | [保存并运行后的 Notebook 图](../../.runtime/graphic-walker-20260929/notebook-1790651194297/04-saved-notebook-chart.png)：24 组、正确季度，保留输入 48 行 / 3 列 |
| 筛选 | [只保留企业客户](../../.runtime/graphic-walker-20260929/notebook-1790651194297/05-filter.png)：8 组，画布和配置同步 |
| 分面 | [客户水平分面](../../.runtime/graphic-walker-20260929/notebook-1790651194297/06-facet.png)：筛选后的分面正确显示 |
| 重开未运行 | [明确等待上游](../../.runtime/graphic-walker-20260929/notebook-1790651194297/07-reopen-no-stale-data.png)：不出旧图，拒绝用缺失数据保存 |
| 配置恢复 | [重跑恢复筛选及蓝色样式](../../.runtime/graphic-walker-20260929/notebook-1790651194297/08-restored-chart.png)：首尾日期正确；[实际导出 PNG](../../.runtime/graphic-walker-20260929/notebook-1790651194297/notebook-chart.png) 无编辑面板 |
| 窄屏 | [1024 px](../../.runtime/graphic-walker-20260929/notebook-1790651194297/09-notebook-1024.png)：无页面水平溢出，字段库隐藏、点击选择可用；聊天展开时图仍偏窄，不宣称窄屏已完全优化 |

[Notebook 机器报告](../../.runtime/graphic-walker-20260929/notebook-1790651194297/report.json)。较早一轮脚本保存等待漏掉原有输出改名确认，修正后重跑；另一次图形虽然能显示但季度偏移，在查看截图后修复并重新全程验收。旧截图不当作最终日期正确的证据。

共用组件还重跑 `node scripts/verify-graphic-walker.mjs`，**14 组通过**（拖拽 / 类型拒绝、SUM / 平均、日期、分类 / 日期 / 数值筛选、双向分面、Tooltip 重排、图表切换、样式及 JSON 恢复）；[本次独立页报告](../../.runtime/graphic-walker-20260929/browser-1790651569772/report.json)的 00–12 共 **13 张新截图全部已查看**。本批共 22 张网页截图 + 1 个实际 PNG。可选 Leaflet CSS 请求仍被测试阻断，产品中该已知外联行为未改。

### 命令和验证结论

- `npm test -- --maxWorkers=2` 最终 **3663 项应用测试通过、3 项既有跳过**（291 文件通过 / 1 跳过），随后 **26 项 Node 工具测试通过**；[最终完整日志](../../.runtime/graphic-walker-20260929/notebook-tests-verified.log)。第一轮 5 项失败包括旧界面 / 模块边界断言、季度修正时测试先于代码加载及两个请求体积回归；第二轮剩 4 项模型 Schema 等价断言，需要同步新增的条件投影契约，现扩展为参数 / GW 各开启与关闭的组合比较，完整约束仍逐项相等。两轮失败日志保留为 `notebook-tests.log` / `notebook-tests-final.log`，不作通过证据，没有新增 skip。
- `npx vitest run core/harness/tool-schema.test.ts core/harness/notebook-cell-tools.test.ts core/harness/analysis-planner.test.ts --maxWorkers=2`：最终定向 **53 项通过**；此外图表 / Notebook 定向测试、真实 DATE worker 验证通过，均被最终全量覆盖。
- `npm run typecheck`、本批 TypeScript / TSX / 新增脚本的定向 ESLint 通过。查询 worker 的 3 个 `no-require-imports` 是既有 CJS 规则冲突，使用 HEAD 源码复现相同错误；未以禁用规则或忽略新错误伪装全仓 lint 通过。全仓 lint 未重复运行。
- `npm run build` 通过，[本批构建日志](../../.runtime/graphic-walker-20260929/notebook-build.log)；保留 chunk 体积 / 插件耗时提示。没有覆盖稳定站产物。
- 架构文档正文和变更记录更新，`npm run docs:agent:sync` / `npm run docs:agent:check` 同步 **259 文件**；新增共享配置目录与查询 worker 指纹范围。`npm run docs:agent:test` 守卫测试通过（1 项），`git diff --check` 无空白错误。前后 `npm run site:status` 的 3000 / 3001 / 3198 均健康，PID、revision 和重启数保持不变。

### 本批仍不包含的内容

本批不需要 fork Graphic Walker；联合 Tooltip / 十字线仍未实现，是否需要上游扩展尚未确认。使用官方自动轴标题，样例数据和走势不是 Hex 原业务数据。新增 Notebook 配置进入项目持久化，但独立 `/charts` 仍只用浏览器 / JSON；旧版本客户端兼容、便携包 / Release、实库、收费模型、高基数 / 大数据和多浏览器未验收。原多指标、饼 / 环形图不强行迁移，Notebook 散点图未开放。

旧 Harness 保留。本批仅做必要参数投影兼容，没有改 DSH 对话或生成流程。后续替换可视化引擎主要在 `core/chart-editor` 的配置映射和 `components/chart-editor` 的画布边界；Notebook 接线集中在 `core/notebook/graphic-walker.ts` / 单元编辑器，不需要把数据库或 Agent 搬入界面。

工作区分支 `feature/eds-analysis-dashboard`，本批和此前未提交修改保留，未删除用户文件、提交 / 推送 Git、发布 3000 或启停服务。源码 / 3001 可用，不将生产构建成功当作稳定站发布。

## 第四批：图表编辑入口可见性修正

用户截图反馈「没有啊」：中央可见的是第 15 / 16 项明细表，左侧第 11–13 项是图表。检查发现普通布局和 Radix 样式均把非运行按钮设为 `opacity: 0`，只有悬停 / 焦点 / 选中才显示；同时旧图并不会自动展开新版编辑器。因此修正入口可发现性，不修改用户数据或强制迁移历史定义。

- `NotebookPanel.tsx` 将 chart 的入口改名为「编辑图表」，添加局部 class 和单元内编辑提示，原权限 / 外部忙碌 / 编辑锁不变。
- `app/theme-controls.css`、`app/notebook-workbench.css` 仅对该入口取消隐藏；普通编辑、次要工具和 Run 保持原行为。
- 新增 `NotebookChartEntry.test.tsx` 的 3 种权限 / 忙碌验证；扩展 `verify-notebook-graphic-walker.mjs`，从无 GW 配置的旧格式单指标柱图开始检查入口、打开与无修改取消。
- 使用方式：刷新 3001 → 左侧大纲定位图表 →「编辑图表」。新版配置出现在本单元中，不是常驻在普通表格旁。多指标 / 饼 / 环形图仍是兼容编辑器，不能宣称任何旧图都已替换。

### 本次截图和交互验收

新隔离项目、合成 CSV、真实 SQL 和项目存储；没有打开用户项目。浏览器先断言旧图单元没有 hover、focus-within 或 is-selected，再断言「编辑图表」opacity 为 1。打开 GW 并取消后对整个 Notebook 定义做等值比较；后续保存 / 重开沿用实际链路。

以下 11 张新网页截图和 1 张导出 PNG 均已实际查看；[机器报告](../../.runtime/graphic-walker-20260929/notebook-1790655163100/report.json)记录 5 次成功运行，无页面错误或意外请求。

| 场景 | 本次截图与结论 |
| --- | --- |
| 旧图未选中 | [常驻编辑图表](../../.runtime/graphic-walker-20260929/notebook-1790655163100/00-legacy-visible-entry.png)：选中上游 SQL、鼠标移出，旧图按钮仍显示 |
| 旧图打开 | [单元内 GW](../../.runtime/graphic-walker-20260929/notebook-1790655163100/00-legacy-inline-editor.png)：左配置 / 右画布；取消后无定义变更 |
| 多系列配置 | [季度堆叠面积图](../../.runtime/graphic-walker-20260929/notebook-1790655163100/01-notebook-inline-area.png)：48 行形成 24 组，2024 Q1 企业金额 150,000 |
| 取消保护 | [继续编辑](../../.runtime/graphic-walker-20260929/notebook-1790655163100/02-cancel-confirmation.png)：保留修改，另测确认放弃恢复保存点 |
| 无效配置 | [缺少 Y 轴](../../.runtime/graphic-walker-20260929/notebook-1790655163100/03-missing-axis.png)：拒绝保存，撤销恢复 |
| 保存后运行 | [正式 Notebook 图](../../.runtime/graphic-walker-20260929/notebook-1790655163100/04-saved-notebook-chart.png)：本地项目保存成功，不写独立图表缓存 |
| 筛选 | [企业客户](../../.runtime/graphic-walker-20260929/notebook-1790655163100/05-filter.png)：8 个季度组 |
| 分面 | [客户分面](../../.runtime/graphic-walker-20260929/notebook-1790655163100/06-facet.png)：配置与画布同步 |
| 重开未运行 | [等待上游](../../.runtime/graphic-walker-20260929/notebook-1790655163100/07-reopen-no-stale-data.png)：不展示过期数据，拒绝保存 |
| 恢复 | [重跑后蓝色面积图](../../.runtime/graphic-walker-20260929/notebook-1790655163100/08-restored-chart.png)：筛选 / 样式保留；[实际导出 PNG](../../.runtime/graphic-walker-20260929/notebook-1790655163100/notebook-chart.png)内容正确 |
| 1024 px | [窄屏配置](../../.runtime/graphic-walker-20260929/notebook-1790655163100/09-notebook-1024.png)：可编辑，无页面横向溢出；聊天展开时画布仍偏窄、横轴拥挤，本批未改善 |

### 本批命令与范围

- `npx vitest run components/studio/notebook core/notebook/graphic-walker.test.ts --maxWorkers=2`：25 文件 / **394 项通过**，包括新入口 3 项；未重跑全仓测试，不借用第三批全量成绩。
- `npm run typecheck` 及 `npx eslint components/studio/notebook/NotebookPanel.tsx components/studio/notebook/NotebookChartEntry.test.tsx scripts/verify-notebook-graphic-walker.mjs` 通过。
- `npm run build` 通过，[本次构建日志](../../.runtime/graphic-walker-20260929/chart-entry-build.log)保留；仍有 chunk 体积 / 插件耗时提示，未覆盖稳定站产物。
- `node scripts/verify-notebook-graphic-walker.mjs` 全程通过，前述截图均为本次新采集；读取模型 / 连接列表使用空夹具，可选 Leaflet CSS 仍由测试拦截，不冒称模型 / 实库验证或零外联。
- 视觉规范、架构正文与变更记录更新，`npm run docs:agent:sync` / `npm run docs:agent:check` 259 文件一致；`git diff --check` 无空白错误，保留原有换行格式提示。
- `npm run site:status` 前后 3000 / 3001 / 3198 均健康，PID、revision、重启数相同；未启停服务。无新依赖、无 GW 源码或 node_modules 修改、无提交 / 推送 / 发布，旧 Harness 保留。
