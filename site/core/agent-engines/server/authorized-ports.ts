import type { LocalDataRuntime } from "@/core/models";
import type { NotebookDraftRunner, NotebookRuntimeInfoReader } from "@/core/notebook/execution-contracts";
import type { NotebookCapabilities } from "@/core/notebook/capabilities";
import type { ConnectionSchemaInspector } from "@/core/connections/contracts";
import type { EdsRawWorkbook } from "@/core/eds";

/** Server-owned data and Notebook capabilities shared by the two execution kernels.
 * The HTTP boundary builds these from authorized project state, never request JSON. */
export interface AuthorizedAgentDataPorts {
  dataRuntime: LocalDataRuntime;
  notebookRunner: NotebookDraftRunner;
  rawWorkbook?: EdsRawWorkbook;
  notebookCapabilities?: NotebookCapabilities;
  pythonRuntimeInfo?: NotebookRuntimeInfoReader;
  connectionInspector?: ConnectionSchemaInspector;
}
