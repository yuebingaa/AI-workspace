import { readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import { PROJECT_LIMITS, projectActionSchema } from "@/core/projects/contracts";
import { ProjectError, openProject, recentProjects } from "@/core/projects/server/store";
import { assertLocalProjectRequest, projectErrorResponse, requestProject, requestProjectHandle } from "@/core/projects/server/request";

export const runtime = "nodejs";
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
export async function GET(request: Request) {
  try {
    assertLocalProjectRequest(request);
    const project = requestProject(request);
    if (project) return Response.json({ handle: requestProjectHandle(request), path: project.root, manifest: project.read() }, { headers });
    return Response.json({ projects: recentProjects() }, { headers });
  } catch (error) { return projectErrorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertLocalProjectRequest(request);
    if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") throw new ProjectError("必须使用 JSON 请求", 415);
    const text = await readBoundedUtf8Body(request, PROJECT_LIMITS.manifestBytes, { signal: request.signal, timeoutMs: 15_000 });
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new ProjectError("项目请求不是有效的 JSON"); }
    const result = projectActionSchema.safeParse(body);
    if (!result.success) throw new ProjectError("项目操作参数无效");
    const action = result.data;
    if (action.action === "create" || action.action === "open") return Response.json(openProject(action.path, action.action === "create" ? action.name : undefined), { headers });
    const project = requestProject(request);
    if (!project) throw new ProjectError("请先打开本地项目");
    if (action.action === "save") return Response.json({ stateRevision: project.saveState(action.state, action.stateRevision) }, { headers });
    if (action.action === "renameTable") project.renameTable(action.datasetId, action.name);
    if (action.action === "restoreTable") project.restoreTable(action.datasetId);
    return Response.json({ handle: requestProjectHandle(request), path: project.root, manifest: project.read() }, { headers });
  } catch (error) { return projectErrorResponse(error); }
}
