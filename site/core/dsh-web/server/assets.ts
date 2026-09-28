import { createHash, randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertLocalProjectRequest } from "@/core/projects/server/request";
import type { DshWebAssets } from "../../../runtime/dsh/web-assets.mjs";

export const DSH_WEB_ASSET_BASE = "/api/ai/dsh/web/assets";
type AssetLoader = () => Promise<DshWebAssets>;
let assetsCache: { revision: string; assets: Promise<DshWebAssets> } | undefined;

async function loadAssets(): Promise<DshWebAssets> {
  // Do not re-read the official distribution for every script request. Only
  // server-owned source/install changes invalidate this bounded public snapshot.
  const stamps = await Promise.all(["runtime/dsh/web-assets.mjs", "runtime/dsh/web-client.mjs", "runtime/dsh/web-settings.mjs", ".runtime/dsh-runtime-active.json"].map(async path => {
    try { const value = await stat(resolve(process.cwd(), path)); return `${value.size}:${value.mtimeMs}:${value.ctimeMs}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw error; }
  }));
  const revision = createHash("sha256").update(stamps.join("|")).digest("hex");
  if (assetsCache?.revision === revision) return assetsCache.assets;
  const loaderPath = resolve(process.cwd(), "runtime/dsh/native-loader.cjs");
  const nativeImport = createRequire(loaderPath)(loaderPath) as (url: string) => Promise<typeof import("../../../runtime/dsh/web-assets.mjs")>;
  const assets = nativeImport(`${pathToFileURL(resolve(process.cwd(), "runtime/dsh/web-assets.mjs")).href}?web=${revision}`)
    .then(carrier => carrier.createDshWebAssets({ basePath: DSH_WEB_ASSET_BASE }));
  assetsCache = { revision, assets };
  try { return await assets; }
  catch (error) { if (assetsCache?.assets === assets) assetsCache = undefined; throw error; }
}

const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
function rejected(request: Request): Response | undefined {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers });
  try { assertLocalProjectRequest(request); }
  catch { return new Response("仅允许当前本机网站访问。", { status: 403, headers }); }
}

export async function dshWebDocument(request: Request, load: AssetLoader = loadAssets): Promise<Response> {
  const denied = rejected(request); if (denied) return denied;
  try {
    const query = new URL(request.url).search;
    if (query && query !== "?surface=settings") return new Response("Unsupported surface", { status: 400, headers });
    const nonce = randomBytes(24).toString("base64url");
    const content = await (await load()).html({ nonce, ...(query ? { surface: "settings" as const } : {}) });
    return new Response(content, { headers: { ...headers, "content-type": "text/html; charset=utf-8",
      // The pinned official Cordis shell uses new Function. This exception is
      // document-only; this trusted same-origin frame is not an untrusted-plugin sandbox.
      "content-security-policy": `default-src 'none'; script-src 'self' 'nonce-${nonce}' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'`,
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
    } });
  } catch {
    return new Response("官方 DSH 界面资源暂不可用；请返回过渡入口。未发送模型请求。", {
      status: 503, headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
    });
  }
}

export async function dshWebAsset(request: Request, load: AssetLoader = loadAssets): Promise<Response> {
  const denied = rejected(request); if (denied) return denied;
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${DSH_WEB_ASSET_BASE}/`)) return new Response("Not found", { status: 404, headers });
  try {
    const response = await (await load()).fetch(url.pathname + url.search);
    const resultHeaders = new Headers(response.headers);
    for (const [name, value] of Object.entries(headers)) resultHeaders.set(name, value);
    return new Response(response.body, { status: response.status, headers: resultHeaders });
  } catch { return new Response("DSH 界面资源不可用。", { status: 503, headers }); }
}
