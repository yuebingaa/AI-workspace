import type { ReactNode } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { StudioTheme } from "@/components/ui/studio-theme";

/** Render with the same theme context as the application. */
export function renderToStaticMarkup(node: ReactNode) {
  return renderMarkup(<StudioTheme>{node}</StudioTheme>);
}
