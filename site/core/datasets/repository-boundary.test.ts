import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadImplementation = vi.fn(() => {
  throw new Error("Importing a Dataset port must not initialize the temporary repository");
});

beforeEach(() => {
  vi.resetModules();
  loadImplementation.mockClear();
  // A tripwire, not a real repository: this test cannot load or purge user snapshots.
  vi.doMock("@/core/datasets/server/dataset-repository", loadImplementation);
});
afterEach(() => {
  vi.doUnmock("@/core/datasets/server/dataset-repository");
  vi.resetModules();
});

describe("Dataset repository public import boundary", () => {
  it("imports the public errors without evaluating the temporary repository", async () => {
    const port = await import("./repository");
    expect(new port.DatasetAiAccessPolicyConflictError("synthetic").name).toBe("DatasetAiAccessPolicyConflictError");
    expect(new port.DatasetAiAccessRevokedError("synthetic").datasetId).toBe("synthetic");
    expect(loadImplementation).not.toHaveBeenCalled();
  });

  it("imports the project adapter without initializing the unrelated temporary repository", async () => {
    const project = await import("@/core/projects/server/store");
    expect(typeof project.LocalProjectStore).toBe("function");
    expect(loadImplementation).not.toHaveBeenCalled();
  });
});
