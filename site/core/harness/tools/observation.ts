import type { HarnessToolExecutionResult } from "../contracts";
import { preserveNotebookTextResultMetadata } from "../notebook-text-results";
import { StudioValidationError } from "@/core/schemas/errors";

export const MAX_HARNESS_TOOL_RESULT_BYTES = 6_000;

export const DEFAULT_HARNESS_TOOL_RESULT_ENTRIES = 16;

function truncateString(value: string, limit = 300) {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function compactValue(value: unknown, maxEntries: number, depth = 0): unknown {
  if (typeof value === "string") return truncateString(value, depth === 0 ? 500 : 220);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 5) return "[已省略深层结果]";
  if (Array.isArray(value)) {
    const items = value.slice(0, maxEntries).map((item) => compactValue(item, Math.max(3, Math.floor(maxEntries / 2)), depth + 1));
    return value.length > maxEntries ? [...items, { truncated: true, omittedCount: value.length - maxEntries }] : items;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const selected = entries.slice(0, maxEntries).map(([key, child]) => [key, compactValue(child, Math.max(3, Math.floor(maxEntries / 2)), depth + 1)]);
  if (entries.length > maxEntries) selected.push(["truncated", true], ["omittedPropertyCount", entries.length - maxEntries]);
  return Object.fromEntries(selected);
}

export function compactHarnessToolResult(
  result: HarnessToolExecutionResult,
  maxChars = MAX_HARNESS_TOOL_RESULT_BYTES,
  maxEntries = DEFAULT_HARNESS_TOOL_RESULT_ENTRIES,
  preservation: { keys?: readonly string[]; atomicArrays?: readonly string[]; textResults?: boolean } = {},
): HarnessToolExecutionResult {
  if (JSON.stringify(result.data).length <= maxChars) return result;
  const preserveTextResults = preservation.textResults === true && result.data !== null
    && typeof result.data === "object" && !Array.isArray(result.data)
    && "textResults" in result.data && Array.isArray(result.data.textResults);
  // Counting rules and their scalar profile are atomic evidence: never leave
  // behind a number while silently removing the population/denominator.
  const preserved = result.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? Object.fromEntries(Object.entries(result.data).filter(([key]) => preservation.keys?.includes(key)))
    : {};
  const atomicArrays = result.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? Object.entries(result.data).filter(([key, value]) => preservation.atomicArrays?.includes(key) && Array.isArray(value))
      .map(([key, values]) => [key, (values as unknown[]).map((value) => (
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).filter(([field]) => field !== "samples")) : value
      ))] as const)
    : [];
  const retain = (value: unknown, limit: number) => {
    const retained = value && typeof value === "object" && !Array.isArray(value) ? { ...value, ...preserved,
      ...Object.fromEntries(atomicArrays.map(([key, values]) => [key, values.slice(0, limit)])),
      ...(atomicArrays.length ? { truncated: true } : {}),
    } : value;
    return preserveTextResults ? preserveNotebookTextResultMetadata(result.data, retained) : retained;
  };
  let data = retain(compactValue(result.data, maxEntries), maxEntries);
  let pass = 0;
  while (JSON.stringify(data).length > maxChars && pass < 3) {
    const limit = Math.max(2, Math.floor(maxEntries / (2 ** (pass + 1))));
    data = retain(compactValue(data, limit), limit);
    pass += 1;
  }
  if (JSON.stringify(data).length > maxChars) {
    const fallback = { truncated: true, summaryOnly: truncateString(result.summary, Math.max(preserveTextResults ? 0 : 80, maxChars - (preserveTextResults ? 160 : 80))) };
    data = preserveTextResults ? preserveNotebookTextResultMetadata(result.data, fallback) : fallback;
  }
  if (JSON.stringify(data).length > maxChars) {
    throw new StudioValidationError("Harness 工具结果过大", ["工具结果压缩后仍超过上下文预算"]);
  }
  return {
    ...result,
    summary: `${result.summary}（结果已按上下文预算截断）`,
    data,
  };
}
