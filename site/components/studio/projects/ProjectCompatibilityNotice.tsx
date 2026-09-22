import { projectCompatibilityMessage, type ProjectCompatibility } from "@/core/projects/compatibility";

export const PROJECT_COMPATIBILITY_SAVE_LABEL = "版本不兼容 · 自动保存已暂停";

/** Metadata only. Unknown definitions never become renderable/executable Cells. */
export function ProjectCompatibilityNotice({ issue }: { issue: ProjectCompatibility }) {
  return <section className="project-compatibility-notice" role="alert" aria-label="项目兼容性检查">
    <strong>项目定义与当前版本不兼容</strong>
    <p>{projectCompatibilityMessage(issue)}</p>
    {issue.reason === "notebook-cells" && <>
      <ul>{issue.cells.map((cell) => <li key={`${cell.notebookIndex}:${cell.cellIndex}`}>
        第 {cell.notebookIndex} 个 Notebook · 第 {cell.cellIndex} 个单元
        {cell.kind && <> · 类型 <code>{cell.kind}</code></>}
      </li>)}</ul>
      {issue.omitted > 0 && <p>另有 {issue.omitted} 个不支持的单元未列出；全部 {issue.total} 个均受保护。</p>}
    </>}
    <p>本次操作已被拒绝，不会转换、删除未知定义或用空白项目覆盖原定义。未保存的修改仍需在原窗口备份。</p>
    <p>请先备份整个项目文件夹，再使用支持这些定义的版本打开。如果替换了错误的清单文件，请恢复正确备份后重试；不要直接删掉不认识的步骤。</p>
  </section>;
}
