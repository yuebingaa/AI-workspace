# 架构文档入口

最后核对：2026-09-29。**文档中的“设计”“规划”不等于源码已实现，也不等于已发布 3000。**

## 当前维护入口

- [Agent 架构](./agent-architecture.md)：当前模块、接口、运行开关、能力边界与变更记录的唯一维护入口；修改 Agent / Notebook 接入后更新正文并检查源码指纹。
- [运行与发布约定](../../STABLE-RUNTIME.md)：3000 / 3001 / 截图服务、构建与恢复规则。
- [当前视觉规范](../visual-design.md)：实际界面状态和浏览器验收入口。
- [任务日志](../../../TASK-LOG.md)：每批实际修改、测试、截图和发布状态；不能用历史测试代替本轮验证。

## 待实施与分批推进

- [图表与分析结果统一架构方案](./visualization-unification-proposal-2026-09-29.md)：主线专项。A 阅读、B1 核心、B2 运行桥接、B3 独立分面之后，[B4 官方编辑 / AI 作者契约](../verification/native-notebook-chart-2026-09-29.md)接入 Notebook。支持的配置保存后使用完整上游计算；V2 持久化迁移、多指标与看板仍待实施。
- [Hex 可视化研究](./hex-visualization-research.md)、[可视化 Agent 设计](./visualization-agent-design.md)、[语义层设计](./semantic-layer-design.md)、[Hex 对齐路线](./hex-alignment-roadmap.md)：专题研究 / 阶段方案，其中已有实现须回到主文档与对应验收核实，不按文件名推断今天的完成度。新统一图表方案优先于旧可视化候选建议。

## 历史参考（保留，不作为当前架构图）

- [2026-09-11 系统框图](./current-system-architecture.md)及同名 SVG / PNG：文件名虽然带 `current`，内容是 **9 月 11 日快照**，未覆盖后续 DSH 和可视化改造；不拿旧导出图证明当前接线。
- [9 月 14 日重构](./refactor-2026-09-14.md)、[持久化重构](./persistence-refactor-2026-09-14.md)、[Notebook 重构](./notebook-refactor-2026-09-14.md)：历史阶段记录，保留原链接和日期。

本次没有删除、搬动或重命名历史文件，也没有绘制冒充当前实现的新总图。后续确需新图时从主文档的实际实现生成。
