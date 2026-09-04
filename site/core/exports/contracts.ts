import { z } from "zod";

export const EXCEL_EXPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const EXCEL_EXPORT_TTL_MS = 10 * 60_000;

export function encodeExcelDownloadFileName(fileName: string): string {
  return encodeURIComponent(fileName).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export const excelExportArtifactSchema = z.object({
  id: z.string().min(16).max(160).regex(/^[A-Za-z0-9_-]+$/),
  status: z.literal("ready"),
  fileName: z.string().min(6).max(120).regex(/^[^/\\\u0000-\u001f\u007f]+\.xlsx$/iu),
  downloadUrl: z.string().regex(/^\/api\/exports\/[A-Za-z0-9_-]+$/),
  rowCount: z.number().int().nonnegative(),
  fieldCount: z.number().int().positive(),
  sizeBytes: z.number().int().positive().max(EXCEL_EXPORT_MAX_FILE_BYTES),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
}).strict().superRefine((artifact, context) => {
  if (artifact.downloadUrl !== `/api/exports/${artifact.id}`) {
    context.addIssue({ code: "custom", path: ["downloadUrl"], message: "下载地址必须与导出标识一致" });
  }
  if (Date.parse(artifact.expiresAt) - Date.parse(artifact.createdAt) !== EXCEL_EXPORT_TTL_MS) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "下载工件必须在创建后 10 分钟到期" });
  }
});

export type ExcelExportArtifact = z.infer<typeof excelExportArtifactSchema>;
