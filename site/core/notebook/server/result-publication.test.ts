import { describe, expect, it, vi } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import type { NotebookDocument, NotebookTable } from "../contracts";
import type { NotebookResultPublisher } from "../result-access";
import { executeNotebook } from "./execution";
import { createNotebookResultCapture } from "./result-capture";
import { runNotebook } from "./runtime";

function fixture() {
  const { source } = semanticFixture();
  const rows = Array.from({ length: 1324 }, (_, index) => ({ region: `Region ${index}`, amount: index }));
  const document: NotebookDocument = { name: "Full result capture", revision: 3, cells: [
    { id: "target", kind: "transform", title: "Complete output", inputCellId: "data", outputName: "copied", steps: [{ id: "all", type: "limit", count: 1324 }] },
    { id: "data", kind: "data", title: "Source", sourceDataSourceId: source.id, outputName: "sales" },
  ] };
  const table: NotebookTable = { fields: source.fields.map(({ name, label, type }) => ({ name, label, type })), rows, truncated: false };
  return { document, sources: [{ source, rows }], table };
}

function pythonDocument(): NotebookDocument {
  return { name: "Python cleanup", revision: 3, cells: [
    { id: "target", kind: "python", title: "Python", inputCellIds: [], fileNames: [], outputName: "copied", code: "copied = pd.DataFrame({'value': [1]})" },
  ] };
}

