import { describe, expect, it } from "vitest";
import { shareToolSchemaPatterns } from "./tool-schema";
import { harnessToolCatalog } from "./tool-registry";
import { semanticFixture } from "@/core/semantic/test-fixture";
import type { HarnessRequest } from "./contracts";

function expanded(schema: Record<string, unknown>): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(schema, (key, value: unknown) => {
    if (key === "$defs") return undefined;
    if (value && typeof value === "object" && "$ref" in value && typeof value.$ref === "string") {
      expect(value.$ref).toMatch(/^#\/\$defs\/p\d+$/u);
      const name = value.$ref.slice("#/$defs/".length);
      const definition = Object.entries(schema.$defs ?? {}).find(([key]) => key === name)?.[1];
      expect(definition, `unresolved ${value.$ref}`).toBeDefined();
      return definition;
    }
    return value;
  }));
  return copy;
}

describe("compact model tool patterns", () => {
  it("shares repeated rules losslessly without mutating the execution schema", () => {
    const schema = { type: "object", additionalProperties: false,
      properties: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]*$" }])) };
    const before = structuredClone(schema);
    const compacted = shareToolSchemaPatterns(schema);
    expect(compacted.$defs).toBeDefined();
    expect(JSON.stringify(compacted).length).toBeLessThan(JSON.stringify(schema).length);
    expect(expanded(compacted)).toEqual(schema);
    expect(schema).toEqual(before);
  });

  it("keeps other constraints, free text and existing references unchanged", () => {
    const schema = { type: "object", properties: { title: { type: "string" }, field: { type: "string", pattern: "^a$", maxLength: 1 } } };
    expect(shareToolSchemaPatterns(schema)).toEqual(schema);
    const referenced = { ...schema, $defs: { p0: { type: "string" } } };
    expect(shareToolSchemaPatterns(referenced)).toBe(referenced);
  });

  it.each(["createAnalysisPlan", "createNotebookDraft", "editNotebookCells", "createPythonCell", "cellSearch"] as const)("%s has self-contained references after scoped assembly", (name) => {
    const { product, source } = semanticFixture();
    const request: HarnessRequest = { idempotencyKey: "schema_test", instruction: "Python 分析数据", pageId: "page_home", role: "editor",
      appSpec: product.appSpec, recipes: [], notebookContext: { document: { name: "test", revision: 0, cells: [] }, sourceIds: [source.id] } };
    const [tool] = harnessToolCatalog({ names: [name], request });
    expect(expanded(tool.parameters)).toMatchObject({ type: "object", additionalProperties: false });
    if (name !== "cellSearch") expect(JSON.stringify(expanded(tool.parameters))).toContain('"pattern":"^[A-Za-z][A-Za-z0-9_]*$"');
    if (name === "createNotebookDraft" || name === "editNotebookCells") {
      const root = expanded(tool.parameters);
      expect(root).toMatchObject({ properties: { cells: { items: { oneOf: expect.arrayContaining([
        expect.objectContaining({ properties: expect.objectContaining({
          kind: expect.objectContaining({ const: "table" }),
          columns: expect.objectContaining({ items: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]*$" } }),
          title: { type: "string" },
        }) }),
      ]) } } } });
    }
  });
});
