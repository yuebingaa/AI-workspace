import { useEffect, useState } from "react";
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
  async function inspect(id: string, action: "test" | "schema") {
    setBusy(true); setMessage(""); setSchema(null);
    try {
      const response = await fetch("/api/connections", { method: "POST", headers: projectHeaders({ "content-type": "application/json" }), signal: AbortSignal.timeout(16_000), body: JSON.stringify({ connectionId: id, action }) });
      const raw = await response.json();
      if (!response.ok) {
        const failure = z.object({ error: z.object({ message: z.string() }) }).safeParse(raw);
        throw new Error(failure.success ? failure.data.error.message : "连接操作失败");
      }
      if (action === "schema") setSchema({ id, data: connectionSchemaSchema.parse(raw) });
      else setMessage("连接测试通过。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "连接操作失败"); }
    finally { setBusy(false); }
  }
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
    {schema && <div className="notebook-table-scroll"><p>{schema.data.truncated ? "目录只显示前 500 列。" : `${schema.data.columns.length} 个字段。`}</p>
      <table><thead><tr><th>表</th><th>字段</th><th>类型</th><th>操作</th></tr></thead><tbody>{schema.data.columns.map((column, index) => <tr key={index}><td>{column.table_schema}.{column.table_name}</td><td>{column.column_name}</td><td>{column.data_type}</td><td><button type="button" disabled={disabled} onClick={() => {
        const quote = connections.find((item) => item.id === schema.id)?.kind === "databricks" ? "`" : '"';
        const identifier = (value: string) => quote + value.replaceAll(quote, quote + quote) + quote;
        onQuery(schema.id, `SELECT * FROM ${identifier(column.table_schema)}.${identifier(column.table_name)} LIMIT 100`);
      }}>查询表</button></td></tr>)}</tbody></table></div>}
  </details>;
}
