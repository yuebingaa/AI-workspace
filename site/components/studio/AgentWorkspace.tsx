import { Tabs } from "@radix-ui/themes";

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
  return (
    <div className="workspace-modebar">
      <span className="workspace-mode-context" title={pageTitle}><i aria-hidden="true" />{pageTitle}</span>
      <Tabs.Root value={mode} onValueChange={value => onChange(value as WorkspaceMode)}>
      <Tabs.List className="workspace-mode-tabs" aria-label="工作界面模式" size="1">
        {modes.map((item) => (
          <Tabs.Trigger
            key={item.id}
            id={`workspace-tab-${item.id}`}
            value={item.id}
            aria-controls="workspace-view-panel"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              {item.id === "agent"
                ? <><path d="M4 3.5h12a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9l-4.5 3v-3H4A1.5 1.5 0 0 1 2.5 13V5A1.5 1.5 0 0 1 4 3.5Z" /><path d="m10 6 1 2.5 2.5 1L11 10.5 10 13l-1-2.5-2.5-1L9 8.5Z" /></>
                : item.id === "notebook"
                  ? <><rect x="4" y="2.5" width="12" height="15" rx="1" /><path d="M7 2.5v15M10 7h3M10 10h3M2.5 6H5M2.5 10H5M2.5 14H5" /></>
                  : <><rect x="2.5" y="3" width="15" height="14" rx="1" /><path d="M2.5 7h15M8 7v10" /></>}
            </svg>
            {item.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      </Tabs.Root>
      <span className="workspace-mode-hint">{mode === "agent" ? "从一个问题开始" : mode === "notebook" ? "可编辑、可运行的分析步骤" : "查看与编辑分析结果"}</span>
    </div>
  );
}
