import type { HarnessToolName, HarnessToolExecutionResult } from "../contracts";
import type { HarnessToolContext, HarnessToolDefinition } from "./contracts";
import type { NotebookCapabilities } from "@/core/notebook/capabilities";
import { isNotebookCellCapabilityEnabled, notebookCapabilityMutationIssue, DEFAULT_NOTEBOOK_CAPABILITIES, notebookCapabilityReason } from "@/core/notebook/capabilities";
import { harnessNotebookDraftSchema } from "../notebook-contracts";
import { harnessToolRegistry } from "./registry";
import { StudioValidationError } from "@/core/schemas/errors";
import { sanitizeHarnessText, jsonByteLength } from "../security";
import { studioCapabilities } from "@/core/permissions";
import { summarizeToolArgumentIssues } from "../tool-schema";
import { HarnessToolArgumentsError } from "./errors";
import { cellSearchTool, editNotebookCellsTool, createPythonCellTool, getKernelPackagesInfoTool, runNotebookCellsTool, submitNotebookDraftTool, createAnalysisPlan, createNotebookDraft, inspectConnectionSchema } from "./notebook";
import { analyzeEdsReports, scanEdsRawWorkbook, queryEdsRawWorkbook, inspectEdsRawWorkbook, readEdsRawRows } from "./workbook";
import { inspectDataset, inspectFields, transformSpreadsheetData, previewDataRecipe, validateDataRecipe, exportDataRecipeToExcel } from "./dataset";
import { querySemanticModel } from "./semantic";
import { inspectAppSpec, createEdsBreakdownChartPreview, createEdsLineIssueChartPreview, updateEdsTablePreview, createChangeSetPreview } from "./dashboard";
import { callMcpTool } from "./external";
import { compactHarnessToolResult, MAX_HARNESS_TOOL_RESULT_BYTES, DEFAULT_HARNESS_TOOL_RESULT_ENTRIES } from "./observation";

function harnessToolRequestsPython(name: HarnessToolName, args: unknown): boolean {
  if (name === "createPythonCell" || name === "getKernelPackagesInfo") return true;
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const candidate = args as { cells?: unknown; steps?: unknown };
  const entries = Array.isArray(candidate.cells) ? candidate.cells : Array.isArray(candidate.steps) ? candidate.steps : [];
  return entries.some((entry) => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)
    && (entry as { kind?: unknown }).kind === "python"));
}

function disabledNotebookMutationIssue(
  name: HarnessToolName,
  args: unknown,
  context: HarnessToolContext,
  capabilities: NotebookCapabilities,
): string | undefined {
  if (isNotebookCellCapabilityEnabled(capabilities, "python")) return undefined;
  const current = context.notebookCellSession?.document.cells
    ?? context.request.notebookContext?.document.cells
    ?? [];
  const lockedIds = new Set(current.filter((cell) => !isNotebookCellCapabilityEnabled(capabilities, cell.kind))
    .map((cell) => cell.id));
  if (name === "createNotebookDraft") {
    const draft = harnessNotebookDraftSchema.safeParse(args);
    if (draft.success) return notebookCapabilityMutationIssue(capabilities, current, draft.data.cells);
  }
  if (name === "editNotebookCells" && args && typeof args === "object" && !Array.isArray(args)) {
    const value = args as { cells?: unknown; removeCellIds?: unknown };
    const removed = new Set(Array.isArray(value.removeCellIds) ? value.removeCellIds : []);
    const upserts = Array.isArray(value.cells) ? value.cells : [];
    if ([...lockedIds].some((id) => removed.has(id)
      || upserts.some((cell) => Boolean(cell && typeof cell === "object" && !Array.isArray(cell)
        && (cell as { id?: unknown }).id === id)))) {
      return "能力关闭期间不能通过 Agent 修改或移除已有 Python 单元；原配置与依赖必须保留。";
    }
  }
  if (["runNotebookCells", "submitNotebookDraft"].includes(name) && lockedIds.size) {
    return "当前草稿含有已关闭的 Python 单元，不能由 Agent 试运行或提交整稿；请手动处理独立分支，或恢复 Python 能力。";
  }
  return undefined;
}

