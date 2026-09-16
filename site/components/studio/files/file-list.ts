import type { DataSourceDefinition } from "@/core/models";
import type { ProjectManifest } from "@/core/projects/contracts";
import type { ImportedWorkbookAttachment } from "../CsvUploadDialog";

export interface SessionImportedFile { datasetId: string; file: File; importedAt: string }
export type SessionWorkbook = ImportedWorkbookAttachment & { id: string; datasetId: string };
export interface FileListEntry {
  id: string; name: string; origin: "project" | "session" | "data";
  bytes?: number; addedAt?: string; file?: File; workbookId?: string;
  tables: Array<{ id: string; name: string; rows: number }>;
}

export function buildFileList({ manifest, sources, files, workbooks, removedDatasetIds = [] }: {
  manifest?: ProjectManifest | null; sources: DataSourceDefinition[];
  files: SessionImportedFile[]; workbooks: SessionWorkbook[];
  removedDatasetIds?: string[];
}): FileListEntry[] {
  if (manifest) return manifest.files.filter((file) => !file.deletedAt).map((file) => ({
    id: file.id, name: file.name, origin: "project", bytes: file.bytes, addedAt: file.savedAt,
    tables: manifest.tables.filter((table) => file.datasetIds.includes(table.descriptor.datasetId) && !table.deletedAt)
      .map(({ descriptor }) => ({ id: descriptor.datasetId, name: descriptor.source.name, rows: descriptor.source.rowCount })),
  }));
  const entries = new Map<File, FileListEntry>(), covered = new Set<string>();
  const include = (file: File, datasetId: string, addedAt?: string, workbookId?: string) => {
    const source = sources.find((item) => item.id === datasetId);
    if (!source) return; // Current workspace scope, including reassigned datasets.
    let entry = entries.get(file);
    if (!entry) { entry = { id: `session_${datasetId}`, name: file.name, origin: "session", bytes: file.size, file, addedAt, tables: [] }; entries.set(file, entry); }
    if (workbookId) entry.workbookId = workbookId;
    if (!entry.tables.some((table) => table.id === datasetId)) entry.tables.push({ id: datasetId, name: source.name, rows: source.rowCount });
    covered.add(datasetId);
  };
  for (const entry of files) include(entry.file, entry.datasetId, entry.importedAt);
  for (const entry of workbooks) include(entry.file, entry.datasetId, undefined, entry.id);
  return [...entries.values(), ...sources.filter((source) => source.sourceType === "csv" && !covered.has(source.id) && !removedDatasetIds.includes(source.id)).map((source): FileListEntry => ({
    id: `data_${source.id}`, name: source.name, origin: "data", tables: [{ id: source.id, name: source.name, rows: source.rowCount }],
  }))];
}

export function sortFileList(entries: FileListEntry[], search: string, order: "recent" | "name") {
  const query = search.trim().toLocaleLowerCase();
  return entries.filter((entry) => `${entry.name} ${entry.tables.map((table) => table.name).join(" ")}`.toLocaleLowerCase().includes(query))
    .sort((left, right) => (order === "recent" ? (Date.parse(right.addedAt ?? "") || 0) - (Date.parse(left.addedAt ?? "") || 0) : 0) || left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
}

export function fileSize(bytes: number | undefined) {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
