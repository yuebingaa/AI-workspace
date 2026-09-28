import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { StudioTheme } from "@/components/ui/studio-theme";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Portaled dialogs are verified after mounting, rather than through empty SSR output. */
export function renderDialogMarkup(node: ReactNode) {
  return renderMountedMarkup(node, true);
}

export function renderMountedMarkup(node: ReactNode, dialogOnly = false) {
  return withMountedTheme(node, container => {
    if (!dialogOnly) return container.innerHTML;
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
    if (!dialog) throw new Error("Dialog did not open");
    return dialog.outerHTML;
  });
}

export function withMountedTheme<T>(node: ReactNode, inspect: (container: HTMLDivElement) => T): T {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<StudioTheme>{node}</StudioTheme>));
    return inspect(container);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
}
