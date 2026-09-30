export const name: "agentcanvas-notebook-tools";
export const inject: string[];
export const NOTEBOOK_TOOL_NAMES: readonly ["cellSearch", "editNotebookCells", "runNotebookCells", "submitNotebookDraft"];
export const SOURCE_TOOL_NAMES: readonly ["getKernelPackagesInfo", "inspectEdsRawWorkbook", "readEdsRawRows", "inspectConnectionSchema"];
export type NotebookToolName = typeof NOTEBOOK_TOOL_NAMES[number] | typeof SOURCE_TOOL_NAMES[number];
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface NotebookToolDescriptor {
  readonly name: NotebookToolName;
  readonly description: string;
  readonly parameters: Record<string, JsonValue>;
}
export interface NotebookToolCall {
  name: NotebookToolName;
  args: unknown;
  callId: string;
  signal: AbortSignal;
}
/** No credentials, UI state, SDK model config or project paths in this contract. */
export interface NotebookPluginConfig {
  readonly catalog: readonly NotebookToolDescriptor[];
  execute(call: NotebookToolCall): Promise<Record<string, JsonValue>>;
}
/** The small structural subset of the pinned official DSH tools service used here. */
export interface NotebookPluginContext {
  tools: {
    schemas(): { name: string }[];
    register(tool: NotebookToolDescriptor & {
      output: {
        schema: Record<string, JsonValue>;
        render(args: unknown, value: Record<string, JsonValue>): { type: "text"; text: string }[];
      };
      execute(args: unknown, execution: { callId: string; signal: AbortSignal }): Promise<Record<string, JsonValue>>;
    }): unknown;
  };
}
export function apply(ctx: NotebookPluginContext, config: NotebookPluginConfig): void;
