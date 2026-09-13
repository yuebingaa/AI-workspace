import { PROJECT_LIMITS } from "@/core/projects/contracts";
import { ProjectError } from "@/core/projects/server/store";
import { assertLocalProjectRequest, requestProject, projectErrorResponse } from "@/core/projects/server/request";
import { readBoundedBodyBytes } from "@/core/http/server/bounded-body";

export const runtime = "nodejs";
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
export async function GET(request: Request) {
  try {
    assertLocalProjectRequest(request);
    const project = requestProject(request);
    if (!project) throw new ProjectError("请先打开本地项目");
    const { entry, bytes } = project.getOriginal(new URL(request.url).searchParams.get("id") ?? "");
    return new Response(new Uint8Array(bytes), { headers: { ...headers, "content-type": "application/octet-stream", "content-disposition": `attachment; filename="project-file"; filename*=UTF-8''${encodeURIComponent(entry.name)}` } });
  } catch (error) { return projectErrorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertLocalProjectRequest(request);
    const project = requestProject(request);
    if (!project) throw new ProjectError("请先打开本地项目");
    const fileName = decodeURIComponent(request.headers.get("x-file-name") ?? "");
    const id = request.headers.get("x-dataset-id") ?? "";
    const length = request.headers.get("content-length");
    if (length && (!/^\d+$/u.test(length) || Number(length) > PROJECT_LIMITS.fileBytes)) throw new ProjectError("原始文件超过 10 MiB 限制", 413);
    if (!request.body) throw new ProjectError("文件内容为空");
    const bytes = await readBoundedBodyBytes(request, PROJECT_LIMITS.fileBytes, { signal: request.signal, timeoutMs: 30_000 });
    if (request.signal.aborted || (length && Number(length) !== bytes.byteLength)) throw new ProjectError("文件上传未完成", 408);
    return Response.json({ file: project.saveOriginal(fileName, Buffer.from(bytes), id) }, { status: 201, headers });
  } catch (error) { return projectErrorResponse(error); }
}
