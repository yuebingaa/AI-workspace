"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { LAST_PROJECT_KEY, loadProject, ProjectStudioRepository, setActiveProjectHandle, type ProjectSaveStatus } from "@/core/projects/client";
import type { ProjectSession } from "@/core/projects/contracts";
import { loadStudioStateSafely } from "@/core/repository/studio-repository";

interface LocalProjectContextValue {
  session: ProjectSession | null;
  repository: ProjectStudioRepository | null;
  status: ProjectSaveStatus;
  notice: string;
  instanceId: number;
  select: (session: ProjectSession | null) => Promise<void>;
  flush: () => Promise<void>;
  reloadDiscardingChanges: () => Promise<void>;
}
const Context = createContext<LocalProjectContextValue | null>(null);
export function useLocalProjects() { const value = useContext(Context); if (!value) throw new Error("缺少本地项目上下文"); return value; }

export function LocalProjectsProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<ProjectSession | null>(null);
  const [repository, setRepository] = useState<ProjectStudioRepository | null>(null);
  const [status, setStatus] = useState<ProjectSaveStatus>({ state: "saved", message: "本地项目尚未打开" });
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const [instanceId, setInstanceId] = useState(0);
  function install(next: ProjectSession | null) {
    const repo = next ? new ProjectStudioRepository(next, setStatus) : null;
    if (next?.manifest.state && repo && !loadStudioStateSafely(repo, next.manifest.state.dataProduct).restored) throw new Error("项目定义或变更历史无法恢复，未覆盖已有项目文件");
    setActiveProjectHandle(next?.handle ?? null);
    setSession(next); setRepository(repo); setNotice("");
    setInstanceId((value) => value + 1);
    setStatus({ state: "saved", message: next ? "已打开本地项目" : "临时工作区" });
    try { if (next) localStorage.setItem(LAST_PROJECT_KEY, next.handle); else localStorage.removeItem(LAST_PROJECT_KEY); } catch { /* Opening a folder still works without browser storage. */ }
  }
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let handle: string | null = null;
      try { handle = localStorage.getItem(LAST_PROJECT_KEY); } catch { /* Local-only session. */ }
      try {
        const next = handle ? await loadProject(handle) : null;
        if (!cancelled) install(next);
      } catch (error) {
        if (!cancelled) { setActiveProjectHandle(null); setNotice(error instanceof Error ? `上次项目未打开：${error.message}。当前回到临时工作区，项目文件未被修改。` : "上次项目未能打开"); }
      } finally { if (!cancelled) setReady(true); }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (repository?.dirty) { event.preventDefault(); event.returnValue = "项目尚未保存"; } };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [repository]);
  const select = async (next: ProjectSession | null) => { await repository?.flush(); install(next); };
  const reloadDiscardingChanges = async () => {
    if (!session) return;
    const next = await loadProject(session.handle);
    await repository?.discardPending();
    install(next);
  };
  if (!ready) return <main className="local-project-loading" aria-busy="true">正在恢复工作台与本地项目…</main>;
  return <Context.Provider value={{ session, repository, status, notice, instanceId, select, reloadDiscardingChanges, flush: async () => { await repository?.flush(); } }}>{children}</Context.Provider>;
}
