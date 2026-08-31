import type { AppSpec } from "@/core/models";
import type { StudioPuckData } from "./types";

export interface PuckDraftOrigin {
  pageId: string;
  appSpecRevision: string;
}

export interface PuckDraftState {
  data: StudioPuckData | null;
  origin: PuckDraftOrigin | null;
}

function normalizeSemanticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSemanticValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeSemanticValue(entry)]),
    );
  }
  return value;
}

export function semanticKey(value: unknown): string {
  return JSON.stringify(normalizeSemanticValue(value));
}

export function appSpecRevision(appSpec: AppSpec): string {
  let hash = 2166136261;
  const serialized = semanticKey(appSpec);
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function samePuckData(left: StudioPuckData | null, right: StudioPuckData): boolean {
  return left !== null && semanticKey(left) === semanticKey(right);
}

export function initializePuckDraft(
  current: PuckDraftState,
  origin: PuckDraftOrigin,
  createData: () => StudioPuckData,
): PuckDraftState {
  if (
    current.data
    && current.origin?.pageId === origin.pageId
    && current.origin.appSpecRevision === origin.appSpecRevision
  ) {
    return current;
  }
  return { data: createData(), origin };
}

export function updatePuckDraft(current: StudioPuckData | null, next: StudioPuckData): StudioPuckData {
  return samePuckData(current, next) ? current! : structuredClone(next);
}
