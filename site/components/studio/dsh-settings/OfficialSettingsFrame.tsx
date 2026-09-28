"use client";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { dshPackageInventorySchema } from "@/core/agent-engines/plugin-inventory";
import { DSH_SETTINGS_CHANNEL, projectSettingsInventory, readSettingsCommand } from "@/core/dsh-web/settings-projection";
import type { PluginSettingsContentProps } from "./settings-contract";

export function settingsFrameSnapshot(props: PluginSettingsContentProps) {
  const active = Boolean(props.disabled || (props.plugins?.activeTasks ?? 0) > 0 || (props.status?.activeTasks ?? 0) > 0);
  const locked = props.loading || props.saving || props.needsRefresh || active || !props.plugins || props.plugins.persistence !== "json-file";
  const skill = props.plugins?.plugins.find(item => item.id === "dsh-tool-skill");
  return { status: props.status ? { dsh: props.status.dsh } : null, skills: props.skills, loading: props.loading,
    saving: props.saving, needsRefresh: props.needsRefresh, dirty: props.dirty, discard: props.discard,
    error: props.error, notice: props.notice, active, locked,
    canConfigure: !locked && Boolean(skill?.configurable || props.skills), modelsAvailable: Boolean(props.onOpenModels) };
}

/** Only a trusted official iframe and a bounded message/API adapter. No custom settings layout. */
export function OfficialSettingsFrame(props: PluginSettingsContentProps) {
  const frame = useRef<HTMLIFrameElement>(null), current = useRef(props);
  const [nonce, setNonce] = useState(""), [mounted, setMounted] = useState(false), [error, setError] = useState("");
  useEffect(() => { current.current = props;
    frame.current?.contentWindow?.postMessage({ channel: DSH_SETTINGS_CHANNEL, nonce, type: "snapshot", snapshot: settingsFrameSnapshot(props) }, location.origin);
  }, [props, nonce]);
  useEffect(() => { const timer = setTimeout(() => setNonce(crypto.randomUUID()), 0); return () => clearTimeout(timer); }, []);
  useEffect(() => {
    if (!nonce) return;
    const controller = new AbortController(), seen = new Set<string>();
    let pending = false;
    const post = (value: object) => frame.current?.contentWindow?.postMessage({ channel: DSH_SETTINGS_CHANNEL, nonce, ...value }, location.origin);
    const timeout = setTimeout(() => setError("官方设置界面未完成加载，请重载或关闭；未自动保存配置。"), 30000);
    const listener = (event: MessageEvent) => {
      const command = readSettingsCommand(event, frame.current?.contentWindow, location.origin, nonce);
      if (!command) return;
      const value = current.current, state = settingsFrameSnapshot(value);
      switch (command.type) {
        case "ready": post({ type: "snapshot", snapshot: state }); break;
        case "mounted": clearTimeout(timeout); setMounted(true); setError(""); break;
        case "close": value.onClose(); break;
        case "discard": if (value.discard && !value.saving) value.onDiscard(); break;
        case "keep": value.onKeepEditing(); break;
        case "skills": if (state.canConfigure) value.onSkills(command.skills); break;
        case "refresh": if (!value.loading && !value.saving) value.onRefresh(); break;
        case "save": if (!state.locked && value.dirty) value.onSave(); break;
        case "models": if (!value.saving && !value.dirty) value.onOpenModels?.(); break;
        case "inventory": {
          const fail = () => post({ type: "result", requestId: command.requestId,
            result: { ok: false, error: { code: "agentcanvas/inventory-unavailable", message: "目录读取失败或状态待确认，请重试。", details: {} } } });
          if (pending || seen.has(command.requestId) || seen.size >= 256 || !value.plugins || value.loading || value.needsRefresh) { fail(); break; }
          seen.add(command.requestId); pending = true;
          void fetch("/api/settings/dsh-plugins/inventory", { cache: "no-store", signal: controller.signal }).then(async response => {
            if (!response.ok) throw new Error("inventory unavailable");
            const inventory = dshPackageInventorySchema.parse(await response.json());
            const latest = current.current;
            if (!latest.plugins || latest.needsRefresh || latest.loading || latest.plugins.document.revision !== value.plugins?.document.revision) throw new Error("stale");
            if (!controller.signal.aborted) post({ type: "result", requestId: command.requestId,
              result: { ok: true, value: projectSettingsInventory(inventory, latest.plugins) } });
          }).catch(() => { if (!controller.signal.aborted) fail(); }).finally(() => { pending = false; });
          break;
        }
      }
    };
    window.addEventListener("message", listener);
    return () => { controller.abort(); clearTimeout(timeout); window.removeEventListener("message", listener); };
  }, [nonce]);
  return <div className="dsh-native-settings-frame">
    {(!mounted || error) && <div className="dsh-settings-load-status" role={error ? "alert" : "status"}>
      <p>{error || "正在加载官方 DSH 设置…"}</p>
      {error && <Button variant="secondary" type="button" onClick={() => { setError(""); setMounted(false); setNonce(crypto.randomUUID()); }}>重载设置界面</Button>}
      <Button variant="secondary" type="button" disabled={props.saving} onClick={props.onClose}>关闭</Button>
    </div>}
    {nonce && <iframe ref={frame} key={nonce} title="官方 DSH 设置" src={`/api/ai/dsh/web/document?surface=settings#${nonce}`}
      sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />}
  </div>;
}