describe("complete result publication only after a successful request-owned run", () => {
  it("hands off complete transform data while keeping the existing 100/1000-row preview protocol", async () => {
    const { document, sources } = fixture();
    const capture = createNotebookResultCapture({ cellId: "target", revision: 3, accessMode: "user" });
    const publishResult = vi.fn<NotebookResultPublisher>(capture.publishResult);
    const run = await runNotebook({ document, sources, targetCellId: "target", publishResult, log: vi.fn() });
    expect(run.status).toBe("success");
    expect(run.cells[0].table?.rows).toHaveLength(100);
    expect(run.cells[1].table?.rows).toHaveLength(1000);
    expect(run.cells[1].table?.truncated).toBe(true);
    expect(run.cells[1].resultRef).toMatchObject({ complete: true, rowCount: 1324, accessMode: "user" });
    expect(publishResult).toHaveBeenCalledTimes(1);
    const saved = capture.read(run.cells[1].resultRef!);
    expect(saved.rows).toHaveLength(1324);
    expect(saved.rows.at(-1)).toEqual({ region: "Region 1323", amount: 1323 });
    expect(saved.truncated).toBe(false);
    capture.dispose();
  });

  it("does not publish an actually truncated DuckDB result as a complete table", async () => {
    const { document, sources } = fixture();
    document.cells[0] = { id: "target", kind: "sql", title: "Too many rows", inputCellIds: ["data"], outputName: "copied", sql: "SELECT i AS value FROM range(1324) t(i)" };
    const publishResult = vi.fn<NotebookResultPublisher>();
    const run = await runNotebook({ document, sources, targetCellId: "target", publishResult, log: vi.fn() });
    expect(run.status).toBe("success");
    expect(run.cells[1].table?.rows).toHaveLength(1000);
    expect(run.cells[1].resultRef?.complete).toBe(false);
    expect(publishResult).not.toHaveBeenCalled();
  }, 15_000);

  it("publishes Python's complete table only after the session closes successfully", async () => {
    const { table } = fixture();
    const calls: string[] = [];
    const publishResult = vi.fn<NotebookResultPublisher>(({ table: published }) => {
      expect(calls).toEqual(["execute", "close"]);
      expect(published.rows).toHaveLength(1324);
      calls.push("publish");
    });
    const run = await executeNotebook({ document: pythonDocument(), sources: [], targetCellId: "target" }, {
      query: vi.fn(), log: vi.fn(), publishResult,
      python: async () => ({ execute: async () => { calls.push("execute"); return { table, stdout: "", stderr: "" }; },
        close: async () => { calls.push("close"); } }),
    });
    expect(run.cells[0].table?.rows).toHaveLength(1000);
    expect(run.cells[0].resultRef?.complete).toBe(true);
    expect(publishResult).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["execute", "close", "publish"]);
  });

  it.each(["close-failure", "cancel-during-close"])("never publishes after %s", async (kind) => {
    const { table } = fixture();
    const controller = new AbortController();
    const publishResult = vi.fn<NotebookResultPublisher>();
    const running = executeNotebook({ document: pythonDocument(), sources: [], targetCellId: "target", signal: controller.signal }, {
      query: vi.fn(), log: vi.fn(), publishResult,
      python: async () => ({ execute: async () => ({ table, stdout: "", stderr: "" }), close: async () => {
        if (kind === "close-failure") throw new Error("synthetic close failure");
        controller.abort();
      } }),
    });
    await expect(running).rejects.toThrow();
    expect(publishResult).not.toHaveBeenCalled();
  });

  it("does not publish any result when a run fails or no target was explicitly selected", async () => {
    const { document, sources } = fixture();
    const publishResult = vi.fn<NotebookResultPublisher>();
    const plain = await executeNotebook({ document, sources }, { query: vi.fn(), log: vi.fn(), publishResult });
    expect(plain.status).toBe("success");
    expect(publishResult).not.toHaveBeenCalled();
    document.cells[0] = { id: "target", kind: "sql", title: "Failure", inputCellIds: ["data"], outputName: "failed", sql: "SELECT missing FROM sales" };
    const failed = await executeNotebook({ document, sources, targetCellId: "target" }, {
      query: vi.fn().mockRejectedValue(new Error("synthetic failure")), log: vi.fn(), publishResult,
    });
    expect(failed.status).toBe("failure");
    expect(publishResult).not.toHaveBeenCalled();
  });

  it.each(["invalid-receipt", "log-failure", "late-cancel"])("does not hand off a result after %s", async (kind) => {
    const { document, sources, table } = fixture();
    document.cells[0] = { id: "target", kind: "sql", title: "Query", inputCellIds: ["data"], outputName: "copied", sql: "SELECT * FROM sales" };
    const controller = new AbortController();
    const publishResult = vi.fn<NotebookResultPublisher>();
    const running = executeNotebook({ document, sources, targetCellId: "target", signal: controller.signal }, {
      query: async () => {
        if (kind === "late-cancel") controller.abort();
        return { ...table, rows: [{ region: "Synthetic", amount: kind === "invalid-receipt" ? Number.NaN : 1 }] };
      },
      log: () => { if (kind === "log-failure") throw new Error("synthetic log failure"); }, publishResult,
    });
    if (kind === "late-cancel") expect((await running).status).toBe("failure");
    else await expect(running).rejects.toThrow();
    expect(publishResult).not.toHaveBeenCalled();
  });

  it("rejects a save publication failure without adding the save-only limit to ordinary runs", async () => {
    const { document, sources } = fixture();
    const failure = new Error("synthetic save capture refused");
    await expect(executeNotebook({ document, sources, targetCellId: "target" }, {
      query: vi.fn(), log: vi.fn(), publishResult: () => { throw failure; },
    })).rejects.toBe(failure);
    expect((await executeNotebook({ document, sources, targetCellId: "target" }, { query: vi.fn(), log: vi.fn() })).status).toBe("success");
  });

  it("keeps an ordinary complete run valid when only the 4 MiB save capture is too large", async () => {
    const { document, sources } = fixture();
    sources[0].rows = Array.from({ length: 6000 }, (_, amount) => ({ region: "汉".repeat(240), amount }));
    sources[0].source.rowCount = 6000;
    const target = document.cells[0];
    if (target.kind !== "transform") throw new Error("Synthetic fixture must contain a transform");
    target.steps = [{ id: "all", type: "limit", count: 6000 }];
    const run = await executeNotebook({ document, sources, targetCellId: "target" }, { query: vi.fn(), log: vi.fn() });
    expect(run.status).toBe("success");
    expect(run.cells[1].resultRef).toMatchObject({ complete: true, rowCount: 6000 });
    expect(run.cells[1].table?.rows).toHaveLength(1000);
    const capture = createNotebookResultCapture({ cellId: "target", revision: 3, accessMode: "user" });
    await expect(executeNotebook({ document, sources, targetCellId: "target" }, {
      query: vi.fn(), log: vi.fn(), publishResult: capture.publishResult,
    })).rejects.toThrow("4 MiB");
    expect(() => capture.read(run.cells[1].resultRef!)).toThrow("没有可保存的完整结果");
    capture.dispose();
  });

  it("publishes no raw sensitive source values in an AI-mode result", async () => {
    const { document, sources } = fixture();
    sources[0].source = { ...sources[0].source, aiAccessPolicy: "masked", fields: sources[0].source.fields.map((field) =>
      field.name === "region" ? { ...field, sensitiveCategories: ["name"] } : field) };
    const capture = createNotebookResultCapture({ cellId: "target", revision: 3, accessMode: "ai" });
    const run = await executeNotebook({ document, sources, targetCellId: "target", forAi: true }, {
      query: vi.fn(), log: vi.fn(), publishResult: capture.publishResult,
    });
    const saved = capture.read(run.cells[1].resultRef!);
    expect(saved.rows).toHaveLength(1324);
    expect(JSON.stringify(saved)).not.toContain("Region 1323");
    expect(saved.rows[0]).toEqual({ region: "匿名_1", amount: 0 });
    capture.dispose();
  });
});
