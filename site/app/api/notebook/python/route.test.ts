import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const mocks = vi.hoisted(() => ({ runtimeInfo: vi.fn() }));
vi.mock("@/core/notebook/server/python-runtime", () => ({
  notebookPythonRuntimeInfo: mocks.runtimeInfo,
}));

import { GET } from "./route";

const request = () => new Request("http://127.0.0.1:3001/api/notebook/python");
let root: string;
function installMarker() {
  mkdirSync(join(root, "vendor", "python"), { recursive: true });
  writeFileSync(join(root, "vendor", "python", "runtime-lock.json"), "presence only; runtime info is a fixture");
}

describe("Notebook Python capability status API", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentcanvas-python-api-presence-"));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.stubEnv("NOTEBOOK_PYTHON_ENABLED", "true");
    mocks.runtimeInfo.mockReset().mockResolvedValue({
      engine: "pyodide",
      available: true,
      pythonVersion: "3.14.2",
      packages: { pandas: "3.0.2" },
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs(); vi.restoreAllMocks();
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "agentcanvas-python-api-presence-"))) throw new Error("Unsafe fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  });

  it("reports enabled separately from runtime availability", async () => {
    installMarker();
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      engine: "pyodide",
      enabled: true,
      available: true,
      pythonVersion: "3.14.2",
    });
    expect(mocks.runtimeInfo).toHaveBeenCalledTimes(1);
  });

  it("does not probe or load the Python runtime when the capability is disabled", async () => {
    vi.stubEnv("NOTEBOOK_PYTHON_ENABLED", "off");
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      engine: "pyodide",
      enabled: false,
      available: false,
      reason: "Python Notebook 能力已通过服务器配置关闭",
    });
    expect(mocks.runtimeInfo).not.toHaveBeenCalled();
  });

  it("returns an explicit configuration error for invalid values", async () => {
    vi.stubEnv("NOTEBOOK_PYTHON_ENABLED", "sometimes");
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining("NOTEBOOK_PYTHON_ENABLED 配置无效") },
    });
    expect(mocks.runtimeInfo).not.toHaveBeenCalled();
  });

  it("disables a missing resource deployment without loading the runtime and rechecks on the next request", async () => {
    const missing = await GET(new Request("http://127.0.0.1:3001/api/notebook/python?enabled=true&rootDirectory=ignored"));
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ enabled: false, available: false, reason: expect.stringContaining("未包含 Python 资源") });
    expect(mocks.runtimeInfo).not.toHaveBeenCalled();
    installMarker();
    mocks.runtimeInfo.mockResolvedValueOnce({ engine: "pyodide", available: false, reason: "synthetic asset hash failure" });
    const incomplete = await GET(request());
    expect(await incomplete.json()).toMatchObject({ enabled: true, available: false, reason: "synthetic asset hash failure" });
    expect(mocks.runtimeInfo).toHaveBeenCalledTimes(1);
    expect(await (await GET(request())).json()).toMatchObject({ enabled: true, available: true });
    expect(mocks.runtimeInfo).toHaveBeenCalledTimes(2);
  });
});
