"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { agentEngineSettingsSchema, type AgentEngineSettings as AgentEngineStatus } from "@/core/agent-engines/contracts";
import { containDialogFocus } from "./dialog-focus";
import "@/app/agent-engine-settings.css";

type Engine = AgentEngineStatus["engine"];
const endpoint = "/api/settings/agent-engine";

export async function readAgentEngineSettingsResponse(response: Response): Promise<AgentEngineStatus> {
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new Error("执行引擎设置响应格式无效，请刷新状态后重试。"); }
  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    const message = error && typeof error === "object" && "message" in error ? error.message : undefined;
    throw new Error(typeof message === "string" ? message.slice(0, 500) : "无法读取或更新执行引擎设置。");
  }
  const parsed = agentEngineSettingsSchema.safeParse(payload);
  if (!parsed.success) throw new Error("执行引擎设置响应格式无效，请刷新状态后重试。");
  return parsed.data;
}

interface ContentProps {
  status: AgentEngineStatus | null;
  selectedEngine: Engine;
  loading: boolean;
  busy: boolean;
  disabled?: boolean;
  needsRefresh?: boolean;
  error?: string;
  notice?: string;
  onEngineChange(engine: Engine): void;
  onRefresh(): void;
  onApply(): void;
  onClose(): void;
}

/** Pure settings view; plugin descriptions are text, never executable configuration. */
export function AgentEngineSettingsContent({ status, selectedEngine, loading, busy, disabled = false,
  needsRefresh = false, error, notice, onEngineChange, onRefresh, onApply, onClose }: ContentProps) {
  const taskActive = disabled || Boolean(status && status.activeTasks > 0);
  const locked = loading || busy || taskActive || !status || needsRefresh;
  const canApply = !locked && selectedEngine !== status?.engine && (selectedEngine === "harness" || status?.dsh.available);
  return <div className="agent-engine-content">
    <header><div><h2 id="agent-engine-settings-heading">Agent 执行与插件</h2><p>选择执行任务的内核；模型密钥仍在“AI 接口配置”中管理。</p></div>
      <button type="button" aria-label="关闭 Agent 执行与插件" disabled={busy} onClick={onClose}>×</button></header>
    {loading && <p className="agent-engine-status" role="status">正在读取执行引擎状态…</p>}
    {status && <>
      <p className="agent-engine-current">当前引擎：<strong>{status.engine === "dsh" ? "DeepSeek Harness（实验）" : "原版 Harness"}</strong></p>
      <fieldset className="agent-engine-options" disabled={locked} aria-describedby="agent-engine-scope">
        <legend>执行引擎</legend>
        <label className={selectedEngine === "harness" ? "selected" : undefined}>
          <input type="radio" name="agent-execution-engine" value="harness" checked={selectedEngine === "harness"} onChange={() => onEngineChange("harness")} />
          <span><strong>原版 Harness</strong><small>保留当前完整业务工具与执行流程。</small></span>
        </label>
        <label className={selectedEngine === "dsh" ? "selected" : undefined}>
          <input type="radio" name="agent-execution-engine" value="dsh" checked={selectedEngine === "dsh"} disabled={!status.dsh.available} onChange={() => onEngineChange("dsh")} />
          <span><strong>DeepSeek Harness <em>实验</em></strong><small>{status.dsh.available ? "本机组件可用" : "当前不可用"}{status.dsh.version ? ` · ${status.dsh.version}` : ""}</small>
            {status.dsh.reason && <small>{status.dsh.reason}</small>}</span>
        </label>
      </fieldset>
      <p id="agent-engine-scope" className="agent-engine-muted">DSH 支持已选数据源、本次附带的 Excel 原件、Notebook Python 和已授权只读数据库，结果可接表格与图表。Python 须部署能力可用，连接须允许 AI 使用。暂不支持语义模型、图片或外部工具；不支持的任务会明确报错，不自动切换引擎。</p>
      {taskActive && <p className="agent-engine-status" role="status">有任务正在执行，暂不能切换引擎。任务结束后请刷新状态。</p>}
      <section className="agent-engine-plugins" aria-labelledby="agent-engine-plugins-heading">
        <div><h3 id="agent-engine-plugins-heading">DSH 已接入的工具插件</h3><small>只读目录</small></div>
        <p className="agent-engine-muted">这里只展示已接线能力；每次任务按附件、授权和部署状态提供工具，不代表全部已启用。不提供安装、卸载或独立启停，草稿仍须由你确认采用。</p>
        {status.plugins.length ? status.plugins.map(plugin => <article key={plugin.id}>
          <h4>{plugin.name}</h4><p>{plugin.description}</p>
          <ul>{plugin.tools.map(tool => <li key={tool}><code>{tool}</code></li>)}</ul>
        </article>) : <p className="agent-engine-muted">当前没有已接入的工具插件。</p>}
      </section>
    </>}
    {error && <p className="agent-engine-error" role="alert">{error}</p>}
    {needsRefresh && <p className="agent-engine-muted">尚未确认服务器上的当前引擎，请先刷新状态再操作。</p>}
    {notice && <p className="agent-engine-status" role="status">{notice}</p>}
    <p className="agent-engine-persistence">设置仅保存在当前本机服务进程，重启后恢复原版；不写入项目或工作区备份。切换只影响后续任务，不会运行数据或调用模型。</p>
    <footer><button type="button" disabled={loading || busy} onClick={onRefresh}>刷新状态</button><span />
      <button type="button" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="agent-engine-primary" disabled={!canApply} onClick={onApply}>{busy ? "正在应用…" : "应用执行引擎"}</button></footer>
  </div>;
}

