import { describe, expect, it } from "vitest";
import { formatLiveHarnessEvaluationJson, formatLiveHarnessEvaluationMarkdown } from "./reporters";
import { runLiveHarnessEvaluation } from "./harness-live-runner";

describe("手动 Live DeepSeek Harness 评测", () => {
  it("仅在双重门禁下串行执行固定三用例", async () => {
    const report = await runLiveHarnessEvaluation();
    process.stdout.write(`\nHARNESS_LIVE_EVALUATION_JSON\n${formatLiveHarnessEvaluationJson(report)}\n\nHARNESS_LIVE_EVALUATION_MARKDOWN\n${formatLiveHarnessEvaluationMarkdown(report)}\n`);
    expect(report.passed).toBe(true);
    expect(report.hardGatesPassed).toBe(true);
  });
});
