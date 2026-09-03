import type { HarnessEvaluationReport } from "./contracts";

function percent(value: number | null): string {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

export function formatHarnessEvaluationJson(report: HarnessEvaluationReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatHarnessEvaluationMarkdown(report: HarnessEvaluationReport): string {
  const rows = report.cases.map((result) => (
    `| ${result.id} | ${result.passed ? "通过" : "失败"} | ${result.terminalState} | ${result.toolSequence.join(" → ") || "—"} | ${result.scores.total.toFixed(1)} |`
  ));
  return [
    `# ${report.suiteId}`,
    "",
    `> ${report.disclaimer}`,
    "",
    `- 用例：${report.summary.passed}/${report.summary.total} 通过`,
    `- 简单任务成功率：${percent(report.summary.simpleTaskSuccessRate)}`,
    `- 复杂任务成功率：${percent(report.summary.complexTaskSuccessRate)}`,
    `- 工具精确率 / 召回率：${percent(report.summary.toolPrecision)} / ${percent(report.summary.toolRecall)}`,
    `- ChangeSet Schema 合规率：${percent(report.summary.changeSetSchemaComplianceRate)}`,
    `- 安全硬门失败：${report.summary.hardGateFailures}`,
    `- 输入字符 / token：${report.usage.inputChars} / ${report.usage.totalTokens}`,
    "",
    "| 用例 | 结果 | 终态 | 工具顺序 | 得分 |",
    "| --- | --- | --- | --- | ---: |",
    ...rows,
  ].join("\n");
}