function AgentEngineSettingsDialog({ disabled, onClose }: { disabled: boolean; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(false);
  const pending = useRef<{ method: "GET" | "PATCH"; controller: AbortController } | null>(null);
  const [status, setStatus] = useState<AgentEngineStatus | null>(null);
  const [selectedEngine, setSelectedEngine] = useState<Engine>("harness");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    if (pending.current || !alive.current) return;
    const controller = new AbortController();
    pending.current = { method: "GET", controller };
    setLoading(true); setError(""); setNotice("");
    try {
      const next = await readAgentEngineSettingsResponse(await fetch(endpoint, { cache: "no-store", signal: controller.signal }));
      if (!alive.current || controller.signal.aborted) return;
      setStatus(next); setSelectedEngine(next.engine); setNeedsRefresh(false);
    } catch (caught) {
      if (alive.current && !controller.signal.aborted) {
        setNeedsRefresh(true);
        setError(caught instanceof Error ? caught.message : "无法读取执行引擎状态。");
      }
    } finally {
      if (pending.current?.controller === controller) pending.current = null;
      if (alive.current && !controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const element = dialog.current;
    element?.showModal();
    const timer = setTimeout(() => void refresh(), 0);
    return () => {
      alive.current = false;
      clearTimeout(timer);
      pending.current?.controller.abort();
      pending.current = null;
      element?.close();
    };
  }, [refresh]);

  function close() {
    if (pending.current?.method === "PATCH") return;
    dialog.current?.close();
    onClose();
  }

  async function apply() {
    if (!status || pending.current || disabled || status.activeTasks > 0 || needsRefresh || selectedEngine === status.engine
      || (selectedEngine === "dsh" && !status.dsh.available)) return;
    const controller = new AbortController();
    pending.current = { method: "PATCH", controller };
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await readAgentEngineSettingsResponse(await fetch(endpoint, { method: "PATCH", cache: "no-store",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: selectedEngine, revision: status.revision }), signal: controller.signal }));
      if (!alive.current || controller.signal.aborted) return;
      setStatus(next); setSelectedEngine(next.engine);
      setNotice(`已切换为${next.engine === "dsh" ? " DeepSeek Harness（实验）" : "原版 Harness"}，仅对后续任务生效。`);
    } catch (caught) {
      if (alive.current && !controller.signal.aborted) {
        setNeedsRefresh(true);
        setError(caught instanceof Error ? caught.message : "未能确认切换结果，请刷新状态后核对。");
      }
    } finally {
      if (pending.current?.controller === controller) pending.current = null;
      if (alive.current && !controller.signal.aborted) setBusy(false);
    }
  }

  return <dialog ref={dialog} className="agent-engine-dialog" aria-labelledby="agent-engine-settings-heading" onKeyDown={containDialogFocus}
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <AgentEngineSettingsContent status={status} selectedEngine={selectedEngine} loading={loading} busy={busy} disabled={disabled}
      needsRefresh={needsRefresh} error={error} notice={notice} onEngineChange={engine => { setSelectedEngine(engine); setNotice(""); }}
      onRefresh={() => void refresh()} onApply={() => void apply()} onClose={close} />
  </dialog>;
}

export function AgentEngineSettings({ open: controlledOpen, onOpenChange, hideTrigger = false, disabled = false }: {
  open?: boolean; onOpenChange?: (open: boolean) => void; hideTrigger?: boolean; disabled?: boolean;
} = {}) {
  const [localOpen, setLocalOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  return <>
    {!hideTrigger && <button ref={trigger} type="button" className="ai-api-settings-trigger" aria-label="Agent 执行与插件" onClick={() => setOpen(true)}>执行与插件</button>}
    {open && <AgentEngineSettingsDialog disabled={disabled} onClose={() => { setOpen(false); trigger.current?.focus(); }} />}
  </>;
}
