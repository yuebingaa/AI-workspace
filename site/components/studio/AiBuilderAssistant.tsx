import type { ChangeSet, ChangeSetAuditRecord } from "@/core/models";
import { studioRoleLabels } from "@/core/permissions";

export type ChangeSetUiStatus = "pending" | "preview" | "applied";

interface AiBuilderAssistantProps {
  pageTitle: string;
  datasetName: string;
  changeSet: ChangeSet;
  status: ChangeSetUiStatus;
  validationError: string | null;
  canApply: boolean;
  auditRecords: ChangeSetAuditRecord[];
  onPreview: () => void;
  onApply: () => void;
  onCancelPreview: () => void;
}

const statusLabels: Record<ChangeSetUiStatus, string> = {
  pending: "等待确认",
  preview: "画布预览中",
  applied: "已应用",
};
const auditSourceLabels = { ai: "AI", puck: "Puck", manual: "手动" } as const;

export function AiBuilderAssistant({
  pageTitle,
  datasetName,
  changeSet,
  status,
  validationError,
  canApply,
  auditRecords,
  onPreview,
  onApply,
  onCancelPreview,
}: AiBuilderAssistantProps) {
  return (
    <aside className="right-panel panel">
      <div className="assistant-head">
        <div><span className="ai-mark">✦</span><div><b>AI 构建助手</b><small>正在读取当前数据产品</small></div></div>
        <button type="button" aria-label="助手菜单">···</button>
      </div>
      <div className="context-pill">上下文：{pageTitle} · {datasetName.replace(".csv", "")}</div>
      <details className="audit-history">
        <summary>变更审计记录 <span>{auditRecords.length}</span></summary>
        <div>
          {!auditRecords.length && <p>预览、应用、取消或撤销后会在这里留下记录。</p>}
          {auditRecords.slice(0, 12).map((record) => (
            <article key={record.id} className={record.status}>
              <div><b>{record.status === "previewed" ? "已预览" : record.status === "applied" ? "已应用" : record.status === "cancelled" ? "已取消" : record.status === "undone" ? "已撤销" : "失败"}</b><span>{studioRoleLabels[record.role]} · {auditSourceLabels[record.source]}</span></div>
              <p>{record.operationSummary || record.changeSetId}</p>
              <small>{new Date(record.timestamp).toLocaleString("zh-CN")}</small>
              {record.error && <em>{record.error}</em>}
            </article>
          ))}
        </div>
      </details>
      <div className="conversation">
        <div className="user-message">整理华东异常订单，创建复购分析，并提供 Excel 下载。</div>
        <div className="assistant-message">
          <span className="ai-mark small">✦</span>
          <div>
            <p>我已检查数据结构和当前画布，建议执行以下变更：</p>
            {validationError && (
              <div className="validation-error" role="alert">
                <b>无法执行变更</b>
                <p>{validationError}</p>
              </div>
            )}
            <div className="change-plan">
              <div className="plan-head"><b>变更计划</b><span className={status === "applied" ? "done" : status}>{statusLabels[status]}</span></div>
              <ol>
                {changeSet.operations.map((operation, index) => (
                  <li key={operation.id}>
                    <span>{index + 1}</span>
                    <div><b>{operation.label}</b><small>{operation.description}</small></div>
                  </li>
                ))}
              </ol>
              <div className="plan-actions">
                {status === "preview" ? (
                  <button type="button" onClick={onCancelPreview}>取消预览</button>
                ) : (
                  <button type="button" disabled={status === "applied"} onClick={onPreview}>画布预览</button>
                )}
                <button type="button" className="apply" disabled={status === "applied" || !canApply} title={canApply ? "应用变更" : "查看者只能预览变更"} onClick={onApply}>
                  {status === "applied" ? "已全部应用 ✓" : "全部应用"}
                </button>
              </div>
            </div>
            <p className="safe-note">所有改动都通过本地结构化 ChangeSet 执行，可预览、应用和撤销。</p>
          </div>
        </div>
      </div>
      <div className="prompt-box">
        <textarea aria-label="AI 指令" placeholder="描述你想分析的数据或创建的页面……" />
        <div><span>＋　@ 数据　/ 命令</span><button type="button" aria-label="发送模拟指令">↑</button></div>
      </div>
    </aside>
  );
}
