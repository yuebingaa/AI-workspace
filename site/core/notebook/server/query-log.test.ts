import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotebookQueryLogEntry } from "../execution-contracts";
import { recordNotebookQuery } from "./query-log";

const directories: string[] = [];
function directory() {
  const root = mkdtempSync(join(tmpdir(), "notebook-log-refactor-"));
  directories.push(root);
  vi.stubEnv("STUDIO_LOCAL_STATE_DIR", root);
  return { root, file: join(root, "notebook-query-log.json") };
}
function entry(id = "synthetic_query"): NotebookQueryLogEntry {
  return { id, taskId: "synthetic_task", userId: "local", connectionId: "local-duckdb", cellId: "sql",
    startedAt: "2026-09-14T00:00:00.000Z", durationMs: 1, status: "success", sql: "SELECT 1 AS amount",
    sourceIds: ["synthetic_source"], returnedRows: 1, truncated: false, bytesScanned: null };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of directories.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("notebook-log-refactor-")) throw new Error("Unsafe test cleanup target");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Notebook query log adapter compatibility", () => {
  it("keeps logging disabled when no private state directory is configured", () => {
    const { root } = directory();
    vi.stubEnv("STUDIO_LOCAL_STATE_DIR", " ");
    recordNotebookQuery(entry());
    expect(readdirSync(root)).toEqual([]);
  });

  it("reads the existing v1 file and keeps exactly the latest 100 receipts", () => {
    const { file } = directory();
    const previous = Array.from({ length: 100 }, (_, index) => entry(`old_${index}`));
    writeFileSync(file, JSON.stringify({ version: 1, queries: previous }));
    recordNotebookQuery(entry("new"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, queries: [...previous.slice(1), entry("new")] });
  });

  it("resolves the configured store at write time instead of retaining a global path", () => {
    const first = directory();
    recordNotebookQuery(entry("first"));
    const second = directory();
    recordNotebookQuery(entry("second"));
    expect(JSON.parse(readFileSync(first.file, "utf8"))).toEqual({ version: 1, queries: [entry("first")] });
    expect(JSON.parse(readFileSync(second.file, "utf8"))).toEqual({ version: 1, queries: [entry("second")] });
  });

  it("preserves a corrupt old file and rejects extra fields without overwriting receipts", () => {
    const { file } = directory();
    const invalid = '{"version":2,"queries":[]}';
    writeFileSync(file, invalid);
    expect(() => recordNotebookQuery(entry())).toThrow("快照校验失败");
    expect(readFileSync(file, "utf8")).toBe(invalid);
    const valid = JSON.stringify({ version: 1, queries: [entry("old")] });
    writeFileSync(file, valid);
    const withRows = { ...entry("new"), rows: [{ amount: 1 }] };
    expect(() => recordNotebookQuery(withRows)).toThrow();
    expect(readFileSync(file, "utf8")).toBe(valid);
  });
});
