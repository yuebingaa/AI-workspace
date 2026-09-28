import type { HarnessRequest, HarnessToolExecutionResult, HarnessToolName, HarnessEditableNodeSummary, HarnessSemanticIntentDecision } from "../contracts";
import type { LocalDataRuntime } from "@/core/models";
import type { NotebookDraftRunner, NotebookRuntimeInfoReader } from "@/core/notebook/execution-contracts";
import type { NotebookCapabilities } from "@/core/notebook/capabilities";
import type { ConnectionSchemaInspector } from "@/core/connections/contracts";
import type { HarnessAnalysisPlanArtifact } from "../analysis-plan-contracts";
import type { NotebookCellSession } from "../notebook-cell-tools";
import type { HarnessMcpRuntime, HarnessMcpToolSummary } from "../mcp/contracts";
import type { EdsRawWorkbook } from "@/core/eds";
import type { z } from "zod";

export interface HarnessToolContext {
  request: HarnessRequest;
  dataRuntime: LocalDataRuntime;
  now(): number;
  id(): string;
  resultBudgetChars?: number;
  resultBudgetEntries?: number;
  excelExporter?: HarnessExcelExporter;
  notebookRunner?: NotebookDraftRunner;
  pythonRuntimeInfo?: NotebookRuntimeInfoReader;
  /** Server-owned execution policy. Missing means the backwards-compatible default. */
  notebookCapabilities?: NotebookCapabilities;
  connectionInspector?: ConnectionSchemaInspector;
  analysisPlanStore?: Map<string, HarnessAnalysisPlanArtifact>;
  notebookCellSession?: NotebookCellSession;
  notebookDiagnostics?: import("../notebook-diagnostics").NotebookDiagnosticSession;
  rawWorkbook?: HarnessRawWorkbook;
  mcpRuntime?: HarnessMcpRuntime;
  signal?: AbortSignal;
}

/** Compatibility name; parsed workbook data is owned by the workbook domain. */
export type HarnessRawWorkbook = EdsRawWorkbook;

export interface HarnessExcelExporterArgs {
  recipeId: string;
  fileName?: string;
}

export type HarnessExcelExporter = (
  args: HarnessExcelExporterArgs,
  context: HarnessToolContext,
) => Promise<HarnessToolExecutionResult>;

export interface HarnessToolDefinition<Name extends HarnessToolName, Args> {
  name: Name;
  description: string;
  mode: "readOnly" | "changePreview" | "external";
  schema: z.ZodType<Args>;
  execute(args: Args, context: HarnessToolContext): HarnessToolExecutionResult | Promise<HarnessToolExecutionResult>;
}

/** Model schema projection needs metadata, not executable tool implementations. */
export type HarnessToolParameterSource<Name extends HarnessToolName = HarnessToolName> = Pick<
  HarnessToolDefinition<Name, unknown>, "name" | "schema"
>;

export function defineTool<Name extends HarnessToolName, Args>(definition: HarnessToolDefinition<Name, Args>) {
  return definition;
}

export interface HarnessToolCatalogOptions {
  names?: HarnessToolName[];
  editableNodes?: HarnessEditableNodeSummary[];
  instruction?: string;
  request?: HarnessRequest;
  semanticIntent?: HarnessSemanticIntentDecision;
  mcpTools?: HarnessMcpToolSummary[];
  analysisPlan?: HarnessAnalysisPlanArtifact;
  notebookCapabilities?: NotebookCapabilities;
}
