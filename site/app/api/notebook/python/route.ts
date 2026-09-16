import { notebookPythonRuntimeInfo } from "@/core/notebook/server/python-runtime";
import { assertLocalProjectRequest, projectErrorResponse } from "@/core/projects/server/request";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    assertLocalProjectRequest(request);
    return Response.json(await notebookPythonRuntimeInfo(), { headers: { "cache-control": "no-store" } });
  } catch (error) { return projectErrorResponse(error); }
}
