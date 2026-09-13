import type { AppNode, AppSpec } from "@/core/models";
import type { HarnessTaskSummary } from "@/core/harness/contracts";
import { createExecutionState, previewChangeSet } from "@/core/changesets";
import { executeChartBinding } from "@/core/data";
import { demoLocalDataRuntime, retailOrderRows, retailOrdersDataSource } from "@/fixtures/retail-orders";
import { createLabAppSpec, LAB_PAGE_ID, type VisualizationCase } from "./cases";

export interface LabCheck { id: string; label: string; status: "passed" | "failed" | "manual"; detail: string }
export interface LabEvaluation { checks: LabCheck[]; preview?: AppSpec; chartIds: string[] }
export function chartNodes(node: AppNode): Array<Extract<AppNode, { type: "BarChart" }>> {
  return [...(node.type === "BarChart" ? [node] : []), ...(node.children ?? []).flatMap(chartNodes)];
}

export function evaluateLabTask(task: HarnessTaskSummary, testCase?: VisualizationCase): LabEvaluation {
  const checks: LabCheck[] = [];
  const check = (id: string, label: string, passed: boolean, detail: string) => checks.push({ id, label, status: passed ? "passed" : "failed", detail });
  check("receipt", "生成回执", task.state === "awaitingConfirmation" && Boolean(task.pendingChangeSet),
    task.pendingChangeSet ? `Agent 返回状态：${task.state}` : "没有收到可渲染的图表变更预览。");
  const result: LabEvaluation = { checks, chartIds: [] };
  if (!task.pendingChangeSet) return result;
  try {
    if (task.pageId !== LAB_PAGE_ID || task.pendingChangeSet.operations.some((op) => op.pageId !== LAB_PAGE_ID || op.type === "addPage" || op.type === "deletePage")) {
      throw new Error("结果修改了测试画布以外的页面。");
    }
    const candidate = previewChangeSet(createExecutionState(createLabAppSpec()), task.pendingChangeSet, task.role).preview!.appSpec;
    const charts = chartNodes(candidate.pages[0].root);
    check("structure", "图表结构", charts.length === 1, `预览中有 ${charts.length} 张图表；本轮要求一张。`);
    result.preview = candidate;
    result.chartIds = charts.map((node) => node.id);
    for (const chart of charts) {
      const binding = chart.props.binding;
      const output = executeChartBinding(binding, candidate.dataSources, demoLocalDataRuntime);
      const numeric = output.values.length > 0 && output.values.every(Number.isFinite);
      check(`data-${chart.id}`, "真实数据计算", numeric, `从示例数据计算 ${output.values.length} 个数值，没有使用模型手写数据。`);
      if (!testCase?.expected) continue;
      const expected = testCase.expected;
      check(`type-${chart.id}`, "图表类型", expected.types.includes(chart.props.chartType ?? "bar"), `实际：${chart.props.chartType ?? "bar"}；本题接受：${expected.types.join(" / ")}`);
      check(`binding-${chart.id}`, "指标与分组", binding.dataSourceId === retailOrdersDataSource.id && binding.field === "revenue"
        && binding.aggregation === "sum" && binding.groupBy === expected.groupBy && binding.filters.length === 0,
      `应使用全部示例数据，按 ${expected.groupBy} 分组，对 revenue 求和。`);
      // Independent aggregation oracle: do not derive expected values from the candidate's binding.
      const totals = new Map<string, number>();
      for (const row of retailOrderRows) {
        const key = expected.groupBy === "month" ? `${Number.parseInt(String(row.month), 10)}月` : String(row[expected.groupBy]);
        totals.set(key, (totals.get(key) ?? 0) + Number(row.revenue));
      }
      const exact = output.labels.length === totals.size && new Set(output.labels).size === totals.size
        && output.labels.every((label, i) => totals.has(label) && Math.abs(output.values[i] - totals.get(label)!) <= Math.max(1, Math.abs(totals.get(label)!)) * 1e-9);
      check(`values-${chart.id}`, "数值与完整覆盖", exact, `与独立汇总的 ${totals.size} 个分组逐项比较，检查遗漏和数值偏差。`);
      if (expected.order !== "any") {
        const ordered = expected.order === "month" ? output.labels.every((label, i) => i === 0 || Number.parseInt(label, 10) > Number.parseInt(output.labels[i - 1], 10))
          : output.values.every((value, i) => i === 0 || value <= output.values[i - 1]);
        check(`order-${chart.id}`, "排列顺序", ordered, expected.order === "month" ? "月份从 01 月到 12 月递增。" : "收入从高到低排列。");
      }
    }
  } catch (error) {
    check("invalid", "预览有效性", false, error instanceof Error ? error.message : "无法校验预览。");
    result.preview = undefined;
    result.chartIds = [];
  }
  checks.push({ id: "meaning", label: testCase?.expected ? "视觉与表达" : "需求与视觉", status: "manual",
    detail: testCase?.expected ? "请查看标题、单位、标签、配色与窄屏效果；规则通过不代表视觉质量通过。" : "自定义指令没有标准答案；仅检查结构和可计算性，需求符合度由人工评定。" });
  return result;
}
