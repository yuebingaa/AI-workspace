import type { NotebookCell } from "./definition";
import { notebookCellCatalog } from "./cell-catalog";

export interface NotebookCapabilityState {
  readonly enabled: boolean;
  readonly reason?: string;
}

export interface NotebookCapabilities {
  readonly python: NotebookCapabilityState;
}

export interface NotebookCapabilityStatus extends NotebookCapabilityState {
  readonly available: boolean;
}

export type NotebookCapabilityName = keyof NotebookCapabilities;

export const DEFAULT_NOTEBOOK_CAPABILITIES: NotebookCapabilities = Object.freeze({
  python: Object.freeze({ enabled: true }),
});

export function isNotebookCellCapabilityEnabled(
  capabilities: NotebookCapabilities,
  kind: NotebookCell["kind"],
): boolean {
  const capability = notebookCellCatalog[kind].capability;
  return capability === null || capabilities[capability].enabled;
}

export function notebookCapabilityReason(
  capabilities: NotebookCapabilities,
  kind: NotebookCell["kind"],
): string | undefined {
  const capability = notebookCellCatalog[kind].capability;
  if (capability === null || capabilities[capability].enabled) return undefined;
  return capabilities[capability].reason ?? `${capability} Notebook 能力已关闭`;
}

function stableCapabilityValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableCapabilityValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableCapabilityValue(entry)]));
}

function sameCellDefinition(left: NotebookCell, right: NotebookCell): boolean {
  return JSON.stringify(stableCapabilityValue(left)) === JSON.stringify(stableCapabilityValue(right));
}

/**
 * Disabled Cell definitions are immutable to automated/full-draft changes.
 * Explicit UI deletion has its own impact confirmation and does not use this
 * guard; Agent drafts and pending-draft adoption do.
 */
export function notebookCapabilityMutationIssue(
  capabilities: NotebookCapabilities,
  current: readonly NotebookCell[],
  candidate: readonly NotebookCell[],
): string | undefined {
  const candidateById = new Map(candidate.map((cell) => [cell.id, cell]));
  for (const cell of current) {
    if (isNotebookCellCapabilityEnabled(capabilities, cell.kind)) continue;
    const next = candidateById.get(cell.id);
    if (!next) return `能力关闭期间不能移除“${cell.title}”单元；原定义必须保留。`;
    if (!sameCellDefinition(cell, next)) return `能力关闭期间不能修改“${cell.title}”单元；原配置与依赖必须保留。`;
  }
  const currentById = new Map(current.map((cell) => [cell.id, cell]));
  for (const cell of candidate) {
    if (isNotebookCellCapabilityEnabled(capabilities, cell.kind)) continue;
    const previous = currentById.get(cell.id);
    if (!previous || !sameCellDefinition(previous, cell)) {
      return `能力关闭期间不能新增或替换“${cell.title}”单元。`;
    }
  }
  return undefined;
}
