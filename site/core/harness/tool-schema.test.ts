import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { shareToolSchemaPatterns, summarizeToolArgumentIssues } from "./tool-schema";
import { executeHarnessTool, harnessToolCatalog, HarnessToolArgumentsError } from "./tool-registry";
import { semanticFixture } from "@/core/semantic/test-fixture";
import type { HarnessRequest } from "./contracts";
import { cellSearchSchema, editNotebookCellsSchema } from "./notebook-cell-tools";
import { notebookDraftSchema } from "@/core/notebook/definition";

function fixture() {
  const { product, source, model, rows } = semanticFixture();
  const request: HarnessRequest = { idempotencyKey: "schema_test", instruction: "Python 清洗数据", pageId: "page_home", role: "editor",
    appSpec: product.appSpec, recipes: [], semanticModel: model,
    notebookContext: { document: { name: "test", revision: 0, cells: [] }, sourceIds: [source.id] } };
  return { request, source, context: { request, dataRuntime: { rowsByDataSourceId: { [source.id]: rows } },
    now: () => Date.parse("2026-09-16T00:00:00.000Z"), id: vi.fn(() => "schema_artifact"),
    notebookCellSession: { document: request.notebookContext!.document, editVersion: 0 } } };
}

function withoutDialect(schema: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema"));
}

function restrictCellKinds(schema: { properties?: Record<string, unknown> }, excluded: string[]) {
  const cells = schema.properties!.cells as { items: { oneOf: Array<{ properties: { kind: { const: string } } }> } };
  cells.items.oneOf = cells.items.oneOf.filter((variant) => !excluded.includes(variant.properties.kind.const));
}

function omitUnrequestedChartConfig(schema: { properties?: Record<string, unknown> }, withGraphicWalker: boolean) {
  if (withGraphicWalker) return;
  delete schema.properties!.charts;
  const cells = schema.properties!.cells as { items: { oneOf: Array<{ properties: Record<string, unknown> & { kind: { const: string } } }> } };
  const chart = cells.items.oneOf.find(variant => variant.properties.kind.const === "chart");
  expect(chart?.properties.graphicWalker).toBeDefined();
  delete chart!.properties.graphicWalker;
}

const optionalEditorContracts = [false, true].flatMap(withParameters => [false, true].map(withGraphicWalker => ({ withParameters, withGraphicWalker })));

