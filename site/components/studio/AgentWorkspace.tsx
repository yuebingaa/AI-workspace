import type { KeyboardEvent } from "react";
import { StudioArtwork } from "./StudioArtwork";

export type WorkspaceMode = "agent" | "notebook" | "canvas";

const modes = [
  { id: "agent", label: "AI 工作台" },
  { id: "notebook", label: "Notebook" },
  { id: "canvas", label: "看板" },
] as const;

export function WorkspaceModeBar({ mode, pageTitle, onChange }: {
  mode: WorkspaceMode;
  pageTitle: string;
  onChange: (mode: WorkspaceMode) => void;
}) {
  function handleTabKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = modes.findIndex((item) => item.id === mode);
    const next = modes[event.key === "Home" ? 0 : event.key === "End" ? modes.length - 1 : (index + (event.key === "ArrowRight" ? 1 : modes.length - 1)) % modes.length].id;
    onChange(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`#workspace-tab-${next}`)?.focus();
  }

  return (
    <div className="workspace-modebar">
      <span className="workspace-mode-context" title={pageTitle}><i aria-hidden="true" />{pageTitle}</span>
      <div className="workspace-mode-tabs" role="tablist" aria-label="工作界面模式" onKeyDown={handleTabKey}>
        {modes.map((item) => (
          <button
            key={item.id}
            id={`workspace-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={mode === item.id}
            aria-controls="workspace-view-panel"
            tabIndex={mode === item.id ? 0 : -1}
            onClick={() => onChange(item.id)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              {item.id === "agent"
                ? <><path d="M4 3.5h12a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9l-4.5 3v-3H4A1.5 1.5 0 0 1 2.5 13V5A1.5 1.5 0 0 1 4 3.5Z" /><path d="m10 6 1 2.5 2.5 1L11 10.5 10 13l-1-2.5-2.5-1L9 8.5Z" /></>
                : item.id === "notebook"
                  ? <><rect x="4" y="2.5" width="12" height="15" rx="1" /><path d="M7 2.5v15M10 7h3M10 10h3M2.5 6H5M2.5 10H5M2.5 14H5" /></>
                  : <><rect x="2.5" y="3" width="15" height="14" rx="1" /><path d="M2.5 7h15M8 7v10" /></>}
            </svg>
            {item.label}
          </button>
        ))}
      </div>
      <span className="workspace-mode-hint">{mode === "agent" ? "从一个问题开始" : mode === "notebook" ? "可编辑、可运行的分析步骤" : "查看与编辑分析结果"}</span>
    </div>
  );
}

export function AgentWorkspaceWelcome({ onSuggestion, compact = false }: { onSuggestion: (instruction: string) => void; compact?: boolean }) {
  return (
    <section className={`agent-workspace-welcome${compact ? " compact" : ""}`} aria-labelledby="agent-welcome-title">
      <StudioArtwork className="agent-welcome-art" />
      <h1 id="agent-welcome-title">{compact ? "想从数据中了解什么？" : "今天，想了解什么？"}</h1>
      <p className="agent-welcome-description">提问、分析数据、创建图表。<br />从一个问题，走向新的发现。</p>
      {!compact && <div className="agent-suggestions">
        {[
          ["了解数据", "读懂字段，找到关键发现", "请检查当前数据的字段、质量和关键统计，告诉我有哪些值得关注的发现。"],
          ["生成可视化", "让趋势与对比一目了然", "请根据当前数据推荐合适的图表，并为当前工作界面生成可视化预览。"],
          ["整理表格", "检查质量，梳理处理步骤", "请检查当前表格的数据质量，建议需要整理的字段和处理步骤，先说明建议。"],
        ].map(([label, description, instruction]) => (
          <button type="button" key={label} aria-label={label} onClick={() => onSuggestion(instruction)}>
            <span className="agent-suggestion-copy" title={description}><b>{label}</b></span>
            <span className="agent-suggestion-arrow" aria-hidden="true">↗</span>
          </button>
        ))}
      </div>}
    </section>
  );
}
