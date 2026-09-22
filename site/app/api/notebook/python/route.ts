import { notebookPythonRuntimeInfo } from "@/core/notebook/server/python-runtime";
import { assertLocalProjectRequest, projectErrorResponse } from "@/core/projects/server/request";
import { notebookCapabilityReason } from "@/core/notebook/capabilities";
import {
  NotebookCapabilityConfigurationError,
} from "@/core/notebook/server/capabilities";
import { getNotebookCapabilities } from "@/core/notebook/server/available-capabilities";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    assertLocalProjectRequest(request);
    const capabilities = getNotebookCapabilities();
    if (!capabilities.python.enabled) {
      return Response.json({
        engine: "pyodide",
        enabled: false,
        available: false,
        reason: notebookCapabilityReason(capabilities, "python"),
      }, { headers: { "cache-control": "no-store" } });
    }
    return Response.json({ ...(await notebookPythonRuntimeInfo()), enabled: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof NotebookCapabilityConfigurationError) {
      return Response.json({ error: { message: error.message } }, {
        status: 500,
        headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
    }
    return projectErrorResponse(error);
  }
}
