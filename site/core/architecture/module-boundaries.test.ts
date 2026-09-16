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
    for (const entry of ["definition.ts", "contracts.ts", "execution-contracts.ts", "graph.ts", "client-state.ts", "transform.ts", "dashboard.ts"]) {
      expect([...reachable(`core/notebook/${entry}`, declaredGraph)].filter((name) => name.startsWith("core/harness/")), entry).toEqual([]);
    }
    for (const entry of [...sources.keys()].filter((name) => name.startsWith("components/studio/notebook/"))) {
      expect((declaredGraph.get(entry) ?? []).filter((name) => name.startsWith("core/harness/")), entry).toEqual([]);
    }
  });

  it("Notebook execution depends on ports, not the default engine or log storage", () => {
    const dependencies = [...reachable("core/notebook/server/execution.ts", declaredGraph)];
    expect(dependencies.filter((name) => name === "core/notebook/server/runtime.ts" || name === "core/notebook/server/query-engine.ts"
      || name === "core/notebook/server/query-log.ts" || name.startsWith("core/persistence/server/") || name.startsWith("core/harness/"))).toEqual([]);
    expect(dependencies.flatMap((name) => direct.get(name) ?? []).filter((ref) => ["node:fs", "node:fs/promises", "node:child_process", "pg"].includes(ref))).toEqual([]);
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
});
