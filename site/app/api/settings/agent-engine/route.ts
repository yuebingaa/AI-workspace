import { NextResponse } from "next/server";
import { agentEngineSelectionSchema, agentEngineSettingsSchema, type AgentEngineSettings } from "@/core/agent-engines/contracts";
import { inspectOfficialDshRuntime } from "@/core/agent-engines/server/dsh-driver";
import { AgentEngineSelectionError, agentEngineSelection } from "@/core/agent-engines/server/selection";
import { BoundedBodyError, readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import { assertLocalProjectRequest } from "@/core/projects/server/request";
import { ProjectError } from "@/core/projects/server/store";

export const runtime = "nodejs";
const responseHeaders = {
  "cache-control": "private, no-store, max-age=0",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};

function error(message: string, status: number) {
  return NextResponse.json({ error: { message } }, { status, headers: responseHeaders });
}

function settings(value: AgentEngineSettings) {
  return NextResponse.json(agentEngineSettingsSchema.parse(value), { headers: responseHeaders });
}

function failure(caught: unknown) {
  if (caught instanceof ProjectError) return error("执行引擎设置仅允许当前本机网站访问。", 403);
  if (caught instanceof AgentEngineSelectionError) return error(caught.message, 409);
  if (caught instanceof BoundedBodyError) {
    return error("执行引擎设置请求过大、无效或已中断。", caught.code === "too-large" ? 413
      : caught.code === "timeout" || caught.code === "aborted" ? 408 : 400);
  }
  // Never return provider diagnostics, local paths, stacks or arbitrary exception text.
  return error("无法读取或更新执行引擎设置，请稍后刷新重试。", 500);
}

export async function GET(request: Request) {
  try {
    assertLocalProjectRequest(request);
    if (request.signal.aborted) return error("执行引擎设置请求已取消。", 408);
    const dsh = await inspectOfficialDshRuntime();
    if (request.signal.aborted) return error("执行引擎设置请求已取消。", 408);
    return settings(agentEngineSelection.status(dsh));
  } catch (caught) { return failure(caught); }
}

export async function PATCH(request: Request) {
  try {
    assertLocalProjectRequest(request);
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return error("执行引擎设置必须使用 application/json。", 415);
    }
    const text = await readBoundedUtf8Body(request, 2_048, { signal: request.signal, timeoutMs: 5_000 });
    let input: unknown;
    try { input = JSON.parse(text); }
    catch { return error("执行引擎选择格式不正确。", 400); }
    const parsed = agentEngineSelectionSchema.safeParse(input);
    if (!parsed.success) return error("执行引擎选择格式不正确。", 400);
    const dsh = await inspectOfficialDshRuntime();
    if (request.signal.aborted) return error("执行引擎设置请求已取消，当前请求未应用。", 408);
    return settings(agentEngineSelection.select(parsed.data, dsh));
  } catch (caught) { return failure(caught); }
}
