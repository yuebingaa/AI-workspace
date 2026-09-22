"use client";

import { useEffect, useState } from "react";
import { DEFAULT_NOTEBOOK_CAPABILITIES, type NotebookCapabilities } from "@/core/notebook/capabilities";
import { PROJECT_HEADER } from "@/core/projects/contracts";

export type NotebookPythonCapabilitySnapshot = {
  capabilities: NotebookCapabilities;
  available: boolean;
  reason?: string;
  /** False while the browser has not confirmed the server-owned policy. */
  resolved?: boolean;
};

export const DEFAULT_NOTEBOOK_PYTHON_CAPABILITY: NotebookPythonCapabilitySnapshot = {
  capabilities: DEFAULT_NOTEBOOK_CAPABILITIES,
  available: true,
};

export const UNKNOWN_NOTEBOOK_PYTHON_CAPABILITY: NotebookPythonCapabilitySnapshot = {
  capabilities: { python: { enabled: false, reason: "正在确认服务器 Python 能力状态" } },
  available: false,
  reason: "正在确认服务器 Python 能力状态",
  resolved: false,
};

/**
 * The status endpoint predates the capability switch, so a missing `enabled`
 * field remains enabled. Until the server answers, creation/edit/run controls
 * stay closed; the execution API remains the final permission boundary.
 */
export function parseNotebookPythonCapability(value: unknown): NotebookPythonCapabilitySnapshot {
  if (!value || typeof value !== "object") return DEFAULT_NOTEBOOK_PYTHON_CAPABILITY;
  const record = value as Record<string, unknown>;
  const enabled = typeof record.enabled === "boolean" ? record.enabled : true;
  const available = typeof record.available === "boolean" ? record.available : enabled;
  const reason = typeof record.reason === "string" && record.reason.trim() ? record.reason.trim() : undefined;
  return {
    capabilities: { python: { enabled, ...(reason ? { reason } : {}) } },
    available,
    ...(reason ? { reason } : {}),
  };
}

export function useNotebookCapabilities(override?: NotebookPythonCapabilitySnapshot, projectScope?: string | null): NotebookPythonCapabilitySnapshot {
  const [remote, setRemote] = useState<{ scope: string | null; value: NotebookPythonCapabilitySnapshot } | null>(null);
  useEffect(() => {
    if (override) return;
    const controller = new AbortController();
    void fetch("/api/notebook/python", {
      headers: projectScope ? { [PROJECT_HEADER]: projectScope } : {},
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("Notebook capability status unavailable");
      const body: unknown = await response.json();
      setRemote({ scope: projectScope ?? null, value: parseNotebookPythonCapability(body) });
    }).catch(() => {
      if (!controller.signal.aborted) setRemote({
        scope: projectScope ?? null,
        value: { ...UNKNOWN_NOTEBOOK_PYTHON_CAPABILITY, reason: "无法确认服务器 Python 能力状态" },
      });
    });
    return () => controller.abort();
  }, [override, projectScope]);
  if (override) return override;
  return remote?.scope === (projectScope ?? null) ? remote.value : UNKNOWN_NOTEBOOK_PYTHON_CAPABILITY;
}
