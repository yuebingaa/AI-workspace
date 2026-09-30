# 统一可视化 B3：完整上游分面

日期：2026-09-29。源码 / 3001；未发布 3000。本批只扩展正式 Notebook 支持范围内的分面，不迁移项目格式、不新增 AI / 看板功能。

## 实现

- `core/visualization/definition.ts` / `result.ts` / `capabilities.ts` 增加独立分面编码，最多四个维度与五列结果；旧无分面数据 key 不变。
- `core/notebook/visualization.ts` 将已保存分面加入分组、排序、Tooltip 与完整计算；重复字段、不支持的值和日期粒度保留兼容提示，不静默改值。
- 适配器调用 GW 0.5.2 公共 normalize / PureRenderer，raw-only workflow 仍拒绝二次计算；未改 node_modules 或引入依赖。
- `adapters/facet-layout.ts` 与 `MaterializedChartCanvas` 保留可读单图尺寸、图内滚动；超过 36 个网格位置显示错误但保留完整图表数据，防止巨大稀疏笛卡尔网格，不截取结果。

## 验证

使用隔离合成销售数据与真实 Notebook / 项目接口，不读取用户项目、不调用付费模型。测试浏览器阻断站外请求；启动时的无关列表与 AI 设置响应隔离，Notebook 运行、导入及项目保存接口没有模拟。

### 数值与交互

- 2,500 行销售数据，季度 × 客户类型 × 地区 × 渠道生成 96 组求和结果；逐项与独立行级计算一致，不使用 100 行编辑预览计算正式图。
- 筛选企业客户后，32 组不等权平均值均从完整输入独立复算通过；没有对已聚合均值再次平均。
- 仅水平分面、仅垂直分面各 48 组，均逐项检查；恢复双向分面仍为 96 组。
- 真实页面完成字段拖拽 / 点击选择、季度、堆叠面积、暖橙配色、筛选与均值、取消不改写、空结果、保存 / 重开 / 重跑及 1024 px 内部滚动。
- 50 个客户分面触发明确绘图保护，600 行已计算结果仍可在图表数据中查看，导出不可用；没有裁成前 36 个。上限按横纵网格乘积，而不只按有数据的组合数量计算。
- PNG 实际导出并查看，完整包含 2 × 2 小图、中文分面标题、季度与客户类型图例。没有验证本批的实际悬浮提示交互，不据此声称已实现 Hex 联合 Tooltip。

### 命令与结果

- 最终 `npm test -- --maxWorkers=2`：**301 文件 / 3,786 项通过，1 文件 / 3 项跳过**；随后 **26 项 Node 工具测试通过**。其中 Harness 评测为 scripted mock，不是真实收费模型结果。
- 定向可视化 / Notebook / 回执测试：9 文件 / 138 项通过。随后新增的画布竞态测试 2 项通过；最后画布与能力探测测试合跑 2 文件 / 13 项通过。
- `npx tsc --noEmit`、本批改动代码定向 ESLint、`npm run build` 通过；构建保留既有大 chunk / 插件耗时提示。
- 架构正文、变更记录、提案进度、索引和视觉规范同步维护；源码指纹同步 / 检查 **268 文件一致**。未新增依赖，未修改 GW 源码或 node_modules。

### 中间失败与修正

1. 第一轮脚本使用了不存在的“暖色”选项，改为实际“暖橙”；取消按钮也按实际文案定位。这是脚本定位修正，不算产品验收成功。
2. 第二轮通过数值、单 / 双向分面、空结果及保护场景，重开后发现图已绘出但“正在绘制”不消失。此前计算状态身份包含尺寸 / 主题，旧绘制回调可覆盖新状态。现将数据就绪身份与布局身份分开，忽略过期数据回调，新增两项延迟回调回归；最终浏览器重跑全部通过。
3. 第一轮全量测试仅旧 `available-capabilities.test.ts` 的文件替换模拟失败：Windows 大 inode 以 JS number 表示时 `ino + 1` 可能仍等于原值。只把测试替身改为保证不同的 0 / 1 身份，生产文件校验逻辑未变；最终全量及单独 11 项能力测试通过。

初次脚本失败证据：[browser-1790670918330](../../.runtime/visualization-notebook-20260929/browser-1790670918330/report.json)；加载竞态失败证据：[browser-1790670984141](../../.runtime/visualization-notebook-20260929/browser-1790670984141/report.json)。没有用失败轮截图替代最终验收。

