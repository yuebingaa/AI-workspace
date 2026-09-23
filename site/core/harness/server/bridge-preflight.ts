import { StudioValidationError } from "@/core/schemas/errors";

const messages = Object.freeze({
  missing_notebook_context: "本次请求缺少 Notebook 上下文，请先打开或选择要分析的 Notebook。",
  unsupported_task_context: "本次上下文包含当前工具桥尚未支持的能力，请移除不相关上下文或使用支持该能力的执行器。",
  unsupported_csv_profile: "当前 CSV 试点仅支持单个本地 CSV 数据源及受支持的 Notebook 单元。",
  source_unavailable: "选中数据源未通过范围、授权或可用性检查，请重新选择可访问的数据源。",
  semantic_model_unavailable: "语义模型未选择、版本或来源不匹配，或模型及单元定义无效。请在当前数据表选择对应模型，并检查语义单元引用；本次尚未调用模型分析。",
  workbook_context_mismatch: "本次工作簿附件与服务端清单不一致或不完整，请重新添加原件。",
  missing_data_context: "本次请求没有可用的数据源、工作簿附件或已授权连接，请先添加分析来源。",
  workspace_unavailable: "当前工作界面不可用，请重新选择工作界面。",
  notebook_cell_unsupported: "当前 Notebook 包含本次工具桥尚未支持的单元类型。",
  notebook_reference_unavailable: "Notebook 单元引用的来源、连接或原件未在本次请求中可用，请检查引用与授权。",
  python_unavailable: "当前部署未启用所需的 Python 能力，不能执行该 Notebook。",
});

export type NotebookBridgePreflightCode = keyof typeof messages;

/** Construct only at an identified bridge-initialization guard, not runtime tool failures. */
export class NotebookBridgePreflightError extends StudioValidationError {
  constructor(readonly code: NotebookBridgePreflightCode) {
    if (!Object.hasOwn(messages, code)) throw new Error("Notebook 初始化诊断代码无效。");
    super("Notebook 工具桥拒绝请求", [messages[code]]);
    this.name = "NotebookBridgePreflightError";
  }
}

/** Do not trust exception names, arbitrary messages, issues or additional metadata. */
export function notebookBridgePreflightMessage(error: unknown): string | undefined {
  if (!(error instanceof NotebookBridgePreflightError) || typeof error.code !== "string"
    || !Object.hasOwn(messages, error.code)) return;
  return `Notebook 初始化检查未通过（${error.code}）：${messages[error.code]}`;
}
