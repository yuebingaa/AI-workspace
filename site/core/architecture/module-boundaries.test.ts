import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Inspect actual source imports, not built output or dependencies. Type-only cycles
// are not runtime cycles. Literal dynamic import/require edges are included.
const root = process.cwd();
const sources = new Map<string, string>();
const clientEntries = new Set<string>();
function collect(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec|d)\./.test(entry.name)) {
      sources.set(relative(root, path).replaceAll("\\", "/"), readFileSync(path, "utf8"));
    }
  }
}
for (const directory of ["app", "components", "adapters", "core", "fixtures"]) collect(resolve(root, directory));

function imports(source: string, name: string, includeTypes = false): string[] {
  const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  if (tree.statements.some((node) => ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === "use client")) clientEntries.add(name);
  const result: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (!includeTypes && clause?.isTypeOnly) return;
      if (!includeTypes && clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((item) => item.isTypeOnly)) return;
      result.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!includeTypes && (node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.length > 0 && node.exportClause.elements.every((item) => item.isTypeOnly)))) return;
      result.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) result.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return result;
}
const direct = new Map([...sources].map(([name, source]) => [name, imports(source, name)]));
function local(source: string, specifier: string): string | undefined {
  const path = specifier.startsWith("@/") ? specifier.slice(2)
    : specifier.startsWith(".") ? posix.normalize(posix.join(dirname(source).replaceAll("\\", "/"), specifier)) : undefined;
  if (!path) return;
  return [path, path + ".ts", path + ".tsx", path + "/index.ts", path + "/index.tsx"].find((name) => sources.has(name));
}
function dependencyGraph(references: Map<string, string[]>) {
  return new Map([...references].map(([name, refs]) => [name, refs.flatMap((ref) => {
    const target = local(name, ref); return target ? [target] : [];
  })]));
}
const graph = dependencyGraph(direct);
const declaredGraph = dependencyGraph(new Map([...sources].map(([name, source]) => [name, imports(source, name, true)])));
function reachable(start: string, dependencies = graph): Set<string> {
  const visited = new Set<string>();
  const visit = (name: string) => { if (visited.has(name)) return; visited.add(name); dependencies.get(name)?.forEach(visit); };
  visit(start); return visited;
}
function cycles(): string[][] {
  const index = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], active = new Set<string>(), result: string[][] = [];
  function visit(name: string) {
    const next = index.size;
    index.set(name, next); low.set(name, next); stack.push(name); active.add(name);
    for (const target of graph.get(name) ?? []) {
      if (!index.has(target)) { visit(target); low.set(name, Math.min(low.get(name)!, low.get(target)!)); }
      else if (active.has(target)) low.set(name, Math.min(low.get(name)!, index.get(target)!));
    }
    if (low.get(name) !== index.get(name)) return;
    const group: string[] = [];
    let member: string;
    do { member = stack.pop()!; active.delete(member); group.push(member); } while (member !== name);
    if (group.length > 1 || graph.get(name)?.includes(name)) result.push(group.sort());
  }
  for (const name of graph.keys()) if (!index.has(name)) visit(name);
  return result;
}

