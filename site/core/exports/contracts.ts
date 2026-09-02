import { z } from "zod";

export const excelExportArtifactSchema = z.object({
  id: z.string().min(16).max(160).regex(/^[A-Za-z0-9_-]+$/),
  status: z.literal("ready"),
  fileName: z.string().min(6).max(120).regex(/^[^/\\]+\.xlsx$/iu),
  downloadUrl: z.string().regex(/^\/api\/exports\/[A-Za-z0-9_-]+$/),
  rowCount: z.number().int().nonnegative(),
  fieldCount: z.number().int().positive(),
  sizeBytes: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
}).strict();

export type ExcelExportArtifact = z.infer<typeof excelExportArtifactSchema>;
