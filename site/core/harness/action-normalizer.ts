import { harnessModelTurnSchema, type HarnessModelTurn } from "./contracts";

export interface HarnessActionNormalizationOptions {
  readonlyTask: boolean;
  readonlyResultComplete: boolean;
  expectedPageId?: string;
}

export interface HarnessActionNormalizationResult {
  turn: HarnessModelTurn;
  normalized: boolean;
  normalizedFrom?: "completedAlias" | "legacyEnvelope" | "readonlyTextSummary" | "readonlyCompleteWithPageId";
}

export class HarnessActionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessActionProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function nonEmptyMessage(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function redactedShape(value: unknown) {
  if (!isRecord(value)) return `顶层类型：${Array.isArray(value) ? "array" : typeof value}`;
  const topLevel = Object.keys(value).sort();
  const action = isRecord(value.action) ? Object.keys(value.action).sort() : [];
  return [
    `顶层字段：${topLevel.length > 0 ? topLevel.join("、") : "无"}`,
    ...(action.length > 0 ? [`action 字段：${action.join("、")}`] : []),
  ].join("；");
}

function redactedIssues(value: unknown) {
  const parsed = harnessModelTurnSchema.safeParse(value);
  if (parsed.success) return "无";
  return parsed.error.issues.slice(0, 6).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "$";
    return `${path}:${issue.code}`;
  }).join("、");
}

function readonlyAlias(
  value: unknown,
  options: HarnessActionNormalizationOptions,
): HarnessActionNormalizationResult | undefined {
  if (!isRecord(value)) return undefined;

  if (
    hasOnlyKeys(value, ["type", "message", "pageId"])
    && value.type === "complete"
    && nonEmptyMessage(value.message)
    && typeof value.pageId === "string"
    && value.pageId === options.expectedPageId
  ) {
    return {
      turn: { type: "complete", message: value.message },
      normalized: true,
      normalizedFrom: "readonlyCompleteWithPageId",
    };
  }

  if (
    hasOnlyKeys(value, ["type", "message"])
    && value.type === "completed"
    && nonEmptyMessage(value.message)
  ) {
    return { turn: { type: "complete", message: value.message }, normalized: true, normalizedFrom: "completedAlias" };
  }

  if (
    hasOnlyKeys(value, ["message", "action"])
    && nonEmptyMessage(value.message)
    && isRecord(value.action)
    && hasOnlyKeys(value.action, ["type"])
    && (value.action.type === "complete" || value.action.type === "completed")
  ) {
    return {
      turn: { type: "complete", message: value.message },
      normalized: true,
      normalizedFrom: value.action.type === "completed" ? "completedAlias" : "legacyEnvelope",
    };
  }

  if (
    hasOnlyKeys(value, ["message"])
    && nonEmptyMessage(value.message)
  ) {
    return { turn: { type: "complete", message: value.message }, normalized: true, normalizedFrom: "readonlyTextSummary" };
  }

  return undefined;
}

export function normalizeHarnessModelTurn(
  candidate: unknown,
  options: HarnessActionNormalizationOptions,
): HarnessActionNormalizationResult {
  const canonical = harnessModelTurnSchema.safeParse(candidate);
  if (canonical.success) return { turn: canonical.data, normalized: false };

  if (options.readonlyTask && options.readonlyResultComplete) {
    const normalized = readonlyAlias(candidate, options);
    if (normalized) return normalized;
  }

  throw new HarnessActionProtocolError(
    `DeepSeek Harness 动作未通过 Schema 校验（${redactedShape(candidate)}；Schema 问题：${redactedIssues(candidate)}）。`,
  );
}
