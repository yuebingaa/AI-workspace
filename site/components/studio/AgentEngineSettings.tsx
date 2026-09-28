"use client";

import { Button } from "@/components/ui/button";
import { useCallback, useEffect, useRef, useState } from "react";
import { agentEngineSettingsSchema, type AgentEngineSettings as AgentEngineStatus } from "@/core/agent-engines/contracts";
import { dshPluginSettingsSchema, type DshPluginSettings } from "@/core/agent-engines/plugin-settings";
import { OfficialSettingsFrame } from "./dsh-settings/OfficialSettingsFrame";
import { containDialogFocus } from "./dialog-focus";
import "@/app/agent-engine-settings.css";

const engineEndpoint = "/api/settings/agent-engine";
const pluginEndpoint = "/api/settings/dsh-plugins";
async function readPayload(response: Response): Promise<unknown> {
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new Error("设置响应格式无效，请刷新后重试。"); }
  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    const message = error && typeof error === "object" && "message" in error ? error.message : undefined;
    throw new Error(typeof message === "string" ? message.slice(0, 500) : "无法读取或保存设置。");
  }
  return payload;
}
export async function readAgentEngineSettingsResponse(response: Response): Promise<AgentEngineStatus> {
  const parsed = agentEngineSettingsSchema.safeParse(await readPayload(response));
  if (!parsed.success) throw new Error("执行引擎设置响应格式无效，请刷新后重试。");
  return parsed.data;
}
export async function readDshPluginSettingsResponse(response: Response): Promise<DshPluginSettings> {
  const parsed = dshPluginSettingsSchema.safeParse(await readPayload(response));
  if (!parsed.success) throw new Error("插件设置响应格式无效，请刷新后重试。");
  return parsed.data;
}

function AgentEngineSettingsDialog({ disabled, onClose, onOpenModels }: {
  disabled: boolean; onClose(): void; onOpenModels?(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(false);
  const pending = useRef<{ controller: AbortController; saving: boolean } | null>(null);
  const current = useRef<DshPluginSettings | null>(null);
  const draftSkills = useRef(false);
  const [status, setStatus] = useState<AgentEngineStatus | null>(null);
  const [plugins, setPlugins] = useState<DshPluginSettings | null>(null);
  const [skills, setSkills] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [discard, setDiscard] = useState(false);
  const dirty = plugins !== null && plugins.document.config.skills !== skills;

  const refresh = useCallback(async () => {
    if (pending.current || !alive.current) return;
    const preserveDraft = current.current !== null && draftSkills.current !== current.current.document.config.skills;
    const operation = { controller: new AbortController(), saving: false };
    pending.current = operation;
    setLoading(true); setError(""); setNotice("");
    try {
      const init = { cache: "no-store" as const, signal: operation.controller.signal };
      const [engine, next] = await Promise.all([
        fetch(engineEndpoint, init).then(readAgentEngineSettingsResponse),
        fetch(pluginEndpoint, init).then(readDshPluginSettingsResponse),
      ]);
      if (!alive.current || operation.controller.signal.aborted) return;
      if (!preserveDraft) { draftSkills.current = next.document.config.skills; setSkills(next.document.config.skills); }
      current.current = next;
      setPlugins(next); setStatus(engine); setNeedsRefresh(false);
    } catch (caught) {
      if (alive.current && !operation.controller.signal.aborted) {
        setNeedsRefresh(true); setError(caught instanceof Error ? caught.message : "读取状态失败。");
      }
    } finally {
      if (pending.current === operation) pending.current = null;
      if (alive.current && !operation.controller.signal.aborted) setLoading(false);
    }
  }, []);

  async function save() {
    if (pending.current || !alive.current || !plugins || !dirty || needsRefresh || disabled
      || plugins.activeTasks > 0 || plugins.persistence !== "json-file") return;
    const operation = { controller: new AbortController(), saving: true };
    pending.current = operation;
    setSaving(true); setError(""); setNotice(""); setDiscard(false);
    try {
      const next = await readDshPluginSettingsResponse(await fetch(pluginEndpoint, { method: "PATCH",
        headers: { "content-type": "application/json" }, signal: operation.controller.signal,
        body: JSON.stringify({ revision: plugins.document.revision, config: { skills } }),
      }));
      if (!alive.current || operation.controller.signal.aborted) return;
      current.current = next; draftSkills.current = next.document.config.skills;
      setPlugins(next); setSkills(next.document.config.skills); setNeedsRefresh(false);
      setNotice("配置已保存，下一轮任务生效。网页聊天记录保留。");
    } catch (caught) {
      if (alive.current && !operation.controller.signal.aborted) {
        setNeedsRefresh(true);
        setError((caught instanceof Error ? caught.message : "保存响应异常。") + " 请重新读取确认实际配置，不会自动重试保存。");
      }
    } finally {
      if (pending.current === operation) pending.current = null;
      if (alive.current && !operation.controller.signal.aborted) setSaving(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    const element = dialog.current;
    element?.showModal();
    const timer = setTimeout(() => void refresh(), 0);
    return () => {
      alive.current = false; clearTimeout(timer);
      pending.current?.controller.abort(); pending.current = null; element?.close();
    };
  }, [refresh]);

  function close(force = false) {
    if (pending.current?.saving) return;
    if (dirty && !force) { setDiscard(true); return; }
    dialog.current?.close(); onClose();
  }
  return <dialog ref={dialog} className="agent-engine-dialog agent-engine-native-dialog" aria-label="Agent 执行与插件" onKeyDown={containDialogFocus}
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <OfficialSettingsFrame status={status} plugins={plugins} skills={skills} loading={loading} saving={saving} disabled={disabled}
      needsRefresh={needsRefresh} error={error} notice={notice} dirty={dirty} discard={discard}
      onSkills={value => { draftSkills.current = value; setSkills(value); setNotice(""); }} onRefresh={() => void refresh()} onSave={() => void save()}
      onClose={() => close()} onDiscard={() => close(true)} onKeepEditing={() => setDiscard(false)}
      onOpenModels={onOpenModels} />
  </dialog>;
}

/** 当前对话固定使用 DSH；本组件不修改旧执行器选择。 */
export function AgentEngineSettings({ open: controlledOpen, onOpenChange, hideTrigger = false, disabled = false, onOpenModels }: {
  open?: boolean; onOpenChange?: (open: boolean) => void; hideTrigger?: boolean; disabled?: boolean; onOpenModels?(): void;
} = {}) {
  const [localOpen, setLocalOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  return <>
    {!hideTrigger && <Button variant="secondary" ref={trigger} type="button" className="ai-api-settings-trigger" aria-label="Agent 执行与插件" onClick={() => setOpen(true)}>执行与插件</Button>}
    {open && <AgentEngineSettingsDialog disabled={disabled} onOpenModels={onOpenModels}
      onClose={() => { setOpen(false); trigger.current?.focus(); }} />}
  </>;
}
