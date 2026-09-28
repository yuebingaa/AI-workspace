"use client";

import { Button } from "@/components/ui/button";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { activeAssistantSession, assistantSessionExperience, assistantSessionsForPage, MAX_ASSISTANT_SESSIONS, MAX_PROJECT_ASSISTANT_SESSIONS, type AssistantExperience, type AssistantSessions } from "@/core/harness/assistant-sessions";

export interface ConversationSwitcherProps {
  sessions: AssistantSessions;
  experience?: AssistantExperience;
  projectName: string;
  pageId?: string;
  pageName?: string;
  disabledReason?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
}

export function ConversationSwitcher({ sessions, projectName, pageId, pageName, disabledReason, onSelect, onNew, experience = "classic" }: ConversationSwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null), triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const current = activeAssistantSession(sessions);
  const items = [...(pageId ? assistantSessionsForPage(sessions, pageId, experience) : sessions.items.filter(item => assistantSessionExperience(item) === experience))].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const limitReason = sessions.items.length >= MAX_PROJECT_ASSISTANT_SESSIONS ? "项目会话容量已满，请先备份并整理项目"
    : items.length >= MAX_ASSISTANT_SESSIONS ? `当前界面最多保留 ${MAX_ASSISTANT_SESSIONS} 个会话` : undefined;
  const expanded = open && !disabledReason;
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    rootRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded]);
  function close(restoreFocus = false) { setOpen(false); if (restoreFocus) triggerRef.current?.focus(); }
  function navigate(event: KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    const buttons = [...rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (index + 1) % buttons.length
      : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length
        : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); event.stopPropagation(); buttons[next]?.focus(); }
  }
  return <div className="conversation-switcher" ref={rootRef} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) close();
  }}>
    <Button variant="ghost" type="button" ref={triggerRef} className="conversation-switch-trigger" disabled={Boolean(disabledReason)}
      aria-label="切换会话" aria-haspopup="menu" aria-expanded={expanded} aria-controls={expanded ? id : undefined}
      title={disabledReason || current.title} onClick={() => setOpen(!open)}
      onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}>
      <span>{current.title}</span><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.2" /></svg>
    </Button>
    <Button variant="ghost" type="button" className="conversation-new" aria-label="新建会话"
      disabled={Boolean(disabledReason || limitReason)}
      title={disabledReason || limitReason || "新建会话"}
      onClick={() => { close(); onNew(); }}><svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.2" /></svg></Button>
    {expanded && <div className="conversation-menu" id={id} role="menu" aria-label="当前界面的会话" onKeyDown={navigate}>
      <div className="conversation-menu-scope" title={`${projectName} · ${pageName ?? "当前界面"}`}>{pageName ?? projectName}<small>{experience === "dsh-conversation" ? "仅当前界面 · DSH 对话" : "仅当前界面"}</small></div>
      <div className="conversation-menu-list">
        {items.map((item) => <Button variant="ghost" key={item.id} type="button" role="menuitemradio" aria-checked={item.id === current.id} tabIndex={-1}
          title={item.title} onClick={() => { onSelect(item.id); close(true); }}>
          <span>{item.title}</span><span className="conversation-selected" aria-hidden="true">{item.id === current.id ? "✓" : ""}</span>
        </Button>)}
      </div>
    </div>}
  </div>;
}
