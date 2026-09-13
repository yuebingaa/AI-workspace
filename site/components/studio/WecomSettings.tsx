"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "./wecom-settings.css";

interface ConnectionStatus {
  available: boolean; connected: boolean; pending: boolean; qrReady: boolean; failed: boolean; message: string;
  tools: Array<{ name: string; description: string }>;
}
export function WecomSettings({ onSuggestion }: { onSuggestion?: (instruction: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [qrVersion, setQrVersion] = useState(0);
  const generation = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const current = generation.current;
    try {
      const response = await fetch("/api/settings/wecom", { cache: "no-store", signal });
      const data = await response.json() as ConnectionStatus & { error?: { message: string } };
      if (!response.ok) throw new Error(data.error?.message || "连接状态读取失败。");
      if (current === generation.current) setStatus(data);
    } catch (caught) {
      if (!signal?.aborted && current === generation.current) setError(caught instanceof Error ? caught.message : "无法读取连接状态。");
    }
  }, []);
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    const controller = new AbortController();
    const timer = setTimeout(() => void refresh(controller.signal), 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, refresh]);
  useEffect(() => {
    if (!open || !status?.pending || busy) return;
    const controller = new AbortController();
    const timer = setTimeout(() => void refresh(controller.signal), 2_000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, status, busy, refresh]);
  function close() { dialog.current?.close(); setOpen(false); trigger.current?.focus(); }
  async function mutate(method: "POST" | "DELETE") {
    generation.current += 1; setBusy(true); setError("");
    try {
      const response = await fetch("/api/settings/wecom", { method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify({ action: "connect", consent }) } : {}) });
      const data = await response.json() as ConnectionStatus & { error?: { message: string } };
      if (!response.ok) throw new Error(data.error?.message || "企业微信连接操作失败。");
      setStatus(data); setQrVersion(Date.now());
      if (method === "DELETE") setConsent(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "连接操作失败。"); }
    finally { setBusy(false); }
  }
  return <>
    <button ref={trigger} type="button" className="ai-api-settings-trigger wecom-trigger" aria-label="配置企业微信连接" onClick={() => { setError(""); setOpen(true); }}>
      <span className={`wecom-status-dot${status?.connected ? " connected" : ""}`} aria-hidden="true" />企业微信
    </button>
    {open && <dialog ref={dialog} className="wecom-dialog" aria-labelledby="wecom-heading" onCancel={close} onClick={(event) => { if (event.target === dialog.current) close(); }}>
      <div className="wecom-dialog-content">
        <header><div><h2 id="wecom-heading">连接企业微信</h2><p>让网页智能体读取你授权的企业数据</p></div><button type="button" aria-label="关闭企业微信设置" onClick={close}>×</button></header>
        <div className={`wecom-connection-card${status?.connected ? " connected" : ""}`} role="status">
          <strong>{status?.connected ? "已连接 · 只读模式" : status?.pending ? "等待扫码授权" : "企业微信连接"}</strong>
          <p>{status?.message ?? "正在检查本机组件…"}</p>
        </div>
        <section><h3>本版开放的能力</h3><ul><li>按关键词搜索你有权限的企业微信文档</li><li>读取在线表格指定区域（每次最多 1000 个单元格）</li><li>分页读取智能表格记录（每页最多 20 行）</li></ul><p className="wecom-muted">暂不发送消息、不写入或删除企业数据，不读取普通文档正文。部分数据不能替代全表统计。</p></section>
        {!status?.connected && <label className="wecom-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={busy || status?.pending} /><span>我同意将对话请求所需的企业微信搜索结果、表格内容交给当前配置的 AI 服务分析，并保存在本网页的对话记录中。</span></label>}
        {status?.pending && <div className="wecom-qr">
          {status.qrReady
            // This endpoint serves only the CLI-generated, session-bound PNG.
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={`/api/settings/wecom?qr=1&v=${qrVersion}`} width="240" height="240" alt="使用企业微信扫描此二维码完成授权" />
            : <p>正在生成二维码…</p>}
          <p>请使用企业微信扫码，以官方授权页列出的权限为准。</p>
        </div>}
        {error && <p className="wecom-error" role="alert">{error}</p>}
        <div className="wecom-actions">
          {!status?.connected && !status?.pending && <button type="button" className="wecom-primary" disabled={!status?.available || !consent || busy} onClick={() => void mutate("POST")}>{busy ? "正在连接…" : "扫码连接企业微信"}</button>}
          {(status?.connected || status?.pending || status?.failed) && <button type="button" disabled={busy} onClick={() => void mutate("DELETE")}>{status?.pending ? "取消授权" : "断开并移除本机凭据"}</button>}
          <button type="button" disabled={busy} onClick={() => { setError(""); void refresh(); }}>刷新状态</button>
        </div>
        {status?.connected && onSuggestion && <section className="wecom-examples"><h3>现在可以这样问</h3>{["帮我在企业微信搜索销售报表，先列出候选文档让我选择", "读取这份企业微信表格的结构，再让我选择要分析的区域："].map((text) => <button type="button" key={text} onClick={() => { onSuggestion(text); close(); }}>{text}</button>)}</section>}
        <p className="wecom-muted wecom-footer">凭据仅保存在本机服务端，不写入浏览器存储或发给 AI。3000 与 3001 分别连接。断开会删除本机连接凭据，不删除已有对话；如需撤销企业微信侧授权，请在企业微信中操作。本功能目前仅支持本机使用。</p>
      </div>
    </dialog>}
  </>;
}
