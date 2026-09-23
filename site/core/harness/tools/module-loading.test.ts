import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../tool-registry");
  vi.doUnmock("./registry");
  vi.resetModules();
});

describe("isolated tool module loading", () => {
  it.each([
    { name: "data tools", load: () => import("./dataset") },
    { name: "contracts", load: () => import("./contracts") },
    { name: "errors", load: () => import("./errors") },
    { name: "observations", load: () => import("./observation") },
    { name: "parameter projection", load: () => import("./parameter-projection") },
  ])("loads $name without initializing all business tools", async ({ load }) => {
    vi.resetModules();
    const initializeRegistry = vi.fn(() => {
      throw new Error("A leaf tool module initialized the complete tool registry");
    });
    vi.doMock("../tool-registry", initializeRegistry);
    vi.doMock("./registry", initializeRegistry);

    await load();

    expect(initializeRegistry).not.toHaveBeenCalled();
  });

  it("keeps the legacy entry and narrow modules on the same runtime objects", async () => {
    const legacy = await import("../tool-registry");
    const errors = await import("./errors");
    const executor = await import("./executor");
    const catalog = await import("./catalog");
    const observation = await import("./observation");
    const registry = await import("./registry");
    const { StudioValidationError } = await import("@/core/schemas/errors");

    expect(legacy.HarnessToolArgumentsError).toBe(errors.HarnessToolArgumentsError);
    expect(legacy.executeHarnessTool).toBe(executor.executeHarnessTool);
    expect(legacy.harnessToolCatalog).toBe(catalog.harnessToolCatalog);
    expect(legacy.compactHarnessToolResult).toBe(observation.compactHarnessToolResult);
    expect(legacy.harnessToolRegistry).toBe(registry.harnessToolRegistry);
    const error = new errors.HarnessToolArgumentsError("inspectDataset", ["dataSourceId: invalid_type"]);
    expect(error).toBeInstanceOf(legacy.HarnessToolArgumentsError);
    expect(error).toBeInstanceOf(StudioValidationError);
  });

  it("registers every public tool exactly once with its matching name", async () => {
    const { harnessToolRegistry } = await import("./registry");
    const { harnessToolNameSchema } = await import("../contracts");

    expect(Object.keys(harnessToolRegistry).sort()).toEqual([...harnessToolNameSchema.options].sort());
    for (const [name, tool] of Object.entries(harnessToolRegistry)) expect(tool.name).toBe(name);
  });
});
