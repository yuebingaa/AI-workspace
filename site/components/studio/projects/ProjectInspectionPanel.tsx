"use client";

import { useEffect, useRef, useState } from "react";
import { requestProjectInspection } from "@/core/projects/inspection-client";
import type { ProjectInspection } from "@/core/projects/inspection";

const languages = { sql: "SQL", python: "Python", markdown: "文本" };

/** This is a display-only DTO, never a NotebookDocument or a project repository. */
export function ProjectInspectionContent({ inspection }: { inspection: ProjectInspection }) {
  return <div className="project-inspection-document">
    <div className="project-inspection-summary"><h4>{inspection.project.name}</h4>
      <p>{inspection.notebooks.length} 个 Notebook · 项目修订 {inspection.project.stateRevision} · 更新于 {new Date(inspection.project.updatedAt).toLocaleString("zh-CN")}</p>
      <p>不会切换当前项目，不执行代码，也不保存修改。此处仅查看磁盘中的步骤目录和有限源码，不展示数据行或历史运行结果。</p>
      {inspection.unknownCellCount > 0 && <p role="status">有 {inspection.unknownCellCount} 个当前版本不支持的单元。原定义保留在磁盘中；编辑或运行请使用兼容版本。</p>}
      {inspection.omittedSourceCount > 0 && <p>另有 {inspection.omittedSourceCount} 个单元的源码因展示容量限制未展开，原文件未改变。</p>}
    </div>
    {inspection.notebooks.length === 0 && <p className="data-browser-empty">项目尚未保存 Notebook 步骤。</p>}
    {inspection.notebooks.map((notebook) => <section className="project-inspection-notebook" key={notebook.index} aria-label={`Notebook ${notebook.index} ${notebook.name}`}>
      <h4>{notebook.index}. {notebook.name}</h4><p>修订 {notebook.revision} · {notebook.cells.length} 个单元</p>
      {notebook.cells.length === 0 && <p>此 Notebook 没有单元。</p>}
      <ol>{notebook.cells.map((cell) => <li key={cell.index} className={`project-inspection-cell ${cell.support}`}>
        <div><b>{cell.index}. {cell.title}</b><span>{cell.kind ?? "未识别类型"}</span></div>
        <small>单元 ID：{cell.id}</small>
        {cell.support === "unknown" ? <p><strong>当前版本不支持此单元</strong> · 仅展示名称与类型，不展示或执行内部配置。</p>
          : cell.source && <details><summary>查看 {languages[cell.source.language]} 源码</summary>
            <pre><code>{cell.source.text}</code></pre>
            {cell.source.truncated && <p>源码仅显示前段，未修改原文件。</p>}
          </details>}
      </li>)}</ol>
    </section>)}
  </div>;
}

type InspectionState = { status: "loading" } | { status: "loaded"; data: ProjectInspection } | { status: "error"; message: string };

export function ProjectInspectionPanel({ path, onBack }: { path: string; onBack: () => void }) {
  const [state, setState] = useState<InspectionState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { backRef.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void requestProjectInspection(path, controller.signal).then((data) => {
      if (!controller.signal.aborted) setState({ status: "loaded", data });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ status: "error", message: error instanceof Error ? error.message : "项目步骤读取失败，请稍后重试。" });
    });
    return () => controller.abort();
  }, [path, attempt]);
  return <section aria-label="项目步骤只读查看" className="project-inspection-panel">
    <div className="data-browser-section-title"><div><h3>项目步骤 · 只读查看</h3><p>独立检查，不打开或覆盖当前工作区。</p></div>
      <button ref={backRef} onClick={onBack}>返回项目列表</button></div>
    {state.status === "loading" ? <p role="status">正在读取项目步骤… 可随时返回取消。</p>
      : state.status === "error" ? <div className="data-browser-error" role="alert">{state.message}</div>
        : <ProjectInspectionContent inspection={state.data} />}
    {state.status !== "loading" && <button onClick={() => { backRef.current?.focus(); setState({ status: "loading" }); setAttempt((value) => value + 1); }}>重新读取</button>}
  </section>;
}
