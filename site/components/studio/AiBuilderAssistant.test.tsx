import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { appendHarnessEvent, createHarnessTask, type HarnessTaskSummary } from "@/core/harness";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { AiBuilderAssistant, type AiRequestUiStatus } from "./AiBuilderAssistant";

const clock = {
  now: () => new Date("2026-09-02T03:00:00.000Z"),
  id: () => "assistant_ui_event",
};

function task(state: "blocked" | "failed" | "completed"): HarnessTaskSummary {
  const base = createHarnessTask("assistant_ui_task", "测试 Harness UI", "page_home", "editor", clock);
  return appendHarnessEvent(base, {
    type: state === "failed" ? "error" : "state",
    state,
    message: state === "blocked" ? "缺少外部能力。" : state === "failed" ? "执行异常。" : "Excel 已生成。",
  }, clock, state === "completed" ? {
    resultMessage: "Excel 已生成。",
    exportArtifact: {
      id: "assistant_excel_artifact_001",
      status: "ready",
      fileName: "华东异常订单.xlsx",
      downloadUrl: "/api/exports/assistant_excel_artifact_001",
      rowCount: 4,
      fieldCount: 6,
      sizeBytes: 4096,
      createdAt: "2026-09-02T03:00:00.000Z",
      expiresAt: "2026-09-02T03:10:00.000Z",
    },
  } : { error: state === "blocked" ? "缺少外部能力。" : "执行异常。" });
}

function render(status: AiRequestUiStatus, harnessTask: HarnessTaskSummary, requestError: string | null, dataAnalysisMode = false) {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return renderToStaticMarkup(<AiBuilderAssistant
    pageTitle="客户洞察"
    datasetName="retail_orders"
    changeSet={demoFixtureResult.data.repurchaseChangeSet}
    status="pending"
    validationError={null}
    canApply
    canPreview={false}
    auditRecords={[]}
    aiMessage="测试消息"
    aiMetadata={null}
    instruction="测试指令"
    requestStatus={status}
    requestError={requestError}
    canRetry={false}
    harnessTask={harnessTask}
    harnessTaskCount={1}
    dataAnalysisMode={dataAnalysisMode}
    onInstructionChange={() => {}}
    onGenerate={() => {}}
    onCancelRequest={() => {}}
    onRetry={() => {}}
    onPreview={() => {}}
    onApply={() => {}}
    onCancelPreview={() => {}}
  />);
}

describe("AI 助手 Harness 状态", () => {
  it("blocked 使用黄色任务受限提示，failed 才显示红色失败提示", () => {
    const blocked = render("blocked", task("blocked"), "缺少外部能力。");
    const failed = render("error", task("failed"), "执行异常。");
    expect(blocked).toContain("blocked-warning");
    expect(blocked).toContain("任务受限/缺少能力");
    expect(blocked).not.toContain("AI 生成失败");
    expect(failed).toContain("AI 生成失败");
    expect(failed).not.toContain("blocked-warning");
  });

  it("完成导出后显示明确的 Excel 下载按钮", () => {
    const completed = render("success", task("completed"), null);
    expect(completed).toContain("下载 Excel");
    expect(completed).toContain("/api/exports/assistant_excel_artifact_001");
    expect(completed).toContain("华东异常订单.xlsx");
  });

  it("EDS 上下文显示只读 AI 数据分析模式和隐私边界", () => {
    const html = render("success", task("completed"), null, true);
    expect(html).toContain("AI 数据分析助手");
    expect(html).toContain("EDS 派生汇总只读分析模式");
    expect(html).toContain("不会获得原始工作簿或逐行明细");
    expect(html).toContain("比较白班和夜班的异常差异");
  });
});
