# 统一可视化 B2：正式 Notebook 接线

日期：2026-09-29。范围：支持的单指标柱 / 线 / 面积图从正式 Notebook 完整上游计算、编辑保存与结果展示；不是新演示路由。仅源码 / 3001，未发布 3000。

## 实现

- 宿主转换：`core/notebook/visualization.ts`。保留 Cell / ChartConfig V1 / storageVersion 7，V2 只在运行中生成。旧图不改写、不自动 SUM；兼容图仍可编辑。
- 执行：`execution-contracts.ts` / `server/runtime.ts` / `server/execution.ts` 注入 `visualize`，复用现有 DuckDB；完整上游运行引用进入 `core/visualization`，不拿有限展示表计算。
- 证据：`contracts.ts` / `run-receipt.ts` 新增可选 visualization 和定义 key，原 table / Dataset 仍为输入；前端再校验 hash。`live-progress.ts` 不传播完整计算结果。
- 页面：`NotebookResult` / `NotebookMaterializedChart` / `MaterializedChartCanvas` 显示正式图、计算表及输入预览；复用 GW 公共渲染与导出、既有编辑器和主题。没有改 node_modules 或增加依赖。

## 语义与限制

CSV 标准 UTC 午夜日期兼容纯日期计算，季度轴可读；任意时间戳 / DST 不支持。GW count 包含 NULL，映射 COUNT(*)；其余聚合遇 NULL 保留原口径，避免默默改变数值。分面、额外 Tooltip 分组、复杂筛选、周、百分比堆叠、数字 / 空 X、多指标和饼环图明确保留兼容路径；无 GW 配置的旧图若存在重复分类或超过 1,000 行，也保留原显示，避免原始柱重叠或改变截断口径。新版计算单次 50,000 行 / 16 MiB 输入、1,000 行 / 2 MiB 输出及原 Notebook 总预算不变。

编辑预览仍基于已返回的有限数据；保存后点击“运行”取得完整正式图。配置跟随项目保存 / 重开，结果只在当前运行有效。看板快照与新格式迁移未做，聚合结果暂不提供 Dataset 保存；原保存按钮仍保存输入。AI 可经同一执行入口运行支持的图，但没有新图表工具 Schema，也未进行本轮收费模型测试。

## 验证记录

### 自动化

- 最终定向 4 文件 / 58 项通过，覆盖宿主转换、服务端执行、既有编辑入口与模块边界；本轮还运行真实 DuckDB 日期与计算测试。类型检查、改动代码定向 ESLint、生产构建通过；既有大 chunk / 插件耗时提示保留。
- 最终冻结代码后 `npm test -- --maxWorkers=2`：**299 文件 / 3,769 项通过，1 文件 / 3 项既有检查跳过**，随后 **26 项 Node 工具测试通过**，退出码 0。先前一轮 298 文件 / 3,755 项与 26 项工具测试通过，但不覆盖最后补充的重复分类保护，因此最终以本次 16:16 启动的回归为准。
- `docs:agent:sync` 后 `docs:agent:check` **267 文件一致**；`git diff --check` 通过，保留既有 CRLF 提示。
- 用例覆盖完整输入而非预览聚合、取消不发布、AI 模式先脱敏再计算、回执定义 / 身份 / 行数不匹配拒绝、NULL 计数语义、重复旧分类保留原显示。未运行真实模型或外部数据库。

### 正式页面实际操作

脚本：`scripts/verify-notebook-visualization.mjs`，另以 `--legacy` 补验旧图。使用隔离 Edge / 3001 和明确标记的模拟销售数据；真实项目保存、CSV 导入与 Notebook 运行 API，没有用独立 fixture 代替产品。隔离未选项目的启动目录 / 连接列表及 AI 配置，阻止意外外部 / 模型请求；不读取用户项目。两个最终 report 均 `passed: true`、`errors: []`、`blocked: []`。

- 1,250 行源数据，界面上游预览 100 行；正式图计算 **24 个季度 × 客户类型分组**，逐项与独立求和核对。输入预览仍为 1,000 / 1,250，未冒充聚合表。
- 真拖拽字段、季度粒度、SUM、堆叠面积、Style 标题、取消后继续编辑、无效 Y 拒绝保存；筛选企业客户 → MEAN → 折线 / 配色，8 个均值逐项正确；实际 PNG 下载并查看。
- 分面明确提示兼容计算；空筛选结果有提示；保存重开配置一致，不拿旧运行结果保存；重跑恢复正式图；1024 px 无页面横向溢出。
- 旧图未含 graphicWalker 配置，8 个原始值经 GW 显示且未 SUM；打开编辑 / 取消保持保存定义完全一致。重复分类旧图的兼容保护另外由服务端用例覆盖，未冒称该场景有浏览器截图。

