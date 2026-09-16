/** Share identical pattern leaves after tool-specific schema assembly.
 * Each tool remains a self-contained JSON Schema; execution still uses Zod.
 */
export function shareToolSchemaPatterns(schema: Record<string, unknown>): Record<string, unknown> {
  // Do not rewrite an already reference-based schema or risk name collisions.
  if (schema.$defs) return schema;
  const occurrences = new Map<string, number>();
  function patternOf(value: unknown): string | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (!("type" in value) || value.type !== "string" || !("pattern" in value) || typeof value.pattern !== "string") return;
    if (Object.keys(value).some((key) => key !== "type" && key !== "pattern")) return;
    return value.pattern;
  }
  function count(value: unknown): void {
    const pattern = patternOf(value);
    if (pattern !== undefined) occurrences.set(pattern, (occurrences.get(pattern) ?? 0) + 1);
    else if (value && typeof value === "object") Object.values(value).forEach(count);
  }
  count(schema);
  const names = new Map([...occurrences].filter(([, total]) => total > 1).map(([pattern], index) => [pattern, `p${index}`]));
  if (!names.size) return schema;
  function replace(value: unknown): unknown {
    const pattern = patternOf(value);
    const name = pattern === undefined ? undefined : names.get(pattern);
    if (name) return { $ref: `#/$defs/${name}` };
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    return value;
  }
  const shared = {
    ...Object.fromEntries(Object.entries(schema).map(([key, item]) => [key, replace(item)])),
    $defs: Object.fromEntries([...names].map(([pattern, name]) => [name, { type: "string", pattern }])),
  };
  return JSON.stringify(shared).length < JSON.stringify(schema).length ? shared : schema;
}
