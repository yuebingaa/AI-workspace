import { StudioValidationError } from "@/core/schemas/errors";
import type { HarnessToolName } from "../contracts";

export class HarnessToolArgumentsError extends StudioValidationError {
  constructor(
    readonly toolName: HarnessToolName,
    readonly issueSummary: string[],
  ) {
    super("Harness 工具参数校验失败", [
      `工具 ${toolName} 的参数不符合定义`,
      ...issueSummary,
    ]);
    this.name = "HarnessToolArgumentsError";
  }
}
