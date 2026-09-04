import { excelExportStore } from "@/core/exports/server/excel-export-store";
import { DEMO_IDENTITY_RESPONSE_HEADERS, resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import { encodeExcelDownloadFileName } from "@/core/exports/contracts";

export const runtime = "nodejs";

const tokenPattern = /^[A-Za-z0-9_-]{16,160}$/u;

const noStoreHeaders = {
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
  ...DEMO_IDENTITY_RESPONSE_HEADERS,
};

export const encodeDownloadFileName = encodeExcelDownloadFileName;

export async function GET(request: Request) {
  const token = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
  if (!tokenPattern.test(token)) {
    return Response.json({ error: { message: "Excel 下载标识无效。" } }, {
      status: 400,
      headers: noStoreHeaders,
    });
  }
  let stored: ReturnType<typeof excelExportStore.get>;
  try {
    stored = excelExportStore.get(token, resolveDemoRequestIdentity());
  } catch {
    return Response.json({ error: { message: "读取 Excel 下载文件失败，请稍后重试。" } }, {
      status: 500,
      headers: noStoreHeaders,
    });
  }
  if (!stored) {
    return Response.json({ error: { message: "Excel 文件不存在或下载链接已过期，请重新生成。" } }, {
      status: 404,
      headers: noStoreHeaders,
    });
  }
  return new Response(new Uint8Array(stored.buffer), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-length": String(stored.buffer.length),
      "accept-ranges": "none",
      "content-disposition": `attachment; filename="analysis.xlsx"; filename*=UTF-8''${encodeExcelDownloadFileName(stored.artifact.fileName)}`,
      ...noStoreHeaders,
    },
  });
}
