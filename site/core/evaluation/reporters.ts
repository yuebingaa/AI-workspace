import type { HarnessEvaluationReport } from "./contracts";

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatHarnessEvaluationJson(report: HarnessEvaluationReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatHarnessEvaluationMarkdown(report: HarnessEvaluationReport): string {
  const rows = report.cases.map((result) => (
    `| ${result.id} | ${result.passed ? "通过" : "失败"} | ${result.terminalState} | ${result.terminationCode} | ${result.toolSequence.join(" → ") || "—"} | ${result.scores.total.toFixed(1)} |`
  ));
  const categoryRows = Object.values(report.summary.categories).map((category) => (
    `| ${category.category} | ${category.total} | ${category.passed} | ${category.failed} | ${percent(category.successRate)} |`
  ));
  return [
    `# ${report.suiteId}`,
    "",
    `> ${report.disclaimer}`,
    "",
    `- 用例：${report.summary.passed}/${report.summary.total} 通过`,
    `- 简单任务成功率：${percent(report.summary.simpleTaskSuccessRate)}`,
    `- 复杂任务成功率：${percent(report.summary.complexTaskSuccessRate)}`,
    `- 正确阻塞率 / 错误完成率：${percent(report.summary.correctBlockedRate)} / ${percent(report.summary.erroneousCompletedRate)}`,
    `- 首工具准确率：${percent(report.summary.firstToolAccuracy)}`,
    `- 工具精确率 / 召回率：${percent(report.summary.toolPrecision)} / ${percent(report.summary.toolRecall)}`,
    `- 工具顺序精确率 / 顺序分：${percent(report.summary.sequenceExactRate)} / ${percent(report.summary.sequenceScore)}`,
    `- ChangeSet Schema 合规率 / 目标准确率：${percent(report.summary.changeSetSchemaComplianceRate)} / ${percent(report.summary.changeSetTargetAccuracy)}`,
    `- 非法操作拦截率：${percent(report.summary.illegalOperationBlockRate)}`,
    `- AppSpec 意外修改率 / 泄露率：${percent(report.summary.unexpectedAppSpecMutationRate)} / ${percent(report.summary.leakageRate)}`,
    `- 质量分：${report.summary.qualityScore.toFixed(1)} / 100`,
    `- 安全硬门：${report.summary.hardGatesPassed ? "通过" : "失败"}`,
    `- 安全硬门失败：${report.summary.hardGateFailures}`,
    `- 输入字符 / token：${report.usage.inputChars} / ${report.usage.totalTokens}`,
    "",
    "## 分类汇总",
    "",
    "| 分类 | 总数 | 通过 | 失败 | 成功率 |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...categoryRows,
    "",
    "## 用例结果",
    "",
    "| 用例 | 结果 | 终态 | 终止代码 | 工具顺序 | 得分 |",
    "| --- | --- | --- | --- | --- | ---: |",
    ...rows,
  ].join("\n");
}
