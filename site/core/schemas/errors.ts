import type { z } from "zod";

function issueMessage(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return `类型不正确，应为 ${issue.expected}`;
    case "too_small":
      return "数量或长度低于允许范围";
    case "too_big":
      return "数值或数量超过允许范围";
    case "unrecognized_keys":
      return `包含未定义属性：${issue.keys.join("、")}`;
    case "invalid_value":
      return "值不在允许范围内";
    case "custom":
      return issue.message;
    default:
      return "格式不符合 Schema 定义";
  }
}

export function formatSchemaIssues(error: z.ZodError, subject: string): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "根节点";
    return `${subject} ${path}：${issueMessage(issue)}`;
  });
}

export class StudioValidationError extends Error {
  readonly issues: string[];

  constructor(title: string, issues: string[]) {
    super(`${title}：${issues.join("；")}`);
    this.name = "StudioValidationError";
    this.issues = issues;
  }
}

export function readableValidationError(error: unknown): string {
  if (error instanceof StudioValidationError) return error.message;
  if (error instanceof Error) return error.message;
  return "发生未知校验错误，请检查变更内容。";
}
