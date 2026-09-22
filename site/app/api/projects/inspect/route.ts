import { z } from "zod";
import { readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import { PROJECT_INSPECTION_LIMITS } from "@/core/projects/inspection";
import { LocalProjectStore, ProjectError, checkedProjectPath } from "@/core/projects/server/store";
import { assertLocalProjectRequest, projectErrorResponse } from "@/core/projects/server/request";

export const runtime = "nodejs";
const inputSchema = z.object({ path: z.string().trim().min(1).max(2_000) }).strict();
export async function POST(request: Request) {
  try {
    assertLocalProjectRequest(request);
    if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") throw new ProjectError("必须使用 JSON 请求", 415);
    const text = await readBoundedUtf8Body(request, PROJECT_INSPECTION_LIMITS.requestBytes, { signal: request.signal, timeoutMs: 15_000 });
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new ProjectError("项目请求不是有效的 JSON"); }
    const input = inputSchema.safeParse(value);
    if (!input.success) throw new ProjectError("只读预览参数无效");
    const inspection = new LocalProjectStore(checkedProjectPath(input.data.path)).inspect();
    return Response.json(inspection, { headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch (error) { return projectErrorResponse(error); }
}
