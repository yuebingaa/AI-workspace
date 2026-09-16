import { z } from "zod";
import { catalogReferenceSchema } from "@/core/metadata/contracts";

const id = z.string().min(1).max(160);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
export const datasetLineageSchema = z.object({
  version: z.literal(1), recordedAt: z.iso.datetime(), accessMode: z.enum(["user", "ai"]),
  sourceDatasetIds: z.array(id).max(10),
  sourceFiles: z.array(z.object({ name: z.string().max(180), sha256: fingerprint }).strict()).max(3).optional(),
  rowCount: z.number().int().nonnegative(), complete: z.boolean(), dataSignature: fingerprint,
  steps: z.array(z.object({
    cellId: z.string().min(1).max(120), title: z.string().min(1).max(160),
    kind: z.enum(["data", "sql", "python", "warehouseSql", "semanticQuery", "transform", "table", "chart", "text"]),
    inputCellIds: z.array(z.string().max(120)).max(10),
    resultId: z.string().max(240).optional(), queryId: id.optional(),
    dataSignature: fingerprint.optional(), catalogRef: catalogReferenceSchema.optional(),
    // The producer owns this definition; Dataset stores the receipt without importing Notebook's runtime.
    definition: z.string().max(80_000).refine((value) => {
      try { const parsed: unknown = JSON.parse(value); return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed); }
      catch { return false; }
    }, "步骤定义必须是 JSON 对象"),
  }).strict()).max(40),
}).strict().refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 160_000, "结果来源记录超过 160 KB");
export type DatasetLineage = z.infer<typeof datasetLineageSchema>;
export const notebookDatasetProvenanceSchema = z.object({
  kind: z.literal("notebook"), runId: z.string().max(160), resultId: z.string().max(240), cellId: z.string().max(120),
  revision: z.number().int().nonnegative(), connectionIds: z.array(z.string().max(100)).max(20),
  lineage: datasetLineageSchema.optional(),
}).strict();
export type NotebookDatasetProvenance = z.infer<typeof notebookDatasetProvenanceSchema>;
