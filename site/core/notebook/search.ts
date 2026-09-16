import type { NotebookCell } from "./definition";
import type { NotebookDocument } from "./contracts";
import { cellDependencies, validateNotebook } from "./graph";

export interface NotebookIndexEntry {
  id: string;
  kind: NotebookCell["kind"];
  title: string;
  index: number;
  outputName?: string;
  inputs: Array<{ cellId: string; variable: string }>;
  upstream: string[];
  downstream: string[];
  sourceDataSourceIds: string[];
  connectionIds: string[];
  sourceFileNames: string[];
}

export interface NotebookSearchIndex {
  entries: NotebookIndexEntry[];
  byId: Map<string, NotebookIndexEntry>;
  byVariable: Map<string, NotebookIndexEntry>;
  sourceById: Map<string, string>;
}

/** Explicit Notebook bindings are authoritative; SQL text is not parsed as lineage. */
export function buildNotebookSearchIndex(document: NotebookDocument): NotebookSearchIndex {
  const cells = validateNotebook(document);
  const byId = new Map<string, NotebookIndexEntry>();
  const byVariable = new Map<string, NotebookIndexEntry>();
  const sourceById = new Map<string, string>();
  for (const [index, cell] of cells.entries()) {
    const upstream = cellDependencies(cell);
    const parents = upstream.map((id) => byId.get(id)!);
    const entry: NotebookIndexEntry = {
      id: cell.id, kind: cell.kind, title: cell.title, index,
      ...("outputName" in cell ? { outputName: cell.outputName } : {}),
      inputs: parents.map((parent) => ({ cellId: parent.id, variable: parent.outputName! })),
      upstream, downstream: [],
      sourceDataSourceIds: [...new Set([...(cell.kind === "data" ? [cell.sourceDataSourceId] : []),
        ...parents.flatMap((parent) => parent.sourceDataSourceIds)])],
      connectionIds: [...new Set([...(cell.kind === "warehouseSql" ? [cell.connectionId] : []),
        ...parents.flatMap((parent) => parent.connectionIds)])],
      sourceFileNames: [...new Set([...(cell.kind === "python" ? cell.fileNames : []), ...parents.flatMap((parent) => parent.sourceFileNames)])],
    };
    byId.set(cell.id, entry);
    if (entry.outputName) byVariable.set(entry.outputName, entry);
    for (const parent of parents) parent.downstream.push(cell.id);
    // Validation may trim string fields; source inspection must preserve the stored definition.
    sourceById.set(cell.id, JSON.stringify(document.cells[index], null, 2));
  }
  return { entries: [...byId.values()], byId, byVariable, sourceById };
}

export type NotebookSearchDirection = "self" | "upstream" | "downstream" | "both";
export interface NotebookIndexSearch {
  query?: string;
  cellId?: string;
  variable?: string;
  kind?: NotebookCell["kind"];
  searchIn: "metadata" | "source";
  direction: NotebookSearchDirection;
  depth: number;
}
export interface NotebookIndexMatch {
  entry: NotebookIndexEntry;
  relation: "self" | "upstream" | "downstream" | "match";
  distance: number;
}

export function searchNotebookIndex(index: NotebookSearchIndex, query: NotebookIndexSearch) {
  const anchor = query.cellId ? index.byId.get(query.cellId)
    : query.variable ? index.byVariable.get(query.variable) : undefined;
  if ((query.cellId || query.variable) && !anchor) throw new Error("找不到指定单元或输出变量，请先按名称搜索。");
  if (query.direction !== "self" && !anchor) throw new Error("遍历依赖关系需要指定 cellId 或 variable。");
  const reachable = new Map<string, Pick<NotebookIndexMatch, "relation" | "distance">>();
  if (anchor) reachable.set(anchor.id, { relation: "self", distance: 0 });
  const visit = (direction: "upstream" | "downstream") => {
    const queue = [{ id: anchor!.id, distance: 0 }];
    const visited = new Set<string>([anchor!.id]);
    for (let position = 0; position < queue.length; position += 1) {
      const current = queue[position];
      if (current.distance >= query.depth) continue;
      for (const id of index.byId.get(current.id)![direction]) {
        if (visited.has(id)) continue;
        visited.add(id);
        const distance = current.distance + 1;
        reachable.set(id, { relation: direction, distance });
        queue.push({ id, distance });
      }
    }
  };
  if (anchor && (query.direction === "upstream" || query.direction === "both")) visit("upstream");
  if (anchor && (query.direction === "downstream" || query.direction === "both")) visit("downstream");
  const text = query.query?.trim().toLocaleLowerCase() ?? "";
  const matches: NotebookIndexMatch[] = index.entries.filter((entry) => {
    if (anchor && !reachable.has(entry.id)) return false;
    if (query.kind && entry.kind !== query.kind) return false;
    const haystack = query.searchIn === "source" ? index.sourceById.get(entry.id)!
      : [entry.id, entry.kind, entry.title, entry.outputName ?? "", ...entry.inputs.map((input) => input.variable)].join("\n");
    return !text || haystack.toLocaleLowerCase().includes(text);
  }).map((entry) => ({ entry, ...(reachable.get(entry.id) ?? { relation: "match" as const, distance: 0 }) }));
  return { anchor, matches };
}
