import { dshPackageInventorySchema } from "@/core/agent-engines/plugin-inventory";
import { inspectOfficialDshPackageInventory } from "@/core/agent-engines/server/dsh-driver";
import { assertLocalProjectRequest } from "@/core/projects/server/request";
import { ProjectError } from "@/core/projects/server/store";

export const runtime = "nodejs";
const headers = { "cache-control": "private, no-store, max-age=0", "x-content-type-options": "nosniff" };
export async function GET(request: Request) {
  try {
    assertLocalProjectRequest(request);
    if (new URL(request.url).search) return Response.json({ error: { message: "组件目录不接受路径或配置参数。" } }, { status: 400, headers });
    request.signal.throwIfAborted();
    const inventory = dshPackageInventorySchema.parse(await inspectOfficialDshPackageInventory());
    request.signal.throwIfAborted();
    return Response.json(inventory, { headers });
  } catch (error) {
    const status = error instanceof ProjectError ? 403 : request.signal.aborted ? 408 : 503;
    const message = status === 403 ? "组件目录仅允许当前本机网站访问。"
      : status === 408 ? "目录读取已取消。" : "无法读取当前 DSH 安装目录，请确认运行组件后重试；这不代表已安装组件为零。";
    return Response.json({ error: { message } }, { status, headers });
  }
}
