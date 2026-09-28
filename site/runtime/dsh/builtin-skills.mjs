// Trusted, bounded instructions only. No filesystem discovery, scripts or user paths.
export const name = 'agentcanvas-builtin-skills';
export const inject = ['skills'];
export const BUILTIN_SKILLS = Object.freeze([
  Object.freeze({ name: 'data-inspection', description: '检查已选数据或文件的结构、字段与质量；先读工具证据，再说明分析方向。',
    content: '先检查当前任务提供的数据目录和 Notebook 索引。用可用的 cellSearch、原件检查或 Schema 工具核实字段与来源；无相应工具时说明缺口。不得从文件名推断内容，不得把抽样当作全量统计。区分空值、类型、日期、重复行及计算口径；需要计算时使用现有 Notebook 执行工具，回答引用实际结果。工具失败先解释原因，不伪造成功。没有授权的数据不要访问。' }),
  Object.freeze({ name: 'notebook-analysis', description: '使用 Notebook 进行数据分析和图表制作，验证真实运行结果并提交可采用的草稿。',
    content: '先用 cellSearch 了解已有单元及输出。只为用户本次目标增改必要单元，复用实际字段和依赖；业务指标优先沿用选定语义模型，不猜测公式。编辑后用 runNotebookCells 试运行，检查错误及结果，再用 submitNotebookDraft 提交。运行成功不等于已正式保存，必须说明待用户采用；只读问题不需要编辑或提交。结果不够时用文字提出具体澄清问题，不捏造数据，不操作工具目录之外的能力。' }),
]);
export function apply(ctx) {
  for (const skill of BUILTIN_SKILLS) ctx.skills.register({ ...skill, source: 'bundled',
    invocation: { modelInvocable: true, userInvocable: false },
    resourceBase: { kind: 'opaque', description: '网站内置说明，无外部资源或可执行脚本。' },
  });
}
