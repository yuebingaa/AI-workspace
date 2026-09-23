import { StudioValidationError } from "@/core/schemas";

const submissionMessages = {
  notebook_submit_version_stale: "草稿版本已变化，请先 CellSearch 读取最新 editVersion。",
  notebook_submit_no_changes: "尚未修改任何单元。",
  notebook_submit_run_required: "当前草稿尚未完整试运行通过，请先修正并运行单元。",
  notebook_submit_receipt_mismatch: "执行回执与本次草稿不一致，不能作为验证证据。",
} as const;

/** Submission guards keep their existing validation category and internal message. */
export class NotebookSubmissionError extends StudioValidationError {
  constructor(readonly code: keyof typeof submissionMessages) {
    super("Notebook 单元操作失败", [submissionMessages[code]]);
    this.name = "NotebookSubmissionError";
  }
}
