import { readBoundedBodyBytes, readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import { requestProject } from "@/core/projects/server/request";
import type { NotebookPythonFile } from "../execution-contracts";
import type { NotebookCell } from "../definition";

export async function readNotebookRequest(request: Request): Promise<{ raw: unknown; files: NotebookPythonFile[] }> {
  const type = request.headers.get("content-type") ?? "";
  if (type.split(";", 1)[0] === "application/json") return {
    raw: JSON.parse(await readBoundedUtf8Body(request, 120_000, { signal: request.signal, timeoutMs: 5_000 })), files: [],
  };
  if (!type.startsWith("multipart/form-data;")) throw new Error("必须使用 JSON 或文件请求");
  const bytes = await readBoundedBodyBytes(request, 16 * 1024 * 1024, { signal: request.signal, timeoutMs: 10_000 });
  const form = await new Response(new Uint8Array(bytes).buffer, { headers: { "content-type": type } }).formData();
  if ([...form.keys()].some((key) => !["payload", "file"].includes(key)) || form.getAll("payload").length !== 1 || form.getAll("file").length > 3) throw new Error("Python 文件请求格式无效");
  const payload = form.get("payload");
  if (typeof payload !== "string" || Buffer.byteLength(payload) > 120_000) throw new Error("Notebook 定义过大或格式无效");
  const names = new Set<string>();
  const files: NotebookPythonFile[] = [];
  for (const value of form.getAll("file")) {
    if (!(value instanceof File) || !/^[^\\/\u0000-\u001f]+\.(xlsx|csv)$/iu.test(value.name)
      || value.name.length > 180 || !value.size || value.size > 10 * 1024 * 1024 || names.has(value.name)) throw new Error("原始文件必须为名称唯一且不超过 10 MiB 的 CSV / XLSX");
    names.add(value.name);
    const bytes = new Uint8Array(await value.arrayBuffer());
    if (/\.xlsx$/iu.test(value.name) && (bytes[0] !== 80 || bytes[1] !== 75)) throw new Error("Excel 文件内容无效");
    files.push({ name: value.name, bytes });
  }
  return { raw: JSON.parse(payload), files };
}

export function resolveNotebookPythonFiles(request: Request, cells: NotebookCell[], provided: NotebookPythonFile[]): NotebookPythonFile[] {
  const names = [...new Set(cells.flatMap((cell) => cell.kind === "python" ? cell.fileNames : []))];
  if (names.length > 3) throw new Error("一次 Notebook 运行最多使用 3 个原始文件");
  const project = names.some((name) => !provided.some((file) => file.name === name)) ? requestProject(request) : null;
  const manifest = project?.read();
  return names.flatMap((name) => {
    const uploaded = provided.find((file) => file.name === name);
    if (uploaded) return [uploaded];
    const candidates = manifest?.files.filter((file) => file.name === name && !file.deletedAt) ?? [];
    if (candidates.length > 1) throw new Error(`项目有多个同名原件“${name}”，请重新上传本次需要的文件`);
    if (!project || !candidates.length) return [];
    const stored = project.getOriginal(candidates[0].id);
    return [{ name, bytes: stored.bytes }];
  });
}
