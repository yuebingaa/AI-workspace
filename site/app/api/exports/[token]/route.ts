import { excelExportStore } from "@/core/exports/server/excel-export-store";

export const runtime = "nodejs";

const tokenPattern = /^[A-Za-z0-9_-]{16,160}$/u;

export async function GET(request: Request) {
  const token = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
  if (!tokenPattern.test(token)) {
    return Response.json({ error: { message: "Excel 下载标识无效。" } }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const stored = excelExportStore.get(token);
  if (!stored) {
    return Response.json({ error: { message: "Excel 文件不存在或下载链接已过期，请重新生成。" } }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  return new Response(new Uint8Array(stored.buffer), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-length": String(stored.buffer.length),
      "content-disposition": `attachment; filename="analysis.xlsx"; filename*=UTF-8''${encodeURIComponent(stored.artifact.fileName)}`,
      "cache-control": "private, no-store, max-age=0",
      "x-content-type-options": "nosniff",
    },
  });
}
