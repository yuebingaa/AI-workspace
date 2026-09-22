import { z } from "zod";
import { NOTEBOOK_CELL_KINDS } from "@/core/notebook/cell-catalog";

const code = z.literal("project_incompatible");
const positionSchema = z.object({
  notebookIndex: z.number().int().min(1).max(30),
  cellIndex: z.number().int().min(1).max(30),
  kind: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u).optional(),
}).strict();

/** Only bounded structural metadata crosses the API; never include cell contents. */
export const projectCompatibilitySchema = z.discriminatedUnion("reason", [
  z.object({ code, reason: z.literal("project-format") }).strict(),
  z.object({
    code, reason: z.literal("workspace-version"),
    supportedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    detectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict().refine((issue) => issue.detectedVersion > issue.supportedVersion),
  z.object({
    code, reason: z.literal("notebook-cells"),
    cells: z.array(positionSchema).min(1).max(5),
    total: z.number().int().min(1).max(900),
    omitted: z.number().int().nonnegative().max(899),
  }).strict().refine((issue) => issue.total === issue.cells.length + issue.omitted),
]);
export type ProjectCompatibility = z.infer<typeof projectCompatibilitySchema>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function projectCompatibilityFromError(error: unknown): ProjectCompatibility | null {
  if (!record(error)) return null;
  const result = projectCompatibilitySchema.safeParse(error.compatibility);
  return result.success ? result.data : null;
}
const knownKinds = new Set<string>(NOTEBOOK_CELL_KINDS);

/**
 * Diagnostic preflight, not a permissive parser or migration. Call only after the
 * existing bounded file reader. Invalid known cells still fail the strict schema.
 * Catalog traversal follows existing maximums (30 notebooks, 30 cells each).
 */
export function detectProjectCompatibility(value: unknown, supported: {
  projectFormat: string; workspaceVersion: number;
}): ProjectCompatibility | null {
  if (!record(value) || typeof value.format !== "string") return null;
  if (value.format !== supported.projectFormat) {
    return /^agentcanvas-local-project-v\d{1,9}$/u.test(value.format)
      ? { code: "project_incompatible", reason: "project-format" } : null;
  }
  const state = value.state;
  if (!record(state)) return null;
  if (typeof state.version === "number" && Number.isSafeInteger(state.version) && state.version > supported.workspaceVersion) {
    return { code: "project_incompatible", reason: "workspace-version", supportedVersion: supported.workspaceVersion, detectedVersion: state.version };
  }
  if (!record(state.dataProduct) || !record(state.dataProduct.notebooks)) return null;
  const books = Object.values(state.dataProduct.notebooks);
  if (books.length > 30) return null;
  const cells: Extract<ProjectCompatibility, { reason: "notebook-cells" }>["cells"] = [];
  let total = 0;
  for (let bookIndex = 0; bookIndex < books.length; bookIndex += 1) {
    const book = books[bookIndex];
    if (!record(book) || !Array.isArray(book.cells) || book.cells.length > 30) continue;
    for (let cellIndex = 0; cellIndex < book.cells.length; cellIndex += 1) {
      const cell: unknown = book.cells[cellIndex];
      if (!record(cell) || typeof cell.kind !== "string" || !cell.kind || knownKinds.has(cell.kind)) continue;
      total += 1;
      if (cells.length < 5) cells.push({
        notebookIndex: bookIndex + 1, cellIndex: cellIndex + 1,
        ...(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(cell.kind) ? { kind: cell.kind } : {}),
      });
    }
  }
  return total ? { code: "project_incompatible", reason: "notebook-cells", cells, total, omitted: total - cells.length } : null;
}

export function projectCompatibilityMessage(issue: ProjectCompatibility): string {
  const reason = issue.reason === "project-format" ? "项目使用了当前应用不支持的 AgentCanvas 项目格式。"
    : issue.reason === "workspace-version" ? `项目工作台版本 ${issue.detectedVersion} 高于当前支持的版本 ${issue.supportedVersion}。`
      : `项目包含当前版本不支持的 Notebook 单元：${issue.cells.map((cell) => `Notebook ${cell.notebookIndex} / 单元 ${cell.cellIndex}${cell.kind ? `（${cell.kind}）` : ""}`).join("；")}${issue.omitted ? `；另有 ${issue.omitted} 个` : ""}。`;
  return `${reason}为避免丢失定义，已拒绝本次读取或保存；项目文件和原始数据未被本次操作修改。请使用兼容版本打开，或从完整项目备份恢复后重试。`;
}
