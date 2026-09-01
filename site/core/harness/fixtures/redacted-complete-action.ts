/**
 * 根据真实测试中已保存的脱敏失败类别重建，不包含模型原文或数据行。
 * 失败发生在只读 inspectDataset 成功后的第二轮，旧式 action 包装使用 completed 别名。
 */
export const redactedCompleteActionFailureFixture = {
  message: "数据集检查完成，已返回行列数和字段摘要。",
  action: {
    type: "completed",
  },
} as const;

export const redactedCompleteActionFailureDescription = {
  shape: "message + action",
  fieldNames: ["message", "action", "action.type"],
  schemaIssues: [
    "旧 Schema：action.type:invalid_union，completed 不属于 complete 或 tool",
    "新顶层判别联合：type:invalid_union，旧包装缺少顶层 type",
  ],
} as const;