describe("runtime module boundaries", () => {
  it("tool implementations do not depend on their registry, catalog or execution coordinator", () => {
    const coordinators = new Set([
      "core/harness/tool-registry.ts", "core/harness/tools/registry.ts",
      "core/harness/tools/catalog.ts", "core/harness/tools/executor.ts",
      "core/harness/tools/parameter-projection.ts", "core/harness/runtime.ts",
    ]);
    for (const toolModule of ["dataset", "workbook", "semantic", "notebook", "dashboard", "external"]) {
      const entry = `core/harness/tools/${toolModule}.ts`;
      expect(sources.has(entry), entry).toBe(true);
      expect([...reachable(entry, declaredGraph)].filter((name) => coordinators.has(name)), entry).toEqual([]);
      expect([...reachable(entry)].filter((name) => name.includes("/server/")
        || name.startsWith("app/") || name.startsWith("components/")), entry).toEqual([]);
    }
  });

  it("tool contracts, errors, observations and schema projection can load without the tool registry", () => {
    const registry = "core/harness/tools/registry.ts";
    for (const toolModule of ["contracts", "errors", "observation", "parameter-projection"]) {
      const entry = `core/harness/tools/${toolModule}.ts`;
      expect(sources.has(entry), entry).toBe(true);
      const dependencies = [...reachable(entry)];
      expect(dependencies, entry).not.toContain(registry);
      expect(dependencies, entry).not.toContain("core/harness/tool-registry.ts");
      expect(dependencies, entry).not.toContain("core/harness/tools/executor.ts");
    }
    expect(direct.get("core/harness/tools/contracts.ts")).toEqual([]);
    expect([...reachable("core/harness/tools/parameter-projection.ts", declaredGraph)]).not.toContain(registry);
    for (const entry of ["core/agent-engines/server/tool-broker.ts", "core/agent-engines/server/tool-error-message.ts"]) {
      expect(declaredGraph.get(entry), entry).toContain("core/harness/tools/errors.ts");
      expect(declaredGraph.get(entry), entry).not.toContain("core/harness/tool-registry.ts");
    }
  });

  it("execution engine settings share only portable contracts; legacy runtime does not depend on DSH", () => {
    const contract = "core/agent-engines/contracts.ts";
    expect([...reachable(contract, declaredGraph)]).toEqual([contract]);
    const view = "components/studio/AgentEngineSettings.tsx";
    expect([...reachable(view, declaredGraph)]).toContain(contract);
    expect([...reachable(view, declaredGraph)].filter((name) => name.includes("/server/") || name.startsWith("core/harness/"))).toEqual([]);
    for (const entry of ["core/harness/runtime.ts", "core/harness/agents/coordinator.ts"]) {
      expect([...reachable(entry, declaredGraph)].filter((name) => name.startsWith("core/agent-engines/") || name.startsWith("runtime/dsh/"))).toEqual([]);
    }
    const adapter = "core/agent-engines/server/dsh-engine.ts";
    expect([...reachable(adapter)]).not.toContain("core/harness/runtime.ts");
    expect([...reachable(adapter)]).not.toContain("core/ai/server/deepseek-harness-model.ts");
  });
  it("project inspection views depend on a read-only DTO, not project installation or execution", () => {
    const entries = ["core/projects/inspection.ts", "core/projects/inspection-client.ts", "components/studio/projects/ProjectInspectionPanel.tsx"];
    for (const entry of entries) {
      expect(sources.has(entry)).toBe(true);
      const dependencies = [...reachable(entry, declaredGraph)];
      expect(dependencies.filter((name) => name.includes("/server/") || name.startsWith("core/harness/")
        || name === "core/projects/client.ts" || name === "core/projects/contracts.ts"
        || name === "core/projects/state-repository.ts" || name.endsWith("LocalProjectsProvider.tsx"))).toEqual([]);
    }
    for (const entry of ["core/notebook/definition.ts", "core/notebook/server/execution.ts", "core/projects/state-repository.ts"]) {
      expect([...reachable(entry, declaredGraph)]).not.toContain("core/projects/server/inspection.ts");
    }
  });
  it("project compatibility diagnostics stay portable and do not relax executable Cell schemas", () => {
    const entry = "core/projects/compatibility.ts";
    expect(sources.has(entry)).toBe(true);
    const dependencies = [...reachable(entry, declaredGraph)];
    expect(dependencies.filter((name) => name.includes("/server/") || name.startsWith("core/harness/")
      || name.startsWith("components/") || name.startsWith("app/") || name === "core/projects/client.ts")).toEqual([]);
    for (const name of dependencies) {
      expect(imports(sources.get(name)!, name, true).filter((specifier) => /^(?:node:|react(?:\/|$)|pg$|@duckdb\/)/u.test(specifier))).toEqual([]);
    }
    expect([...reachable("core/notebook/definition.ts", declaredGraph)]).not.toContain(entry);
    expect([...reachable("core/notebook/contracts.ts", declaredGraph)]).not.toContain(entry);
  });
  it("Notebook dashboard review and policy remain portable and do not own persistence or execution", () => {
    for (const entry of ["core/notebook/dashboard-review.ts", "core/notebook/dashboard-policy.ts"]) {
      expect(sources.has(entry)).toBe(true);
      const dependencies = [...reachable(entry, declaredGraph)];
      expect(dependencies.filter((name) => name.includes("/server/") || name.startsWith("core/harness/")
        || name.startsWith("core/projects/") || name.startsWith("components/") || name.startsWith("app/"))).toEqual([]);
      for (const name of dependencies) {
        expect(imports(sources.get(name)!, name, true).filter((specifier) => /^(?:node:|react(?:\/|$)|pg$|@duckdb\/)/u.test(specifier))).toEqual([]);
      }
    }
  });
  it("dashboard rendering accepts review content without importing Notebook execution or review internals", () => {
    const dependencies = [...reachable("components/studio/DataProductCanvas.tsx")];
    expect(dependencies.filter((name) => name.includes("/server/")
      || ["core/notebook/dashboard-review.ts", "core/notebook/dashboard-policy.ts", "core/notebook/dashboard.ts"].includes(name))).toEqual([]);
  });
  it("CSV serialization depends on portable tables, not Notebook policy or browser/server effects", () => {
    const entry = "core/exports/table-csv.ts";
    expect(sources.has(entry)).toBe(true);
    const dependencies = [...reachable(entry, declaredGraph)];
    expect(dependencies.filter((name) => name.includes("/server/") || name.startsWith("core/notebook/")
      || name.startsWith("core/harness/") || name.startsWith("components/") || name.startsWith("app/"))).toEqual([]);
    expect(dependencies.flatMap((name) => direct.get(name) ?? []).filter((ref) => ref === "react"
      || ref.startsWith("react/") || ref.startsWith("node:") || ref.startsWith("next/") || ref === "pg")).toEqual([]);
    expect(sources.get(entry)).not.toMatch(/\b(?:window|document|localStorage|sessionStorage)\s*\./u);
  });

  it("browser download has no infrastructure imports and the Excel compatibility export shares its implementation", () => {
    const entry = "core/exports/browser-download.ts";
    expect(sources.has(entry)).toBe(true);
    expect(direct.get(entry)).toEqual([]);
    expect(graph.get("components/studio/ExcelDownloadButton.tsx")).toContain(entry);
    expect(sources.get("components/studio/ExcelDownloadButton.tsx")).not.toContain("URL.createObjectURL");
    expect(graph.get("components/studio/notebook/NotebookResultTable.tsx")).toContain(entry);
  });

  it("dependency scheduling, output rename analysis and search stay independent of UI, Harness and server adapters", () => {
    for (const entry of ["core/notebook/graph.ts", "core/notebook/search.ts", "core/notebook/output-renames.ts"]) {
      expect(sources.has(entry), entry).toBe(true);
      const dependencies = [...reachable(entry, declaredGraph)];
      expect(dependencies.filter((name) => name.startsWith("core/harness/") || name.includes("/server/")
        || name.startsWith("app/") || name.startsWith("components/")), entry).toEqual([]);
      expect(dependencies.flatMap((name) => direct.get(name) ?? []).filter((ref) => ref === "react"
        || ref.startsWith("react/") || ref.startsWith("next/") || ref.startsWith("node:") || ref === "pg"), entry).toEqual([]);
    }
  });
  it("shared table shapes depend only on schema validation, not Notebook policy or execution", () => {
    const entry = "core/datasets/table-contracts.ts";
    expect(sources.has(entry)).toBe(true);
    expect([...reachable(entry, declaredGraph)]).toEqual([entry]);
    expect(direct.get(entry)).toEqual(["zod"]);
  });
  it("Dataset repository ports and SQL preflight do not initialize infrastructure", () => {
    for (const entry of ["core/datasets/repository.ts", "core/sql/read-only-query.ts"]) {
      expect(sources.has(entry), entry).toBe(true);
      expect([...reachable(entry)], entry).toEqual([entry]);
      expect(direct.get(entry), entry).toEqual([]);
    }
  });
  it("connection code owns query policy without depending on Notebook definitions or limits", () => {
    for (const entry of [...sources.keys()].filter((name) => name.startsWith("core/connections/"))) {
      expect([...reachable(entry, declaredGraph)].filter((name) => name.startsWith("core/notebook/")), entry).toEqual([]);
    }
  });
  it("project storage can use Dataset errors without loading the temporary repository singleton", () => {
    expect([...reachable("core/projects/server/store.ts")]).not.toContain("core/datasets/server/dataset-repository.ts");
  });
  it("Dataset statistics remain pure and shared without UI, Harness or infrastructure dependencies", () => {
    const entry = "core/datasets/quality-profile.ts";
    expect([...reachable(entry)]).toEqual([entry]);
    expect(direct.get(entry)).toEqual([]);
  });
  it("Cell catalog and table/chart projection have no runtime dependencies", () => {
    for (const entry of ["core/notebook/cell-catalog.ts", "core/notebook/presentation-table.ts"]) {
      expect(sources.has(entry), entry).toBe(true);
      expect([...reachable(entry)], entry).toEqual([entry]);
      expect(direct.get(entry), entry).toEqual([]);
    }
  });
  it("Cell presentation and default creation cannot load React, Harness or server effects", () => {
    for (const entry of ["components/studio/notebook/cell-presentation.ts", "components/studio/notebook/cell-creation.ts"]) {
      expect(sources.has(entry), entry).toBe(true);
      const dependencies = [...reachable(entry)];
      expect(dependencies.filter((name) => name.includes("/server/") || name.startsWith("app/")
        || name.startsWith("core/harness/") || name.endsWith(".tsx")), entry).toEqual([]);
      expect(dependencies.flatMap((name) => direct.get(name) ?? []).filter((ref) => ref === "react"
        || ref.startsWith("react/") || ref.startsWith("next/") || ref.startsWith("node:") || ref === "pg"), entry).toEqual([]);
    }
  });
  it("Input Inspector cannot read files, run queries/code or call models", () => {
    const dependencies = [...reachable("core/harness/input-inspector.ts")];
    expect(dependencies.sort()).toEqual(["core/harness/input-inspector.ts", "core/harness/security.ts"]);
  });
  it("metadata use cases depend on catalog ports without importing consumers or adapters", () => {
    const dependencies = [...reachable("core/metadata/catalog-service.ts", declaredGraph)];
    expect(dependencies.filter((name) => !name.startsWith("core/metadata/") || name.includes("/server/"))).toEqual([]);
    expect(dependencies.flatMap((name) => direct.get(name) ?? []).filter((ref) => ref.startsWith("node:") || ref === "pg")).toEqual([]);
  });
  it("distinguishes runtime imports from type-only dependencies", () => {
    expect(imports('import type { A } from "type-a"; import { type B } from "type-b"; export type * from "type-c"; import { A, type C } from "runtime"; import("lazy"); require("native");', "fixture.ts"))
      .toEqual(["runtime", "lazy", "native"]);
    expect(imports('import type { A } from "type-a"; export type { B } from "type-b"; import { C } from "runtime";', "fixture.ts", true))
      .toEqual(["type-a", "type-b", "runtime"]);
  });

  it("has no runtime import cycles in application source", () => {
    expect(cycles()).toEqual([]);
  });

  it("does not pull model or database infrastructure into Harness orchestration", () => {
    for (const entry of ["core/harness/runtime.ts", "core/harness/agents/coordinator.ts"]) {
      expect([...reachable(entry)].filter((name) => name.startsWith("core/ai/server/") || name.startsWith("core/connections/server/")
        || name === "core/harness/deepseek-harness.ts"), entry).toEqual([]);
    }
  });

  it("query application depends on ports, not concrete configuration readers or drivers", () => {
    const dependencies = [...reachable("core/connections/server/query-service.ts")];
    expect(dependencies.filter((name) => name === "core/connections/server/config.ts" || name.startsWith("core/connections/server/drivers/"))).toEqual([]);
    expect(dependencies.flatMap((name) => direct.get(name) ?? []).filter((ref) => ref === "pg" || ref.startsWith("node:"))).toEqual([]);
  });

  it("Notebook owns its definitions without runtime or type-only dependencies on Harness", () => {
    for (const entry of ["definition.ts", "cell-catalog.ts", "presentation-table.ts", "result-access.ts", "result-availability.ts", "contracts.ts", "execution-contracts.ts", "graph.ts", "client-state.ts", "transform.ts", "dashboard.ts"]) {
      expect([...reachable(`core/notebook/${entry}`, declaredGraph)].filter((name) => name.startsWith("core/harness/")), entry).toEqual([]);
    }
    for (const entry of [...sources.keys()].filter((name) => name.startsWith("components/studio/notebook/"))) {
      expect((declaredGraph.get(entry) ?? []).filter((name) => name.startsWith("core/harness/")), entry).toEqual([]);
    }
  });

  it("Notebook execution depends on ports, not the default engine or log storage", () => {
    const dependencies = [...reachable("core/notebook/server/execution.ts", declaredGraph)];
    expect(dependencies.filter((name) => name === "core/notebook/server/runtime.ts" || name === "core/notebook/server/query-engine.ts"
      || name === "core/notebook/server/query-log.ts" || name === "core/notebook/server/result-capture.ts"
      || name.startsWith("core/persistence/server/") || name.startsWith("core/harness/"))).toEqual([]);
    expect(dependencies.flatMap((name) => direct.get(name) ?? []).filter((ref) => ["node:fs", "node:fs/promises", "node:child_process", "pg"].includes(ref))).toEqual([]);
  });

  it("Notebook result contracts and availability remain independent of UI and server storage", () => {
    for (const entry of ["core/notebook/result-access.ts", "core/notebook/result-availability.ts"]) {
      expect(sources.has(entry), entry).toBe(true);
      const dependencies = [...reachable(entry, declaredGraph)];
      expect(dependencies.filter((name) => name.includes("/server/") || name.startsWith("components/") || name.startsWith("app/")), entry).toEqual([]);
      expect(dependencies.flatMap((name) => direct.get(name) ?? []).filter((ref) => ref === "react" || ref.startsWith("react/") || ref.startsWith("node:") || ref === "pg"), entry).toEqual([]);
    }
  });

  it("Notebook trial receipt consistency belongs to a pure shared module used by all Harness consumers", () => {
    const entry = "core/notebook/run-receipt.ts";
    expect(sources.has(entry)).toBe(true);
    const dependencies = [...reachable(entry, declaredGraph)];
    expect(dependencies.filter((name) => name.includes("/server/") || name.startsWith("core/harness/")
      || name.startsWith("app/") || name.startsWith("components/"))).toEqual([]);
    expect(dependencies.flatMap((name) => direct.get(name) ?? []).filter((ref) => ref.startsWith("node:")
      || ref === "react" || ref.startsWith("react/") || ref.startsWith("next/") || ref === "pg")).toEqual([]);
    for (const consumer of ["core/harness/tools/notebook.ts", "core/harness/notebook-cell-tools.ts", "core/harness/notebook-diagnostics.ts"]) {
      expect(declaredGraph.get(consumer), consumer).toContain(entry);
    }
    expect([...reachable("core/harness/tool-registry.ts", declaredGraph)]).toContain(entry);
  });

  it("Notebook preview sorting is pure while table interaction and chart rendering are separate", () => {
    const preview = "core/notebook/table-preview.ts";
    expect(sources.has(preview)).toBe(true);
    expect(direct.get(preview)).toEqual([]);
    const table = "components/studio/notebook/NotebookResultTable.tsx";
    const dependencies = [...reachable(table)];
    expect(dependencies.filter((name) => name.includes("/server/") || name.startsWith("core/harness/")
      || name.endsWith("/NotebookChart.tsx") || name.endsWith("/NotebookPanel.tsx"))).toEqual([]);
    expect(dependencies.flatMap((name) => direct.get(name) ?? [])).not.toContain("recharts");
    expect(direct.get("components/studio/notebook/NotebookResult.tsx")).not.toContain("recharts");
    expect(direct.get("components/studio/notebook/NotebookChart.tsx")).toContain("recharts");
  });

  it("Notebook parameter values remain pure and the editor does not import execution infrastructure", () => {
    const domain = "core/notebook/parameter.ts";
    expect(sources.has(domain)).toBe(true);
    const dependencies = [...reachable(domain, declaredGraph)];
    expect(dependencies.filter((name) => name.includes("/server/") || name.startsWith("components/")
      || name.startsWith("app/") || name.startsWith("core/harness/"))).toEqual([]);
    expect(dependencies.flatMap((name) => direct.get(name) ?? []).filter((ref) => ref === "react"
      || ref.startsWith("react/") || ref.startsWith("node:") || ref.startsWith("next/") || ref === "pg")).toEqual([]);
    const editor = "components/studio/notebook/NotebookParameterEditor.tsx";
    expect(declaredGraph.get(editor)).toContain(domain);
    expect([...reachable(editor, declaredGraph)].filter((name) => name.includes("/server/")
      || name.startsWith("core/harness/") || name.endsWith("/NotebookPanel.tsx"))).toEqual([]);
  });

  it("parameter recompute selection and result witnesses stay pure; request ownership stays client-only", () => {
    for (const entry of ["core/notebook/parameter-recompute.ts", "core/notebook/result-cache.ts"]) {
      expect(sources.has(entry), entry).toBe(true);
      const dependencies = [...reachable(entry, declaredGraph)];
      expect(dependencies.filter((name) => name.includes("/server/") || name.startsWith("app/")
        || name.startsWith("components/") || name.startsWith("core/harness/")), entry).toEqual([]);
      expect(dependencies.flatMap((name) => direct.get(name) ?? []).filter((ref) => ref.startsWith("node:")
        || ref === "react" || ref.startsWith("react/") || ref.startsWith("next/") || ref === "pg"), entry).toEqual([]);
    }
    const ownership = "components/studio/notebook/run-control.ts";
    expect(sources.has(ownership)).toBe(true);
    expect(direct.get(ownership)).toEqual([]);
    const scheduling = "components/studio/notebook/useNotebookAutoRun.ts";
    expect(sources.has(scheduling)).toBe(true);
    expect([...reachable(scheduling, declaredGraph)].filter((name) => name.includes("/server/")
      || name.startsWith("core/harness/") || name.startsWith("app/"))).toEqual([]);
  });

  it("persistence scheduling and the project save queue do not depend on UI or HTTP adapters", () => {
    for (const entry of ["core/projects/state-repository.ts", "components/studio/workspace/persistence-controller.ts"]) {
      const dependencies = [...reachable(entry, declaredGraph)];
      expect(dependencies.filter((name) => name === "core/projects/client.ts" || name.includes("/server/")
        || name.startsWith("app/") || (name.startsWith("components/") && name !== entry)), entry).toEqual([]);
      expect(dependencies.flatMap((name) => direct.get(name) ?? []).filter((ref) => ref === "react"
        || ref.startsWith("react/") || ref.startsWith("node:") || ref === "pg"), entry).toEqual([]);
    }
  });

  it("Notebook context selection is pure metadata and its client state cannot reach execution infrastructure", () => {
    const domain = "core/notebook/context-selection.ts";
    expect(sources.has(domain)).toBe(true);
    const dependencies = [...reachable(domain, declaredGraph)];
    expect(dependencies.filter((name) => name.includes("/server/") || name.startsWith("components/")
      || name.startsWith("app/") || name.startsWith("core/harness/"))).toEqual([]);
    expect(dependencies.flatMap((name) => direct.get(name) ?? []).filter((ref) => ref === "react"
      || ref.startsWith("react/") || ref.startsWith("node:") || ref.startsWith("next/") || ref === "pg")).toEqual([]);
    const hook = "components/studio/workspace/useNotebookContextSelection.ts";
    expect(sources.has(hook)).toBe(true);
    expect([...reachable(hook, declaredGraph)].filter((name) => name.includes("/server/")
      || name.startsWith("app/") || name.startsWith("core/harness/"))).toEqual([]);
  });

  it("client entry points cannot import server implementations or private configuration", () => {
    const violations = new Set<string>();
    for (const entry of clientEntries) {
      for (const name of reachable(entry)) {
        if (name.includes("/server/") || name === "core/connections/configuration.ts"
          || name === "core/harness/runtime.ts" || name === "core/harness/deepseek-harness.ts"
          || name === "core/harness/visual-verifier.ts" || name === "core/harness/mcp/runtime.ts") violations.add(`${entry} -> ${name}`);
        for (const ref of direct.get(name) ?? []) {
          if (ref.startsWith("node:") || ref === "pg" || ref.startsWith("@modelcontextprotocol/sdk")) violations.add(`${entry} -> ${name} -> ${ref}`);
        }
      }
    }
    expect([...violations].sort()).toEqual([]);
  });

  it("Python deployment availability stays server-owned and all execution entry points share it", () => {
    const availability = "core/notebook/server/available-capabilities.ts";
    expect(sources.has(availability)).toBe(true);
    for (const entry of ["core/notebook/server/runtime.ts", "app/api/notebook/python/route.ts", "app/api/ai/harness/handler.ts"]) {
      expect(declaredGraph.get(entry), entry).toContain(availability);
      expect(sources.get(entry), entry).not.toContain("notebookCapabilitiesFromEnvironment(");
    }
    const dependencies = [...reachable(availability, declaredGraph)];
    expect(dependencies.filter((name) => name.startsWith("components/") || name.startsWith("core/harness/")
      || name.startsWith("app/") || name.endsWith("python-runtime.ts"))).toEqual([]);
    expect(dependencies.flatMap((name) => direct.get(name) ?? []).filter((ref) => ref === "react"
      || ref === "playwright-core" || ref === "pg")).toEqual([]);
  });

  it("controlled text interpolation stays pure and its editor does not import execution infrastructure", () => {
    const domain = "core/notebook/text-references.ts";
    const dependencies = [...reachable(domain, declaredGraph)];
    expect(dependencies.filter((name) => name.includes("/server/") || name.startsWith("components/")
      || name.startsWith("app/") || name.startsWith("core/harness/"))).toEqual([]);
    expect(dependencies.flatMap((name) => direct.get(name) ?? []).filter((ref) => ref === "react"
      || ref.startsWith("node:") || ref.startsWith("next/") || ref === "pg")).toEqual([]);
    for (const component of ["NotebookTextEditor.tsx", "NotebookTextResult.tsx"]) {
      const source = `components/studio/notebook/${component}`;
      expect([...reachable(source)].filter((name) => name.includes("/server/") || name.startsWith("core/harness/"))).toEqual([]);
      expect(sources.get(source)).not.toMatch(/dangerouslySetInnerHTML|\beval\s*\(|new\s+Function\s*\(/u);
    }
  });
});