function cellKinds(schema: unknown): string[] {
  const shape = z.object({ properties: z.object({ cells: z.object({ items: z.object({
    oneOf: z.array(z.object({ properties: z.object({ kind: z.object({ const: z.string() }) }) })),
  }) }) }) }).parse(schema);
  return shape.properties.cells.items.oneOf.map((variant) => variant.properties.kind.const);
}

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
    const nestedReference = { type: "object", properties: { reference: { $ref: "urn:shared:schema" } } };
    expect(shareToolSchemaPatterns(nestedReference)).toBe(nestedReference);
  });

  it("shares repeated bounded scalars and arrays without changing any defaults or restrictions", () => {
    const item = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]*$", minLength: 1, maxLength: 120 };
    const schema = { type: "object", additionalProperties: false, properties: Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [`fields${index}`, { type: "array", minItems: 1, maxItems: index % 2 + 1, items: item }]),
    ) };
    const before = structuredClone(schema);
    const compacted = shareToolSchemaPatterns(schema);
    expect(compacted.$defs).toBeDefined();
    expect(JSON.stringify(compacted).length).toBeLessThan(JSON.stringify(schema).length);
    expect(expanded(compacted)).toEqual(before);
    expect(schema).toEqual(before);
  });

  it("does not rewrite schema-looking literal defaults or enum values into references", () => {
    const literal = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]*$", minLength: 1, maxLength: 120 };
    const schema = { type: "object", properties: Object.fromEntries([
      ...Array.from({ length: 16 }, (_, index) => [`field${index}`, literal]),
      ["preset", { type: "object", default: literal, enum: [literal] }],
    ]) };
    const compacted = shareToolSchemaPatterns(schema);
    expect(compacted).toMatchObject({ properties: { preset: { default: literal, enum: [literal] } } });
    expect(expanded(compacted)).toEqual(schema);
  });

  it("bounds diagnostic count and length and never copies custom refinement messages", () => {
    const schema = z.object({ items: z.array(z.string().max(1)), option: z.string().refine(() => false, "private-user-input") }).strict();
    const result = schema.safeParse({ items: Array.from({ length: 10 }, () => "sk-synthetic-secret-not-for-errors"), option: "private-user-input" });
    if (result.success) throw new Error("invalid fixture");
    const summaries = summarizeToolArgumentIssues(result.error.issues);
    expect(summaries).toHaveLength(6);
    expect(summaries.every((summary) => summary.length <= 240)).toBe(true);
    expect(summaries[0]).toBe("items.0:too_big；要求 string <= 1");
    const custom = summarizeToolArgumentIssues(result.error.issues.filter((issue) => issue.code === "custom"));
    expect(custom).toEqual(["option:custom；检查工具说明中的互斥、唯一性或依赖约束"]);
    expect(JSON.stringify([...summaries, ...custom])).not.toMatch(/private-user-input|synthetic-secret/u);
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
          columns: expect.objectContaining({ minItems: 1, maxItems: 30,
            items: { type: "string", minLength: 1, maxLength: 120, pattern: "^[A-Za-z][A-Za-z0-9_]*$" } }),
          title: { type: "string", minLength: 1, maxLength: 120 },
        }) }),
      ]) } } } });
    }
  });

  it("preserves exact dependency cardinalities in the analysis-plan catalog", () => {
    const { request } = fixture();
    const [tool] = harnessToolCatalog({ names: ["createAnalysisPlan"], request });
    expect(expanded(tool.parameters)).toMatchObject({ properties: {
      steps: { minItems: 1, maxItems: 30, items: { oneOf: expect.arrayContaining([
        expect.objectContaining({ properties: expect.objectContaining({ kind: { const: "data", type: "string" }, dependsOn: expect.objectContaining({ maxItems: 0 }) }) }),
        ...["table", "chart", "semanticQuery", "transform"].map((kind) => expect.objectContaining({ properties: expect.objectContaining({
          kind: { const: kind, type: "string" }, dependsOn: expect.objectContaining({ minItems: 1, maxItems: 1 }),
        }) })),
        expect.objectContaining({ properties: expect.objectContaining({ kind: { const: "sql", type: "string" }, dependsOn: expect.objectContaining({ minItems: 1, maxItems: 10 }) }) }),
      ]) } },
    } });
  });

  it("uses the input contract for defaulted search arguments without losing ranges", () => {
    const { request } = fixture();
    const [tool] = harnessToolCatalog({ names: ["cellSearch"], request });
    expect(expanded(tool.parameters)).toEqual(withoutDialect(z.toJSONSchema(cellSearchSchema, { io: "input" })));
    expect(expanded(tool.parameters)).toMatchObject({ properties: { depth: { minimum: 1, maximum: 30, default: 30 },
      sourceOffset: { minimum: 0, maximum: 80_000, default: 0 }, query: { maxLength: 160 } } });
  });

  it.each(optionalEditorContracts)("keeps canonical transform variants, parameters=$withParameters, Graphic Walker=$withGraphicWalker", ({ withParameters, withGraphicWalker }) => {
    const { request } = fixture();
    if (withParameters) request.instruction += "，使用参数";
    if (withGraphicWalker) request.instruction += "，使用 Graphic Walker";
    const [tool] = harnessToolCatalog({ names: ["createNotebookDraft"], request });
    const canonical = z.toJSONSchema(notebookDraftSchema, { io: "input" });
    restrictCellKinds(canonical, ["warehouseSql", ...withParameters ? [] : ["parameter"]]);
    omitUnrequestedChartConfig(canonical, withGraphicWalker);
    expect(expanded(tool.parameters)).toEqual(withoutDialect(canonical));
  });

  it.each(optionalEditorContracts)("keeps edit bounds and defaults, parameters=$withParameters, Graphic Walker=$withGraphicWalker", ({ withParameters, withGraphicWalker }) => {
    const { request } = fixture();
    if (withParameters) request.instruction += "，使用参数";
    if (withGraphicWalker) request.instruction += "，使用 Graphic Walker";
    const [tool] = harnessToolCatalog({ names: ["editNotebookCells"], request });
    const canonical = z.toJSONSchema(editNotebookCellsSchema, { io: "input" });
    restrictCellKinds(canonical, ["warehouseSql", "python", ...withParameters ? [] : ["parameter"]]);
    omitUnrequestedChartConfig(canonical, withGraphicWalker);
    expect(expanded(tool.parameters)).toEqual(withoutDialect(canonical));
    expect(expanded(tool.parameters)).toMatchObject({ properties: { cells: { maxItems: 10 }, removeCellIds: { default: [], maxItems: 10 } } });
  });

  it("scopes draft kinds and plan ID to the latest validated plan without restricting replanning or edits", async () => {
    const { request, context, source } = fixture();
    context.id.mockReturnValueOnce("first_plan").mockReturnValueOnce("second_plan");
    const first = await executeHarnessTool("createAnalysisPlan", { name: "说明", objective: "解释数据", questions: ["口径是什么"], deliverables: ["narrative"], steps: [
      { id: "data", kind: "data", title: "数据", objective: "读取数据", dependsOn: [], sourceDataSourceId: source.id },
      { id: "note", kind: "text", title: "说明", objective: "说明范围", dependsOn: [], narrativeGoal: "解释分析口径" },
    ] }, context);
    if (!first.analysisPlanArtifact) throw new Error("missing plan");
    const second = await executeHarnessTool("createAnalysisPlan", { name: "数据", objective: "预览数据", questions: ["数据是什么"], deliverables: ["table"], steps: [
      { id: "data", kind: "data", title: "数据", objective: "读取数据", dependsOn: [], sourceDataSourceId: source.id },
      { id: "table", kind: "table", title: "预览", objective: "预览数据", dependsOn: ["data"], columns: ["region"] },
    ] }, context);
    if (!second.analysisPlanArtifact) throw new Error("missing plan");
    const [firstTool] = harnessToolCatalog({ names: ["createNotebookDraft"], request, analysisPlan: first.analysisPlanArtifact });
    const [secondTool] = harnessToolCatalog({ names: ["createNotebookDraft"], request, analysisPlan: second.analysisPlanArtifact });
    expect(cellKinds(expanded(firstTool.parameters))).toEqual(["data", "text"]);
    expect(cellKinds(expanded(secondTool.parameters))).toEqual(["data", "table"]);
    expect(expanded(secondTool.parameters)).toMatchObject({ required: expect.arrayContaining(["analysisPlanId"]),
      properties: { analysisPlanId: { const: second.analysisPlanArtifact.id } } });
    expect(JSON.stringify(secondTool.parameters)).not.toContain(first.analysisPlanArtifact.id);
    expect(harnessToolCatalog({ names: ["createAnalysisPlan", "editNotebookCells"], request, analysisPlan: first.analysisPlanArtifact }))
      .toEqual(harnessToolCatalog({ names: ["createAnalysisPlan", "editNotebookCells"], request }));
    const [unplanned] = harnessToolCatalog({ names: ["createNotebookDraft"], request });
    expect(cellKinds(expanded(unplanned.parameters))).toContain("transform");
    expect(expanded(unplanned.parameters)).toMatchObject({ required: ["name", "cells"] });
  });

  it("continues to allow a removal-only edit with zero new cells", async () => {
    const { context } = fixture();
    context.notebookCellSession.document.cells.push({ id: "data", kind: "data", title: "数据",
      sourceDataSourceId: context.request.notebookContext!.sourceIds[0], outputName: "source_data" });
    context.notebookCellSession.document.cells.push({ id: "old_note", kind: "text", title: "旧说明", markdown: "合成说明" });
    const result = await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [], removeCellIds: ["old_note"] }, context);
    expect(result.data).toMatchObject({ editVersion: 1 });
    expect(context.notebookCellSession.document.cells.map((cell) => cell.id)).toEqual(["data"]);
  });

  it("reports dependency bounds without executing an invalid plan, then accepts the corrected plan", async () => {
    const { context, source } = fixture();
    const plan = { name: "test", objective: "检查字段", questions: ["显示数据"], deliverables: ["table"], steps: [
      { id: "data", kind: "data", title: "数据", objective: "读取数据", dependsOn: [], sourceDataSourceId: source.id },
      { id: "table", kind: "table", title: "表格", objective: "显示数据", dependsOn: ["data"], columns: ["region"] },
    ] };
    const invalid = structuredClone(plan);
    invalid.steps[1].dependsOn = ["data", "sk-synthetic-secret-not-for-errors"];
    await expect(executeHarnessTool("createAnalysisPlan", invalid, context)).rejects.toMatchObject({
      issueSummary: [expect.stringContaining("steps.1.dependsOn:too_big；要求 array <= 1")],
    });
    expect(context.id).not.toHaveBeenCalled();
    const result = await executeHarnessTool("createAnalysisPlan", plan, context);
    expect(result.data).toMatchObject({ status: "planned" });
    expect(context.id).toHaveBeenCalledOnce();
  });

  it("reports search types, ranges and enum choices without echoing supplied values", async () => {
    const { context } = fixture();
    try {
      await executeHarnessTool("cellSearch", { query: ["sk-synthetic-secret-not-for-errors"], depth: 0, view: "private-choice" }, context);
      throw new Error("invalid arguments must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessToolArgumentsError);
      if (!(error instanceof HarnessToolArgumentsError)) throw error;
      expect(error.issueSummary).toEqual(expect.arrayContaining([
        expect.stringContaining("query:invalid_type；要求 string"),
        expect.stringContaining("depth:too_small；要求 number >= 1"),
        expect.stringContaining("view:invalid_value；允许"),
      ]));
      expect(error.message).not.toContain("synthetic-secret");
      expect(error.message).not.toContain("private-choice");
    }
    expect(context.id).not.toHaveBeenCalled();
  });

  it("allows omitted search defaults and does not invent missing cells", async () => {
    const { context } = fixture();
    const result = await executeHarnessTool("cellSearch", {}, context);
    expect(result.data).toMatchObject({ totalCells: 0, matchedCount: 0, cells: [], runStatus: "notRun" });
  });
});
