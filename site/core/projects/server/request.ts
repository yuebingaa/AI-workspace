import { datasetRepository } from "@/core/datasets/server/dataset-repository";
import { resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import { PROJECT_HEADER, projectHandleSchema } from "../contracts";
import { ProjectError, projectByHandle } from "./store";
import { BoundedBodyError } from "@/core/http/server/bounded-body";

export function assertLocalProjectRequest(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || (origin !== null && origin !== url.origin)
    || (site !== null && !["same-origin", "none"].includes(site))
    || (!["GET", "HEAD"].includes(request.method) && !origin && site !== "same-origin")) {
    throw new ProjectError("本地项目只允许当前本机网站访问", 403);
  }
}
export function requestProjectHandle(request: Request): string | null {
  const value = request.headers.get(PROJECT_HEADER);
  if (value === null) return null;
  assertLocalProjectRequest(request);
  const parsed = projectHandleSchema.safeParse(value);
  if (!parsed.success) throw new ProjectError("项目标识无效");
  return parsed.data;
}
export function requestProject(request: Request) {
  const handle = requestProjectHandle(request);
  return handle ? projectByHandle(handle) : null;
}
export function requestDatasetRepository(request: Request) {
  return requestProject(request)?.datasets(resolveDemoRequestIdentity()) ?? datasetRepository;
}
export function projectErrorResponse(error: unknown) {
  if (error instanceof BoundedBodyError) error = new ProjectError("项目请求未完整读取或超过大小限制", error.code === "too-large" ? 413 : ["timeout", "aborted"].includes(error.code) ? 408 : 400);
  return Response.json({ error: { message: error instanceof ProjectError ? error.message : "本地项目读取或保存失败，请检查文件夹、容量和文件占用；现有文件未被主动清除" } }, {
    status: error instanceof ProjectError ? error.status : 500,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}
