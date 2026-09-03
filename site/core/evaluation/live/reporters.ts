import { assertLiveHarnessEvaluationReportSafe, type LiveHarnessEvaluationReport } from "./contracts";

export function formatLiveHarnessEvaluationJson(report: LiveHarnessEvaluationReport): string {
  assertLiveHarnessEvaluationReportSafe(report);
  return JSON.stringify(report, null, 2);
}

export function formatLiveHarnessEvaluationMarkdown(report: LiveHarnessEvaluationReport): string {
  assertLiveHarnessEvaluationReportSafe(report);
  const rows = report.cases.map((result) => (
    `| ${result.id}@${result.caseVersion} | ${result.passed ? "通过" : "失败"} | ${result.terminalState} | ${result.terminationCode} | ${result.toolSequence.join(" → ") || "—"} | ${result.modelCalls}/${result.toolCalls}/${result.retryCount} | ${result.promptTokens}/${result.completionTokens}/${result.totalTokens} | ${result.activeElapsedMs} ms |`
  ));
  const { limits, used, remaining } = report.budget;
  return [
    `# ${report.suiteId}@${report.suiteVersion}`,
    "",
    `- Git：${report.gitCommit}`,
    `- Provider / Model：${report.provider} / ${report.model ? `\`${report.model}\`` : "未记录"}`,
    `- 终止代码：${report.terminationCode}`,
    `- 用例：${report.cases.filter((item) => item.passed).length}/${report.cases.length} 通过`,
    `- 安全硬门：${report.hardGatesPassed ? "通过" : "失败"}`,
    `- 模型调用：${used.modelCalls}/${limits.maxModelCalls}（剩余 ${remaining.modelCalls}）`,
    `- Prompt tokens：${used.promptTokens}/${limits.maxPromptTokens}（剩余 ${remaining.promptTokens}）`,
    `- Completion tokens：${used.completionTokens}/${limits.maxCompletionTokens}（剩余 ${remaining.completionTokens}）`,
    `- Total tokens：${used.totalTokens}`,
    `- 主动耗时：${used.activeElapsedMs}/${limits.maxActiveElapsedMs} ms（剩余 ${remaining.activeElapsedMs} ms）`,
    "",
    "| 用例 | 结果 | 终态 | 终止代码 | 工具顺序 | 模型/工具/重试 | Prompt/Completion/Total | 主动耗时 |",
    "| --- | --- | --- | --- | --- | ---: | ---: | ---: |",
    ...rows,
  ].join("\n");
}