export async function executeHarnessTool(
  rawName: string,
  rawArguments: unknown,
  context: HarnessToolContext,
): Promise<HarnessToolExecutionResult> {
  if (!(rawName in harnessToolRegistry)) {
    throw new StudioValidationError("Harness 工具校验失败", [`不允许调用工具：${sanitizeHarnessText(rawName, "未知工具")}`]);
  }
  const name = rawName as HarnessToolName;
  const tool = harnessToolRegistry[name];
  if (tool.mode === "changePreview" && !studioCapabilities[context.request.role].updateNodeProps) {
    throw new StudioValidationError("Harness 工具权限校验失败", [`${context.request.role} 无权生成修改型工具预览`]);
  }
  const run = async <Args>(definition: HarnessToolDefinition<HarnessToolName, Args>) => {
    const parsed = definition.schema.safeParse(rawArguments);
    if (!parsed.success) {
      const issueSummary = summarizeToolArgumentIssues(parsed.error.issues);
      throw new HarnessToolArgumentsError(name, issueSummary);
    }
    const capabilities = context.notebookCapabilities ?? DEFAULT_NOTEBOOK_CAPABILITIES;
    if (!isNotebookCellCapabilityEnabled(capabilities, "python") && harnessToolRequestsPython(name, parsed.data)) {
      throw new StudioValidationError("Notebook 能力已关闭", [
        notebookCapabilityReason(capabilities, "python") ?? "Python Notebook 能力已关闭",
        "已有 Python 单元定义会保留，但当前任务不能创建、编辑、检查运行环境或执行 Python。",
      ]);
    }
    const mutationIssue = disabledNotebookMutationIssue(name, parsed.data, context, capabilities);
    if (mutationIssue) {
      throw new StudioValidationError("Notebook 能力已关闭", [
        mutationIssue,
        notebookCapabilityReason(capabilities, "python") ?? "Python Notebook 能力已关闭",
      ]);
    }
    return definition.execute(parsed.data, context);
  };
  const result = await (() => {
    switch (name) {
      case "cellSearch": return run(cellSearchTool);
      case "editNotebookCells": return run(editNotebookCellsTool);
      case "createPythonCell": return run(createPythonCellTool);
      case "getKernelPackagesInfo": return run(getKernelPackagesInfoTool);
      case "runNotebookCells": return run(runNotebookCellsTool);
      case "submitNotebookDraft": return run(submitNotebookDraftTool);
      case "analyzeEdsReports": return run(analyzeEdsReports);
      case "scanEdsRawWorkbook": return run(scanEdsRawWorkbook);
      case "queryEdsRawWorkbook": return run(queryEdsRawWorkbook);
      case "inspectEdsRawWorkbook": return run(inspectEdsRawWorkbook);
      case "readEdsRawRows": return run(readEdsRawRows);
      case "inspectDataset": return run(inspectDataset);
      case "querySemanticModel": return run(querySemanticModel);
      case "createAnalysisPlan": return run(createAnalysisPlan);
      case "createNotebookDraft": return run(createNotebookDraft);
      case "inspectConnectionSchema": return run(inspectConnectionSchema);
      case "inspectFields": return run(inspectFields);
      case "transformSpreadsheetData": return run(transformSpreadsheetData);
      case "previewDataRecipe": return run(previewDataRecipe);
      case "validateDataRecipe": return run(validateDataRecipe);
      case "exportDataRecipeToExcel": return run(exportDataRecipeToExcel);
      case "inspectAppSpec": return run(inspectAppSpec);
      case "createEdsBreakdownChartPreview": return run(createEdsBreakdownChartPreview);
      case "createEdsLineIssueChartPreview": return run(createEdsLineIssueChartPreview);
      case "updateEdsTablePreview": return run(updateEdsTablePreview);
      case "createChangeSetPreview": return run(createChangeSetPreview);
      case "callMcpTool": return run(callMcpTool);
    }
  })();
  const compacted = compactHarnessToolResult(
    result,
    context.resultBudgetChars ?? MAX_HARNESS_TOOL_RESULT_BYTES,
    context.resultBudgetEntries ?? DEFAULT_HARNESS_TOOL_RESULT_ENTRIES,
    name === "inspectDataset" ? { keys: ["qualityProfile"] }
      : name === "inspectFields" ? { keys: ["rules", "rowCount", "fieldCount"], atomicArrays: ["fields"] }
        : name === "scanEdsRawWorkbook" || name === "queryEdsRawWorkbook" ? { keys: ["rules"] }
          : name === "runNotebookCells" || name === "createNotebookDraft" ? { textResults: true } : {},
  );
  if (jsonByteLength(compacted.data) > (context.resultBudgetChars ?? MAX_HARNESS_TOOL_RESULT_BYTES) * 4) {
    throw new StudioValidationError("Harness 工具结果过大", [`工具 ${name} 的结果压缩后仍超过安全字节限制`]);
  }
  return { ...compacted, summary: sanitizeHarnessText(compacted.summary).slice(0, 500) };
}
