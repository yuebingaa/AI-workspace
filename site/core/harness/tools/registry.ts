import { cellSearchTool, editNotebookCellsTool, createPythonCellTool, getKernelPackagesInfoTool, runNotebookCellsTool, submitNotebookDraftTool, createAnalysisPlan, createNotebookDraft, inspectConnectionSchema } from "./notebook";
import { analyzeEdsReports, scanEdsRawWorkbook, queryEdsRawWorkbook, inspectEdsRawWorkbook, readEdsRawRows } from "./workbook";
import { inspectDataset, inspectFields, transformSpreadsheetData, previewDataRecipe, validateDataRecipe, exportDataRecipeToExcel } from "./dataset";
import { querySemanticModel } from "./semantic";
import { inspectAppSpec, createEdsBreakdownChartPreview, createEdsLineIssueChartPreview, updateEdsTablePreview, createChangeSetPreview } from "./dashboard";
import { callMcpTool } from "./external";
import type { HarnessToolName } from "../contracts";
import type { HarnessToolDefinition } from "./contracts";

export const harnessToolRegistry = {
  cellSearch: cellSearchTool,
  editNotebookCells: editNotebookCellsTool,
  createPythonCell: createPythonCellTool,
  getKernelPackagesInfo: getKernelPackagesInfoTool,
  runNotebookCells: runNotebookCellsTool,
  submitNotebookDraft: submitNotebookDraftTool,
  analyzeEdsReports,
  scanEdsRawWorkbook,
  queryEdsRawWorkbook,
  inspectEdsRawWorkbook,
  readEdsRawRows,
  inspectDataset,
  querySemanticModel,
  createAnalysisPlan,
  createNotebookDraft,
  inspectConnectionSchema,
  inspectFields,
  transformSpreadsheetData,
  previewDataRecipe,
  validateDataRecipe,
  exportDataRecipeToExcel,
  inspectAppSpec,
  createEdsBreakdownChartPreview,
  createEdsLineIssueChartPreview,
  updateEdsTablePreview,
  createChangeSetPreview,
  callMcpTool,
} satisfies Record<HarnessToolName, HarnessToolDefinition<HarnessToolName, unknown>>;
