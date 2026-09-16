export type StudioIconName = "menu" | "data" | "pages" | "files" | "models" | "connections" | "history" | "upload" | "settings" | "wecom" | "backup" | "restore" | "undo" | "chart" | "search" | "plus" | "trash";
export function StudioIcon({ name }: { name: StudioIconName }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "menu" && <path d="M5 7h14M5 12h10M5 17h14" />}
    {name === "data" && <><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v14c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" /></>}
    {name === "pages" && <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 3v18M12 8h5M12 12h5" /></>}
    {name === "files" && <path d="M3 7V5h6l2 2h10v13H3V7Zm0 3h18" />}
    {name === "trash" && <path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" />}
    {name === "models" && <path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" />}
    {name === "connections" && <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12 4 7.5M12 12v9" />}
    {name === "history" && <path d="M4 9a8 8 0 1 1 0 6M3 4v5h5M12 7v5l3 2" />}
    {name === "upload" && <path d="M12 16V3m-4 4 4-4 4 4M4 14v7h16v-7" />}
    {name === "settings" && <><circle cx="12" cy="12" r="3" /><path d="m10 3-.5 3-2 1-3-.5-2 3 2 2v2l-2 2 2 3 3-.5 2 1 .5 3h4l.5-3 2-1 3 .5 2-3-2-2v-2l2-2-2-3-3 .5-2-1-.5-3h-4Z" /></>}
    {name === "wecom" && <path d="M4 4h12v10H9l-4 3v-3H4V4Zm12 4h4v12l-4-3h-4v-3" />}
    {name === "backup" && <path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" />}
    {name === "restore" && <path d="M5 9a7 7 0 1 1 0 7M3 4v6h6M12 8v5l3 1" />}
    {name === "undo" && <path d="m8 5-5 5 5 5M3 10h10a7 7 0 0 1 7 7v3" />}
    {name === "chart" && <path d="M4 3v18h17M7 16l4-6 4 3 6-8" />}
    {name === "search" && <><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></>}
    {name === "plus" && <path d="M12 4v16M4 12h16" />}
  </svg>;
}