## 实际截图

[最终 B3 机器报告](../../.runtime/visualization-notebook-20260929/browser-1790671125376/report.json)：12 张本轮正式 Notebook 页面截图及 PNG 导出均已实际查看；无页面异常 / 越界请求。隔离项目保留于同目录 `project/`，未覆盖用户项目。

| 场景 | 截图 / 验收 |
| --- | --- |
| 左侧配置与有限预览 | [14 编辑](../../.runtime/visualization-notebook-20260929/browser-1790671125376/14-facets-inline-preview.png)，水平点击 / 垂直拖拽，明确预览范围 |
| 正式双向分面 | [15 面积图](../../.runtime/visualization-notebook-20260929/browser-1790671125376/15-facets-formal-area.png)，完整上游 2,500 → 96 |
| 计算结果 | [16 数据表](../../.runtime/visualization-notebook-20260929/browser-1790671125376/16-facets-result-table.png)，96 行、5 列 |
| 取消编辑 | [17 取消](../../.runtime/visualization-notebook-20260929/browser-1790671125376/17-facets-cancel.png)，项目定义未改写 |
| 筛选 / 聚合 | [18 均值](../../.runtime/visualization-notebook-20260929/browser-1790671125376/18-facets-filtered-mean.png)，完整输入计算 |
| 空结果 | [19 空状态](../../.runtime/visualization-notebook-20260929/browser-1790671125376/19-facets-empty.png)，明确调整筛选提示 |
| 水平单向 | [20 横向](../../.runtime/visualization-notebook-20260929/browser-1790671125376/20-horizontal-only.png)，两列 |
| 垂直单向 | [21 纵向](../../.runtime/visualization-notebook-20260929/browser-1790671125376/21-vertical-only.png)，两行 |
| 过大网格 | [22 保护](../../.runtime/visualization-notebook-20260929/browser-1790671125376/22-facet-grid-guard.png)，明确错误、仍可查看完整表 |
| 保存重开 | [23 恢复](../../.runtime/visualization-notebook-20260929/browser-1790671125376/23-facets-restored.png)，配置不丢失、运行后不滞留加载态 |
| 窄屏 | [24 初始](../../.runtime/visualization-notebook-20260929/browser-1790671125376/24-facets-1024.png) / [25 内部滚动](../../.runtime/visualization-notebook-20260929/browser-1790671125376/25-facets-1024-scrolled.png)，不撑出整页 |

[完整 2 × 2 PNG 导出](../../.runtime/visualization-notebook-20260929/browser-1790671125376/facets-export.png)。

另重新执行原 B2 非分面主流程：[报告](../../.runtime/visualization-notebook-20260929/browser-1790671236143/report.json)通过，覆盖 1,250 行完整计算、24 组结果及旧兼容组合；这轮 11 张附带截图未逐张人工复看，仅作为自动回归证据，不计入上述 12 张视觉验收。本轮未重跑独立旧图浏览器专项。

## 使用与剩余差异

- 入口：`http://127.0.0.1:3001` → Notebook → 图表编辑 → Data → 水平 / 垂直分面，选择独立维度后保存并运行图表。已有分面定义不需要格式迁移，支持组合运行时自动进入完整计算。
- 正式画布保留当前固定区域高度，大分面在图内滚动；2 × 2 图在部分窗口需要纵向滚动才能看全，不是 Hex 全画幅像素复刻。导出包含完整网格。
- 本批不支持重复通道字段、NULL / 数字 / 布尔分面及周粒度的新计算适配，仍明确提示兼容路径；其他复杂筛选、百分比堆叠、多指标、精确 decimal / 时间戳 / DST 边界不变。
- 未实现 V2 落盘与旧客户端拒写、AI 新专用图表协议、看板快照；不将这批称为整个统一可视化方案完成。当前功能无需进一步改 GW 源码；联合 Tooltip 等后续功能仍需单独验证其公开扩展能力。
- 源码与 3001 已启用，未发布 3000；无模型 / 外部实库调用，无提交 / 推送 / 合并、用户数据删除或服务启停。16:30 与 16:43 服务检查中 3000 / 3001 / 3198 均健康，PID / revision / 重启数不变。保留全部既有未提交修改。
