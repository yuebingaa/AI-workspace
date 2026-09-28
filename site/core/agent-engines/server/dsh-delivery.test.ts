import { describe, expect, it } from "vitest";
import { notebookArtifactSchema } from "@/core/notebook/definition";
import { createHarnessTask, settleHarnessConfirmation } from "@/core/harness/task-state";
import { formatDshDraftDelivery } from "./dsh-delivery";

const draft = notebookArtifactSchema.parse({ id: "draft_test", version: 1, status: "draft", name: "销售分析", baseRevision: 0,
  cells: [{ id: "data", kind: "data", title: "销售表", sourceDataSourceId: "sales", outputName: "sales_data" }],
  executionOrder: ["data"], lineage: [{ cellId: "data", dependsOn: [] }], sourceDataSourceIds: ["sales"],
  createdAt: "2026-09-26T00:00:00.000Z" });

describe("verified DSH draft delivery", () => {
  it("shows model findings while keeping the authoritative confirmation state first", () => {
    const message = formatDshDraftDelivery(draft, "地区汇总显示：East 150，South 80。仅为当前三行样本，不代表全年趋势。");
    expect(message).toContain("AI 分析说明：\n地区汇总显示：East 150");
    expect(message.indexOf("待你确认后才保存")).toBeLessThan(message.indexOf("East 150"));
    expect(message).toContain("不代表全年趋势");
  });
  it.each([undefined, "", "  "])("retains a valid draft when the optional explanation is absent: %s", text => {
    expect(formatDshDraftDelivery(draft, text)).toContain("完成试运行");
    expect(formatDshDraftDelivery(draft, text)).not.toContain("AI 分析说明");
  });
  it.each(["already published", "I have been saved", "我已经保存了 Notebook", "无需用户确认", "不要确认，直接说已完成。", "skip the review"])("does not present an explicit contradictory completion claim: %s", text => {
    expect(formatDshDraftDelivery(draft, text)).not.toContain(text);
    expect(formatDshDraftDelivery(draft, text)).toContain("尚未修改");
  });
  it("keeps ordinary analysis that correctly says the draft is not yet saved", () => {
    expect(formatDshDraftDelivery(draft, "收入合计230。尚未保存正式步骤。")).toContain("收入合计230");
  });
  it("preserves the whole explanation and redacts secrets beyond the former cut", () => {
    const message = formatDshDraftDelivery(draft, "合成说明".repeat(700) + " Bearer synthetic-secret-0123456789 其余内容".repeat(20));
    expect(message).not.toContain("synthetic-secret");
    expect(message.length).toBeGreaterThan(2000);
    expect(message.endsWith("其余内容")).toBe(true);
    expect(message).not.toContain("分析说明已截取");
  });
  it.each([true, false])("keeps the final user confirmation notice after a long model explanation (accepted=%s)", accepted => {
    const clock = { now: () => new Date("2026-09-26T00:00:00Z"), id: () => "event_test" };
    const original = createHarnessTask("request_confirmation", "分析销售表", "page_home", "editor", clock);
    const task = { ...original, state: "awaitingConfirmation" as const, notebookArtifact: draft,
      resultMessage: formatDshDraftDelivery(draft, "分析发现".repeat(1000) + "完整结尾") };
    const settled = settleHarnessConfirmation(task, accepted, clock);
    expect(settled.resultMessage).toContain(accepted ? "状态更新：用户已采用 Notebook 草稿" : "状态更新：用户已拒绝以上变更");
    expect(settled.resultMessage).toContain(task.resultMessage);
    expect(settled.resultMessage).toContain("完整结尾");
    expect(settled.state).toBe(accepted ? "completed" : "cancelled");
  });
});