### 截图（已逐张实际查看）

主验收 [report.json](../../.runtime/visualization-notebook-20260929/browser-1790669476704/report.json)：

| 场景 | 截图 |
| --- | --- |
| 正式 Notebook 内编辑、有限预览提示 | [01](../../.runtime/visualization-notebook-20260929/browser-1790669476704/01-inline-preview-limited.png) |
| 取消后继续编辑 | [02](../../.runtime/visualization-notebook-20260929/browser-1790669476704/02-cancel-keeps-edit.png) |
| 缺少 Y 轴，拒绝保存 | [03](../../.runtime/visualization-notebook-20260929/browser-1790669476704/03-invalid-axis.png) |
| 完整上游堆叠面积 | [04](../../.runtime/visualization-notebook-20260929/browser-1790669476704/04-full-upstream-area.png) |
| 独立图表计算表 | [05](../../.runtime/visualization-notebook-20260929/browser-1790669476704/05-materialized-table.png) |
| 筛选 / 均值 / 折线 / 配色 | [06](../../.runtime/visualization-notebook-20260929/browser-1790669476704/06-filtered-mean-line.png) |
| 分面兼容提示 | [07](../../.runtime/visualization-notebook-20260929/browser-1790669476704/07-facet-explicit-compatibility.png) |
| 空结果 | [08](../../.runtime/visualization-notebook-20260929/browser-1790669476704/08-empty-result.png) |
| 重开后拒绝旧证据 | [09](../../.runtime/visualization-notebook-20260929/browser-1790669476704/09-reload-no-stale-evidence.png) |
| 重跑恢复完整图 | [10](../../.runtime/visualization-notebook-20260929/browser-1790669476704/10-restored-formal-chart.png) |
| 1024 px | [11](../../.runtime/visualization-notebook-20260929/browser-1790669476704/11-notebook-1024.png) |

旧图 [report.json](../../.runtime/visualization-notebook-20260929/browser-1790669636023/report.json)：[12 原始行正式绘图](../../.runtime/visualization-notebook-20260929/browser-1790669636023/12-legacy-formal-gw.png)、[13 编辑 / 取消](../../.runtime/visualization-notebook-20260929/browser-1790669636023/13-legacy-editor.png)。共 **13 张产品截图**，另查看了 [实际导出 PNG](../../.runtime/visualization-notebook-20260929/browser-1790669476704/chart-export.png)。模拟项目保留在各 report 所在目录的 `project/`，没有替换用户正在使用的项目。

### 失败与修正记录

初次浏览器已完成实际导入、拖拽、保存及 24 组核对，随后因测试脚本误用表格 class / 将每页 20 行误认 10 行而失败；第三次脚本在折线图隐藏堆叠选项时寻找该控件，已修正操作顺序。失败目录保留，不计为完整通过。最终采用上表两个成功目录。

首次回执测试需更新新增的冻结预期字段；服务端测试曾把无输出变量的图表当作下游输入，修正测试建模后通过。中途全量回归与新增重复分类保护同时进行，曾出现该新用例失败；不将那轮当作最终结果，冻结代码后独立重跑全量。不能仅凭此推断具体缓存成因。

## 启用状态与剩余差异

- 实际入口：[3001 开发站](http://127.0.0.1:3001) → Notebook → 图表单元运行 / 编辑图表。刷新后需重新运行以获取新版回执；不是仅切换页面就重算。保存图表配置后仍显式点击运行，不新增自动执行。
- 16:19 最终服务检查：3000 / 3001 / 3198 均健康，PID / revision / 重启数与 15:47 基线一致；没有发布、重启或停止服务。未提交 / 推送 Git，没有依赖变更或文件删除，保留原有未提交修改。
- 相比参考 Hex：已在文档内显示左侧配置 / 右侧画布，但不做品牌 / 像素复刻。正式图使用离散日期轴，季度标签可读；未做多系列联动 Tooltip，表中日期仍为 ISO。窄屏仍受右侧聊天占宽影响，未改变该无关布局。
- 此批使用现有 GW 0.5.2 公共接口，无需修改其源码；不能由此宣称所有 Hex 交互均可无源码适配。分面完整上游、更多指标 / 类型、精确 decimal / 时间戳 / DST、V2 落盘迁移、AI 新契约和看板快照仍待后续批次。
