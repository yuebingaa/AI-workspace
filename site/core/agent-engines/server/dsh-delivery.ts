import type { NotebookArtifact } from "@/core/notebook/definition";
import { redactHarnessSecrets, sanitizeHarnessText } from "@/core/harness/security";

// This is a presentation guard, never proof that model prose is factually true.
// Contradictory save/publication claims must not replace the trusted draft state.
const contradictsConfirmation = /(?:已(?:经)?\s*(?:自动)?(?:保存|采用|应用|发布|确认)|(?:无需|不用|不必|不要|跳过|绕过).{0,12}(?:确认|采用|审阅)|(?:already\s+|has\s+been\s+|have\s+been\s+)(?:saved|applied|published|adopted)|(?:skip|bypass).{0,20}(?:confirm|review)|(?:no|without).{0,20}(?:confirmation|approval))/iu;

/** Call only after the engine verifies the bridge-owned, successful draft. */
export function formatDshDraftDelivery(draft: NotebookArtifact, finalResponse?: string): string {
  const status = `DSH 已生成“${sanitizeHarnessText(draft.name)}”的 ${draft.cells.length} 个单元草稿并完成试运行。待你确认后才保存正式步骤；正式 Notebook 与看板尚未修改。`;
  if (typeof finalResponse !== "string" || !finalResponse.trim() || contradictsConfirmation.test(finalResponse)) return status;
  const cleaned = redactHarnessSecrets(finalResponse.trim());
  const label = "\n\nAI 分析说明：\n";
  return `${status}${label}${cleaned}`;
}
