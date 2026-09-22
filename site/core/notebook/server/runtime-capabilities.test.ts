import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_NOTEBOOK_CAPABILITIES } from "../capabilities";
import type { NotebookPythonSession } from "../execution-contracts";
import { runNotebook } from "./runtime";

describe("Notebook runtime capability composition", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("uses the server environment as the final gate and ignores a forged per-request capability", async () => {
    vi.stubEnv("NOTEBOOK_PYTHON_ENABLED", "off");
    const python = vi.fn(async (): Promise<NotebookPythonSession> => ({
      execute: vi.fn(async () => ({
        table: { fields: [], rows: [], truncated: false },
        stdout: "",
        stderr: "",
      })),
      close: vi.fn(async () => undefined),
    }));
    const forgedInput = {
      document: {
        name: "Disabled Python",
        revision: 1,
        cells: [{
          id: "python",
          kind: "python" as const,
          title: "保留的 Python",
          inputCellIds: [],
          fileNames: [],
          outputName: "result",
          code: "result = pd.DataFrame({'value': [1]})",
        }],
      },
      sources: [],
      python,
      log: vi.fn(),
      capabilities: DEFAULT_NOTEBOOK_CAPABILITIES,
    };

    const run = await runNotebook(forgedInput);

    expect(run.status).toBe("failure");
    expect(run.cells).toMatchObject([{
      cellId: "python",
      status: "failure",
      error: "Python Notebook 能力已通过服务器配置关闭",
    }]);
    expect(python).not.toHaveBeenCalled();
  });

  it("blocks a forged capability without resources, preserves independent steps, and recovers after installing the marker", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentcanvas-python-compose-"));
    try {
      vi.stubEnv("NOTEBOOK_PYTHON_ENABLED", "true"); vi.spyOn(process, "cwd").mockReturnValue(root);
      const execute = vi.fn(async () => ({ table: { fields: [{ name: "value", label: "值", type: "number" as const }], rows: [{ value: 1 }], truncated: false }, stdout: "", stderr: "" }));
      const python = vi.fn(async (): Promise<NotebookPythonSession> => ({ execute, close: vi.fn(async () => undefined) }));
      const input = { document: { name: "Preserved Python", revision: 1, cells: [
        { id: "independent", kind: "parameter" as const, title: "独立输入", outputName: "input", parameter: { type: "number" as const, value: 3 } },
        { id: "python", kind: "python" as const, title: "保留定义", inputCellIds: [], fileNames: [], outputName: "result", code: "result = pd.DataFrame({'value': [1]})" },
        { id: "dependent", kind: "table" as const, title: "受阻结果", inputCellId: "python", columns: ["value"] },
      ] }, sources: [], python, log: vi.fn(), capabilities: DEFAULT_NOTEBOOK_CAPABILITIES };
      const before = structuredClone(input.document);
      const unavailable = await runNotebook(input);
      expect(unavailable.status).toBe("failure");
      expect(unavailable.cells).toMatchObject([{ cellId: "independent", status: "success" }, { cellId: "python", status: "failure", error: expect.stringContaining("未包含 Python 资源") }, { cellId: "dependent", status: "blocked" }]);
      expect(python).not.toHaveBeenCalled(); expect(input.document).toEqual(before);
      mkdirSync(join(root, "vendor", "python"), { recursive: true }); writeFileSync(join(root, "vendor", "python", "runtime-lock.json"), "presence only; injected test runtime");
      const restored = await runNotebook(input);
      expect(restored.status).toBe("success"); expect(python).toHaveBeenCalledTimes(1); expect(execute).toHaveBeenCalledTimes(1);
      expect(input.document).toEqual(before);
    } finally {
      vi.restoreAllMocks();
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), "agentcanvas-python-compose-"))) throw new Error("Unsafe fixture cleanup");
      rmSync(root, { recursive: true, force: true });
    }
  });
});
