import { NextResponse } from "next/server";
import { dshPluginSettingsSchema, dshPluginUpdateSchema } from "@/core/agent-engines/plugin-settings";
import { configuredDshPluginSettings, DshPluginSettingsError } from "@/core/agent-engines/server/plugin-settings";
import { buildDshPluginCatalog, type DshPackageInventory } from "@/core/agent-engines/server/plugin-catalog";
import { inspectOfficialDshPluginPackages } from "@/core/agent-engines/server/dsh-driver";
import { agentEngineSelection } from "@/core/agent-engines/server/selection";
import { assertLocalProjectRequest } from "@/core/projects/server/request";
import { ProjectError } from "@/core/projects/server/store";
import { BoundedBodyError, readBoundedUtf8Body } from "@/core/http/server/bounded-body";

export const runtime = "nodejs";
const headers = { "cache-control": "private, no-store, max-age=0", "x-content-type-options": "nosniff" };
const activeTasks = () => agentEngineSelection.status({ available: false }).activeTasks;
function error(message: string, status: number) { return NextResponse.json({ error: { message } }, { status, headers }); }
function failure(caught: unknown) {
  if (caught instanceof ProjectError) return error("插件设置仅允许当前本机网站访问。", 403);
  if (caught instanceof DshPluginSettingsError) return error(caught.message, caught.status);
  if (caught instanceof BoundedBodyError) return error("请求过大、已取消或无效。", caught.code === "too-large" ? 413 : 400);
  return error("无法读取或保存插件配置；原配置不会被重置，请刷新后重试。", 500);
}
function response(packages: DshPackageInventory) {
  const store = configuredDshPluginSettings(), document = store.read();
  return NextResponse.json(dshPluginSettingsSchema.parse({ document, persistence: store.persistence,
    activeTasks: activeTasks(), plugins: buildDshPluginCatalog(document, packages) }), { headers });
}
export async function GET(request: Request) {
  try {
    assertLocalProjectRequest(request);
    const packages = await inspectOfficialDshPluginPackages();
    if (request.signal.aborted) return error("读取已取消。", 408);
    return response(packages);
  } catch (caught) { return failure(caught); }
}
export async function PATCH(request: Request) {
  try {
    assertLocalProjectRequest(request);
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return error("需要 JSON 配置。", 415);
    const text = await readBoundedUtf8Body(request, 2048, { signal: request.signal, timeoutMs: 5000 });
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return error("配置格式无效。", 400); }
    const input = dshPluginUpdateSchema.safeParse(raw);
    if (!input.success) return error("配置字段无效，仅允许已接入的插件设置。", 400);
    const packages = await inspectOfficialDshPluginPackages();
    if (request.signal.aborted) return error("保存已取消，尚未应用。", 408);
    if (input.data.config.skills && (!packages["dsh-skill"]?.installed || !packages["dsh-tool-skill"]?.installed)) {
      return error("Skill 组件不可用，配置未保存。", 409);
    }
    configuredDshPluginSettings().save(input.data, activeTasks());
    return response(packages);
  } catch (caught) { return failure(caught); }
}
