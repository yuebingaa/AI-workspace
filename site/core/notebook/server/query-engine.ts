import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { NOTEBOOK_LIMITS, notebookSqlTableSchema, notebookTableSchema, type NotebookSqlTable, type NotebookTable } from "../contracts";
import { normalizeNotebookSql } from "../sql";

let activeQueries = 0;
export async function executeNotebookSql(sql: string, tables: NotebookSqlTable[], signal?: AbortSignal, timeoutMs: number = NOTEBOOK_LIMITS.queryTimeoutMs): Promise<NotebookTable> {
  const normalized = normalizeNotebookSql(sql);
  if (activeQueries >= 2) throw new Error("已有两个本地查询运行中，请稍后重试");
  if (signal?.aborted) throw new Error("查询已取消");
  if (tables.length > 10) throw new Error("每个查询最多引用 10 个输入表");
  const parsed = tables.map((table) => notebookSqlTableSchema.parse(table));
  if (new Set(parsed.map((table) => table.name)).size !== parsed.length) throw new Error("输入表名称重复");
  const payload = JSON.stringify({ sql: normalized, tables: parsed });
  if (Buffer.byteLength(payload) > NOTEBOOK_LIMITS.inputBytes) throw new Error("查询输入超过 16 MiB，请减少输入数据");
  const bundled = resolve(process.cwd(), "vendor/notebook/query-worker.cjs");
  const script = existsSync(bundled) ? bundled : resolve(process.cwd(), "scripts/notebook-query-worker.cjs");
  if (!existsSync(script)) throw new Error("此部署未包含本地 DuckDB 查询运行时，请使用本机 Node 版本");
  activeQueries++;
  try {
    return await new Promise<NotebookTable>((fulfill, reject) => {
      const child = spawn(process.execPath, ["--max-old-space-size=192", script], {
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        // Never pass API keys, database credentials, NODE_OPTIONS or inherited preload scripts.
        env: { NODE_ENV: "production", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          ...(existsSync(bundled) ? { NOTEBOOK_WASM_PATH: resolve(process.cwd(), "vendor/notebook/duckdb-eh.wasm") } : {}) },
      });
      let bytes = 0;
      const chunks: Buffer[] = [];
      let failure: Error | undefined;
      const stop = (message: string) => { failure ??= new Error(message); child.kill(); };
      const abort = () => stop("查询已取消，查询进程已终止");
      const timer = setTimeout(() => stop("查询超时，查询进程已终止"), Math.max(1, Math.min(timeoutMs, NOTEBOOK_LIMITS.queryTimeoutMs)));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > NOTEBOOK_LIMITS.outputBytes) stop("查询结果超过 2 MiB");
        else chunks.push(chunk);
      });
      // Do not echo DuckDB diagnostics into shared server logs (SQL may contain data).
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.on("error", () => { failure = new Error("无法启动本地查询进程"); });
      child.on("close", (code) => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (failure) { reject(failure); return; }
        try {
          const output = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          if (output && typeof output === "object" && "error" in output) throw new Error(String(output.error));
          if (code !== 0) throw new Error("本地查询进程异常退出，可能超过内存限制");
          fulfill(notebookTableSchema.parse(output));
        } catch (error) { reject(error instanceof Error ? error : new Error("查询返回格式异常")); }
      });
      child.stdin.end(payload);
    });
  } finally { activeQueries--; }
}
