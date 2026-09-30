# Notebook 图表配置常驻（B5）

日期：2026-09-29。用户指出 B4 仍默认只显示运行图，保存后隐藏编辑区，未满足“像截图那样始终显示左侧”的要求。本批修正宿主交互，而非继续更换绘图库。

## 实现与实际边界

- 新 `NotebookChartWorkspace` 直接复用图 3 / 4 的既有 Data / Style `ChartEditor`，在 Notebook 默认挂载字段库、配置和 GW 画布；可切换 B4 官方原生编辑器。Data / Style 是本站已存在的适配面板，不是官方原生 UI；本批不再另造面板。
- 修改 `NotebookPanel`、`NotebookChartEditor`、`NotebookLivePreview`：支持的图不再依赖“编辑图表”按钮才展开，保存、运行、放弃、刷新均保留编辑区。AI 实时草稿沿用同一布局但只读；成功上游到达后更新，不保存草稿或调用模型。旧多指标、饼环仍走兼容入口。
- dirty 才占用编辑锁，防止常驻面板令全本不能运行；修改期间其他图只读，保存 / 放弃后释放。无效轴拒存、取消有确认、切换布局前须处理修改。重置 / 外部单元更新按已保存定义重建，不覆盖其他单元。
- 新 CSS 独立命名，修正验收时发现的旧工作台类名冲突；窄窗口内部滚动、不自动隐藏字段库。手动“收起字段库”仍可用。
- 编辑器使用当前返回上游的有限预览；完整上游计算、校验后的正式结果保留在下方折叠区，不把编辑预览伪称全量。没有新增自动执行、模型 / 数据库权限、存储格式或依赖。本轮不重启 / 发布服务，不再等待 B4 Tooltip 补丁而阻塞本次 UI 修正。

## 验证记录

浏览器脚本：`scripts/verify-notebook-chart-workspace.mjs`，受管 3001、独立 Edge、隔离本地项目，48 行中文标签的模拟季度销售。模型及非测试项目写入被阻断；Notebook 运行和项目保存使用真实 API。完整运行 24 个“季度 × 客户类型”的 SUM，逐项与原始模拟公式核对；未读取用户业务数据。

首轮失败为测试把中文显示标签误当内部字段 ID（CSV 使用 field_3），修正断言。第二轮交互通过但截图发现旧 CSS 将布局栏挤成额外一列，已隔离类名并增加计算样式断言，不能用那轮图片冒充最终视觉验收。后续复查又发现上游重新运行后仍有“请先运行”旧错误提示：`ChartEditor` 错误现在只属于失败时的数据快照，新数据到达后移除过期提示、保留未保存配置；`ChartCanvas` 区分等待上游与筛选空结果。

最终 [浏览器报告](../../.runtime/notebook-chart-workspace-20260929/browser-1790684752390/report.json)通过，页面异常 / 越界请求均为 0。以下 10 张均逐张实际查看，不使用设计稿或旧批次图片：

| 场景 | 截图与结论 |
| --- | --- |
| 保存 | [01](../../.runtime/notebook-chart-workspace-20260929/browser-1790684752390/01-saved-editor-still-expanded.png)：字段库与配置不收起 |
| 真实运行 | [02](../../.runtime/notebook-chart-workspace-20260929/browser-1790684752390/02-run-keeps-field-library-and-config.png)：左配置、右面积图，48 行生成 24 组逐项 SUM 正确；另展开正式结果验证完成计算 |
| 筛选与分面 | [03](../../.runtime/notebook-chart-workspace-20260929/browser-1790684752390/03-filter-and-facet-preview.png)：拖拽颜色、点击选字段、筛选与水平分面均更新预览 |
| 放弃修改 | [04](../../.runtime/notebook-chart-workspace-20260929/browser-1790684752390/04-discard-confirmation.png)：继续编辑保留修改，确认放弃恢复配置，不隐藏编辑区 |
| 无效组合 | [05](../../.runtime/notebook-chart-workspace-20260929/browser-1790684752390/05-invalid-axis-refused.png)：非数值 Y 拒存，撤销可恢复；dirty 禁止运行与布局切换 |
| 官方布局 | [06](../../.runtime/notebook-chart-workspace-20260929/browser-1790684752390/06-official-layout-available.png)：官方组件可切换，未删除原生字段与配置面板 |
| 刷新恢复 | [07](../../.runtime/notebook-chart-workspace-20260929/browser-1790684752390/07-reopen-default-panels-no-stale-data.png)：默认恢复左面板，明确等待上游，不使用旧结果 |
| 重新运行 | [08](../../.runtime/notebook-chart-workspace-20260929/browser-1790684752390/08-reopened-and-rerun.png)：恢复当前数据，清除失效报错，配置保留 |
| 窄窗口 | [09](../../.runtime/notebook-chart-workspace-20260929/browser-1790684752390/09-narrow-keeps-left-panels.png)：1024 px 仍保留两列配置，横向溢出限制在编辑器内 |
| 两张图隔离 | [10](../../.runtime/notebook-chart-workspace-20260929/browser-1790684752390/10-second-chart-focus-and-lock.png)：修改第二张不抢第一张焦点、不改第一张配置，放弃后释放锁 |

自动检查：全量 `npm test -- --maxWorkers=2` 305 文件 / **3,799 项通过**，1 文件 / 3 项既有跳过；随后 26 项 Node 工具测试通过。该全量启动后补充了错误提示 / 等待态修正及一条刷新回归，因此最终版本另跑 Notebook 定向 5 文件 / **19 项通过**、chart-editor / GW 定向 7 文件 / **34 项通过**。最终类型检查、生产构建及本批文件定向 ESLint 通过；大 chunk / 构建插件耗时警告仍在。未将 mock Harness 评测算作真实模型调用。

源码热更新于 3001 验收；未发布 3000，未操作服务进程、调用收费模型 / 实库、修改依赖、提交 / 推送 Git 或删除用户数据。截图及隔离模拟项目保留在本机 `.runtime`，不声称已上传 GitHub。架构正文与视觉规范同步维护。

## 与参考图的差异

本批复用用户图 3 / 4 现有编辑器，不是 Hex 像素级复刻；Notebook 有大纲、上游选择及保存条，编辑器是 720 px 高内部滚动。1024 px 且聊天侧栏展开时需内部横向滚动画布，左侧不再自动消失。保存仍需明确点击，完整数据结果需运行；多指标和更多官方配置无损持久化没有在本轮扩展。

B4 固定 GW 0.5.2 的 Tooltip 索引补丁已存在，仍待允许重启后验收运行站缓存，本轮没有再次修改 GW 源码。AI 实时草稿的只读常驻外形新增回归测试，不把本轮不调用模型的 UI 验收说成真实付费模型端到端。
