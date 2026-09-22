import { z } from "zod";
import { sanitizeHarnessText } from "./security";

export function toolInputSchema(schema: z.ZodType): Record<string, unknown> {
  // Model arguments are inputs: defaults make a field optional, not required.
  // Bounds and tagged unions must agree with the canonical execution contract.
  const json = z.toJSONSchema(schema, { io: "input" });
  return Object.fromEntries(Object.entries(json).filter(([key]) => key !== "$schema"));
}

/** Share identical schemas after tool-specific schema assembly.
 * Each tool remains a self-contained JSON Schema; execution still uses Zod.
 * Keep bounds/defaults alongside patterns rather than dropping generation rules.
 */
export function shareToolSchemaPatterns(schema: Record<string, unknown>): Record<string, unknown> {
  // These values are literal data, not locations where JSON Schema resolves refs.
  const literals = new Set(["const", "enum", "default", "examples"]);
  function mapEntries(value: object, visit: (item: unknown) => unknown) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, literals.has(key) ? item : visit(item)]));
  }
  // Do not rewrite an already reference-based schema or risk name collisions.
  function hasReferenceScope(value: unknown): boolean {
    return Boolean(value && typeof value === "object" && ("$ref" in value || "$id" in value || "$defs" in value
      || Object.values(value).some(hasReferenceScope)));
  }
  if (hasReferenceScope(schema)) return schema;
  const occurrences = new Map<string, number>();
  function schemaKey(value: unknown): string | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const typed = "type" in value && typeof value.type === "string"
      && ["string", "integer", "number", "boolean", "null", "array", "object"].includes(value.type);
    const union = "oneOf" in value && Array.isArray(value.oneOf) || "anyOf" in value && Array.isArray(value.anyOf);
    if (!typed && !union) return;
    // Never move a nested reference or a schema's scope into another definition.
    if ("$ref" in value || "$id" in value || "$defs" in value) return;
    return JSON.stringify(value);
  }
  function count(value: unknown): void {
    const key = schemaKey(value);
    if (key !== undefined) occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
    if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => { if (!literals.has(key)) count(item); });
  }
  count(schema);
  const names = new Map([...occurrences].filter(([key, total]) => total > 1
    && key.length * total > key.length + total * 25 + 20).map(([key], index) => [key, `p${index}`]));
  if (!names.size) return schema;
  function replace(value: unknown): unknown {
    const key = schemaKey(value);
    const name = key === undefined ? undefined : names.get(key);
    if (name) return { $ref: `#/$defs/${name}` };
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") return mapEntries(value, replace);
    return value;
  }
  const root = mapEntries(schema, replace);
  const definitions = new Map([...names].map(([key, name]) => [name,
    mapEntries(JSON.parse(key) as Record<string, unknown>, replace),
  ]));
  const reachable = new Set<string>();
  function collect(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if ("$ref" in value && typeof value.$ref === "string" && value.$ref.startsWith("#/$defs/")) {
      const name = value.$ref.slice("#/$defs/".length);
      if (reachable.has(name)) return;
      reachable.add(name);
      collect(definitions.get(name));
    } else Object.entries(value).forEach(([key, item]) => { if (!literals.has(key)) collect(item); });
  }
  collect(root);
  const shared = { ...root, $defs: Object.fromEntries([...definitions].filter(([name]) => reachable.has(name))) };
  return JSON.stringify(shared).length < JSON.stringify(schema).length ? shared : schema;
}

/** Diagnostics may contain only schema-owned facts, not rejected values/messages. */
export function summarizeToolArgumentIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.slice(0, 6).map((issue) => {
    const path = sanitizeHarnessText(issue.path.length ? issue.path.map(String).join(".") : "$").slice(0, 100);
    let expected = "";
    switch (issue.code) {
      case "invalid_format":
        if (issue.format === "regex" && issue.pattern) expected = `；要求 ${issue.pattern}`;
        break;
      case "invalid_type": expected = `；要求 ${issue.expected}`; break;
      case "too_big": expected = `；要求 ${issue.origin} ${issue.inclusive ? "<=" : "<"} ${issue.maximum}`; break;
      case "too_small": expected = `；要求 ${issue.origin} ${issue.inclusive ? ">=" : ">"} ${issue.minimum}`; break;
      case "invalid_value": expected = `；允许 ${issue.values.slice(0, 8).map(String).join(" | ")}${issue.values.length > 8 ? " | …" : ""}`; break;
      case "unrecognized_keys": expected = "；不允许未定义字段"; break;
      case "custom": expected = "；检查工具说明中的互斥、唯一性或依赖约束"; break;
    }
    const fieldHint = issue.code === "invalid_format" && expected && /(?:columns|categoryField|valueFields)(?:\.\d+)?$/u.test(path)
      ? "；用上游 fields.name 或已定义输出别名，不用 label；中文放 title"
      : issue.code === "invalid_format" && expected && /(?:dimensions|measures)\.\d+$/u.test(path)
        ? "；用已选语义模型的 dimensions/measures.key，不用 label" : "";
    return sanitizeHarnessText(`${path}:${issue.code}${expected}${fieldHint}`).slice(0, 240);
  });
}
