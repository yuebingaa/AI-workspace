"use client";

import { Button } from "@/components/ui/button";
import { useCallback, useEffect, useRef, useState } from "react";
import { DSH_WEB_CHANNEL, dshWebSnapshotSchema, readDshWebCommand, type DshWebSnapshot } from "@/core/dsh-web/protocol";
import { DshWebRequestProjection } from "@/core/dsh-web/request-projection";

interface Props {
  snapshot: DshWebSnapshot;
  onSend(text: string, onAccepted: () => void): Promise<void>;
  onDraft(text: string): void;
  onCancel(): void;
}

/** Official UI is a display/input adapter. The parent owns all execution and persistence. */
export function DshWebFrame(props: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const current = useRef(props);
  const projection = useRef(new DshWebRequestProjection());
  const [nonce, setNonce] = useState("");
  const [ready, setReady] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => { current.current = props; });

  useEffect(() => {
    const timer = window.setTimeout(() => setNonce(crypto.randomUUID()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const sendSnapshot = useCallback(() => {
    if (!nonce) return;
    const snapshot = dshWebSnapshotSchema.parse(projection.current.project(current.current.snapshot));
    frame.current?.contentWindow?.postMessage({ channel: DSH_WEB_CHANNEL, nonce, type: "snapshot", snapshot }, location.origin);
  }, [nonce]);
  const postSnapshot = useRef(sendSnapshot);
  useEffect(() => { postSnapshot.current = sendSnapshot; }, [sendSnapshot]);

  useEffect(() => {
    if (!nonce) return;
    const seen = new Set<string>();
    let sending = false, disposed = false;
    const timer = window.setTimeout(() => setNotice("DSH 对话界面未完成加载，可重载界面。不会自动切换执行器或发送请求。"), 30_000);
    const listener = (event: MessageEvent) => {
      const command = readDshWebCommand(event, frame.current?.contentWindow, location.origin, nonce);
      if (!command) return;
      const value = current.current;
      const reply = (ok: boolean, error?: string) => {
        if (!("requestId" in command) || disposed) return;
        frame.current?.contentWindow?.postMessage({ channel: DSH_WEB_CHANNEL, nonce, type: "result",
          requestId: command.requestId, ok, ...(error ? { error } : {}) }, location.origin);
      };
      if (command.type === "ready") {
        setReady(true); postSnapshot.current(); return;
      }
      if (command.type === "mounted") { clearTimeout(timer); setMounted(true); setNotice(""); return; }
      if (command.type === "draft") {
        if (!sending && !value.snapshot.busy && value.snapshot.canSend) value.onDraft(command.text);
        return;
      }
      if (seen.has(command.requestId)) { reply(false, "重复的界面命令未执行。"); return; }
      if (seen.size >= 256) { reply(false, "请在当前任务结束后重载对话界面。"); return; }
      seen.add(command.requestId);
      if (command.type === "cancel") {
        if (!value.snapshot.busy) { reply(false, "当前没有可取消任务。"); return; }
        value.onCancel(); reply(true); return;
      }
      if (sending || value.snapshot.busy || !value.snapshot.canSend) { reply(false, "请先结束当前任务、编辑或预览，再发送问题。"); return; }
      sending = true;
      projection.current.begin(command.requestId, command.text, value.snapshot.turns);
      let accepted = false;
      const accept = () => { if (!accepted) { accepted = true; reply(true); } };
      const reject = () => {
        projection.current.reject(command.requestId);
        value.onDraft(command.text);
        reply(false, "网站未建立本次任务，请查看当前任务提示；输入已保留。");
      };
      try {
        // Only explicit website task admission acknowledges the official echo.
        void value.onSend(command.text, accept).catch(() => { if (!disposed && accepted) setNotice("请求未能完成，请查看网站任务状态后重试。"); })
          .finally(() => { sending = false; if (!disposed) { if (!accepted) reject(); postSnapshot.current(); } });
      } catch { sending = false; if (!accepted) reject(); }
    };
    window.addEventListener("message", listener);
    return () => { disposed = true; clearTimeout(timer); window.removeEventListener("message", listener); };
  }, [nonce]);

  useEffect(() => { if (ready) postSnapshot.current(); }, [props.snapshot, ready]);
  return <section className="dsh-web-frame-surface" aria-label="官方 DSH 对话界面">
    {!mounted && !notice && <p role="status">正在加载官方 DSH 对话界面…</p>}
    {notice && <div className="dsh-web-load-error" role="alert"><p>{notice}</p>
      <Button variant="secondary" type="button" disabled={props.snapshot.busy} onClick={() => { setReady(false); setMounted(false); setNotice(""); setNonce(crypto.randomUUID()); }}>重载界面</Button></div>}
    {nonce && <iframe key={nonce} ref={frame} title="官方 DSH 聊天" src={`/api/ai/dsh/web/document#${nonce}`}
      sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />}
  </section>;
}
