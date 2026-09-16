import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { connectionCatalogSchema, connectionSchemaSchema, type ConnectionDescriptor, type ConnectionSchema } from "@/core/connections/contracts";
import { projectHeaders } from "@/core/projects/client";

export function ConnectionBrowser({ onConnections, onQuery, disabled }: {
  onConnections: (connections: ConnectionDescriptor[]) => void;
  onQuery: (connectionId: string, sql?: string) => void; disabled: boolean;
}) {
  const [connections, setConnections] = useState<ConnectionDescriptor[]>([]);
  const [schema, setSchema] = useState<{ id: string; data: ConnectionSchema } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/connections", { headers: projectHeaders(), signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("无法读取数据库连接");
      const data = connectionCatalogSchema.parse(await response.json());
      if (controller.signal.aborted) return;
      setConnections(data.connections); onConnections(data.connections); setMessage("");
    }).catch(() => { if (!controller.signal.aborted) { setConnections([]); onConnections([]); setMessage("无法读取数据库连接，请稍后刷新。"); } });
    return () => controller.abort();
  }, [onConnections, revision]);
  async function inspect(id: string, action: "test" | "schema", refresh = false) {
    const controller = new AbortController();
    requestRef.current?.abort(); requestRef.current = controller;
    setBusy(true); setMessage("");
    if (!refresh) { setSchema(null); setSearch(""); }
    try {
      const response = await fetch("/api/connections", { method: "POST", headers: projectHeaders({ "content-type": "application/json" }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(16_000)]), body: JSON.stringify({ connectionId: id, action, refresh }) });
      const raw = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) {
        const failure = z.object({ error: z.object({ message: z.string() }) }).safeParse(raw);
        throw new Error(failure.success ? failure.data.error.message : "连接操作失败");
      }
      if (action === "schema") setSchema({ id, data: connectionSchemaSchema.parse(raw) });
      else setMessage("连接测试通过。");
    } catch (error) { if (!controller.signal.aborted) setMessage(`${error instanceof Error ? error.message : "连接操作失败"}${refresh ? "；仍显示上次同步的目录。" : ""}`); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  const columns = schema?.data.columns.filter((column) => [column.table_catalog, column.table_schema, column.table_name, column.column_name].join(".").toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
  return <details className="notebook-connections"><summary>数据库连接 · {connections.length}</summary>
    <p>选择连接查询数据库，结果可直接接入 DataRecipe 和图表。</p>
    {!connections.length && <p>当前项目尚未配置数据库连接。配置只读连接后，刷新即可使用；也可以继续用导入数据分析。</p>}
    <button type="button" disabled={busy} onClick={() => { setSchema(null); setRevision((value) => value + 1); }}>刷新连接</button>
    {connections.map((connection) => <div className="notebook-connection" key={connection.id}>
      <b>{connection.name}</b><span>{connection.kind} · {connection.allowAi ? "已授权 Agent" : "仅手动查询"}</span>
      <button type="button" disabled={busy} onClick={() => void inspect(connection.id, "test")}>测试连接</button>
      <button type="button" disabled={busy} onClick={() => void inspect(connection.id, "schema")}>浏览字段</button>
      <button type="button" disabled={disabled || busy} onClick={() => onQuery(connection.id)}>新建 SQL</button>
    </div>)}
    <p aria-live="polite">{busy ? "正在读取连接…" : message}</p>
    {schema && <section className="connection-catalog" aria-label="数据库字段目录">
      <div className="connection-catalog-toolbar"><div><b>数据目录{schema.data.catalog ? ` · v${schema.data.catalog.revision}` : ""}</b>
        <p>{schema.data.catalog ? `${schema.data.catalog.tableCount} 张表 / 视图 · ${schema.data.columns.length} 个字段 · ${schema.data.catalog.storage === "persistent" ? "已保存目录" : "本次运行目录"}` : `${schema.data.columns.length} 个字段`}</p></div>
        <button type="button" disabled={busy} onClick={() => void inspect(schema.id, "schema", true)}>同步目录</button></div>
      {schema.data.catalog && <p>同步于 {new Date(schema.data.catalog.syncedAt).toLocaleString("zh-CN")} · 仅记录结构，业务数据以查询结果为准。</p>}
      <label>搜索表与字段<input aria-label="搜索数据库表与字段" value={search} maxLength={160} placeholder="数据库、schema、表名或字段名…" onChange={(event) => setSearch(event.target.value)} /></label>
      <p role="status">匹配 {columns.length} 个字段。{schema.data.truncated ? "当前目录不完整，仅同步前 500 列；未匹配不代表源库不存在该对象。" : ""}</p>
      <div className="notebook-table-scroll" tabIndex={0} aria-label="数据库字段目录表格，可横向滚动">
      <table><thead><tr><th>数据库 / 表</th><th>字段</th><th>类型</th><th>操作</th></tr></thead><tbody>{columns.map((column, index) => <tr key={column.column_id ?? index}><td>{column.table_catalog && <small>{column.table_catalog}</small>}{column.table_schema}.{column.table_name}</td><td>{column.column_name}</td><td>{column.data_type}</td><td><button type="button" disabled={disabled || busy} onClick={() => {
        const quote = connections.find((item) => item.id === schema.id)?.kind === "databricks" ? "`" : '"';
        const identifier = (value: string) => quote + value.replaceAll(quote, quote + quote) + quote;
        const parts = quote === "`" && column.table_catalog ? [column.table_catalog, column.table_schema, column.table_name] : [column.table_schema, column.table_name];
        onQuery(schema.id, `SELECT * FROM ${parts.map(identifier).join(".")} LIMIT 100`);
      }}>查询表</button></td></tr>)}</tbody></table></div>
      {!columns.length && <p>没有匹配的字段，可以调整搜索词或同步目录。</p>}
    </section>}
  </details>;
}
