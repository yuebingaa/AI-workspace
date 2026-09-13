import { listConnections } from "@/core/connections/server/config";
import { executeConnectionSql, inspectConnectionSchema } from "@/core/connections/server/query";
import { connectionIdSchema } from "@/core/connections/contracts";
import { assertLocalProjectRequest, requestProject, requestProjectHandle, projectErrorResponse } from "@/core/projects/server/request";
import { readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import { z } from "zod";
import { ProjectError } from "@/core/projects/server/store";

export const runtime = "nodejs";
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
function scope(request: Request) {
  assertLocalProjectRequest(request); requestProject(request);
  return requestProjectHandle(request);
}
export async function GET(request: Request) {
  try { return Response.json({ connections: listConnections(scope(request)) }, { headers }); }
  catch (error) { return projectErrorResponse(error); }
}
export async function POST(request: Request) {
  try {
    const project = scope(request);
    if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") return Response.json({ error: { message: "需要 JSON 请求" } }, { status: 415, headers });
    const body = z.object({ connectionId: connectionIdSchema, action: z.enum(["test", "schema"]) }).strict()
      .parse(JSON.parse(await readBoundedUtf8Body(request, 2_000, { signal: request.signal, timeoutMs: 5_000 })));
    if (body.action === "test") {
      await executeConnectionSql({ connectionId: body.connectionId, project, sql: "SELECT 1 AS connected", signal: request.signal });
      return Response.json({ connected: true }, { headers });
    }
    return Response.json(await inspectConnectionSchema({ connectionId: body.connectionId, project, signal: request.signal }), { headers });
  } catch (error) {
    if (error instanceof ProjectError) return projectErrorResponse(error);
    return Response.json({ error: { message: error instanceof Error ? error.message.slice(0, 700) : "连接操作失败" } }, { status: 400, headers });
  }
}
