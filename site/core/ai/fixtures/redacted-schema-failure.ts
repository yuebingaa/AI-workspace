/**
 * 脱敏的真实连通测试失败记录。
 *
 * 旧实现只保留了 HTTP 422、invalid_output 和“两次 Schema 校验失败”这一失败类别，
 * 没有持久化 Zod issue path，也没有保留模型原始响应。因此这里明确区分可证实事实与
 * 用于回归的最小代表性候选，避免杜撰真实字段或泄露上游内容。
 */
export const redactedSchemaFailureFixture = {
  observed: {
    httpStatus: 422,
    errorCode: "invalid_output",
    attempts: 2,
    failureClass: "schema_validation_after_repair",
    persistedFieldIssues: false,
  },
  representativeCandidate: {
    message: "已生成修改计划。",
    changeSet: {
      id: "model_generated_id",
      status: "ready",
      operations: [{
        type: "updateNodeProps",
        pageId: "page_home",
        nodeId: "page_home_revenue",
        props: { label: "月度总收入" },
      }],
    },
  },
};
