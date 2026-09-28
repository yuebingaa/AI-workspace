"use client";

import type { ReactNode } from "react";
import { Theme } from "@radix-ui/themes";

/** One visual configuration for the workspace and all Themes portals. */
export function StudioTheme({ children }: { children: ReactNode }) {
  return <Theme appearance="light" accentColor="violet" grayColor="mauve" radius="medium" scaling="100%" panelBackground="solid">
    {children}
  </Theme>;
}
