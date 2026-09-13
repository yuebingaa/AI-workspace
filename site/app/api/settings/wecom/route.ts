import { z } from "zod";
import { acceptsWecomRequest, authJobs, createWecomSession, getWecomSession, revokeWecomSession, sessionCookieName, type WecomSession } from "@/core/wecom/server/session";
import { authorized, readWecomQr, startWecomAuth, wecomBinary } from "@/core/wecom/server/cli";
import { wecomCatalog } from "@/core/wecom/server/tools";
import { BoundedBodyError, readBoundedUtf8Body } from "@/core/http/server/bounded-body";

export const runtime = "nodejs";
const headers = { "cache-control": "private, no-store, max-age=0", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" };
const inputSchema = z.object({ action: z.literal("connect"), consent: z.literal(true) }).strict();
function response(data: unknown, status = 200, extra: Record<string, string> = {}) { return Response.json(data, { status, headers: { ...headers, ...extra } }); }
function error(message: string, status: number) { return response({ error: { message } }, status); }
async function status(session?: WecomSession) {
  let available = Boolean(process.env.STUDIO_LOCAL_STATE_DIR);
  try { wecomBinary(); } catch { available = false; }
  const connected = Boolean(available && session && await authorized(session).catch(() => false));
  const job = session && authJobs.get(session.key);
  const pending = Boolean(job && !job.finished && Date.now() - job.startedAt < 300_000);
  return { available, connected, pending, qrReady: Boolean(pending && session && await readWecomQr(session)),
    failed: Boolean(job?.failed), readOnly: true, tools: wecomCatalog().map(({ name, description }) => ({ name, description })),
    message: !available ? "本机企业微信组件不可用，请检查 CLI 安装和持久化目录。" : connected ? "已连接，可在 AI 对话中搜索文档、读取表格。" : pending ? "请用企业微信扫描二维码并确认授权，二维码约 5 分钟有效。" : job?.failed ? "授权失败或已超时，请检查网络后重新连接。" : "尚未连接企业微信。" };
}
export async function GET(request: Request) {
  if (!acceptsWecomRequest(request)) return error("企业微信连接仅允许本机同站访问。", 403);
  const session = await getWecomSession(request);
  if (new URL(request.url).searchParams.get("qr") === "1") {
    const qr = session && await readWecomQr(session);
    return qr ? new Response(new Uint8Array(qr), { headers: { ...headers, "content-type": "image/png" } }) : error("二维码尚未生成或已过期。", 404);
  }
  return response(await status(session));
}
export async function POST(request: Request) {
  if (!acceptsWecomRequest(request, true)) return error("企业微信授权仅允许从本机网页发起。", 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) return error("需要 JSON 请求。", 415);
  try {
    const parsed = inputSchema.safeParse(JSON.parse(await readBoundedUtf8Body(request, 1_024, { signal: request.signal, timeoutMs: 5_000 })));
    if (!parsed.success) return error("请先明确同意将所请求的企业微信数据交给当前 AI 服务分析。", 400);
    wecomBinary();
    let session = await getWecomSession(request); let cookie: string | undefined;
    if (!session) {
      if ([...authJobs.values()].filter((job) => !job.finished).length >= 3) return error("已有多个授权等待扫码，请稍后重试。", 429);
      const created = await createWecomSession(request); session = created.session; cookie = created.cookie;
    }
    if (!await authorized(session)) await startWecomAuth(session);
    return response(await status(session), 200, cookie ? { "set-cookie": cookie } : {});
  } catch (caught) {
    if (caught instanceof BoundedBodyError) return error("授权请求过大或已中断。", caught.code === "too-large" ? 413 : 400);
    return error("无法发起企业微信授权，请检查本机组件及网络后重试。", 400);
  }
}
export async function DELETE(request: Request) {
  if (!acceptsWecomRequest(request, true)) return error("企业微信断开仅允许从本机网页发起。", 403);
  try {
    const session = await getWecomSession(request);
    if (session) await revokeWecomSession(session);
    return response(await status(), 200, { "set-cookie": `${sessionCookieName(request)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
  } catch { return error("本机连接未能完全移除，请稍后重试。", 500); }
}
