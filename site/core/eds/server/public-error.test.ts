import { describe, expect, it } from "vitest";
import { sanitizeEdsPublicError } from "./public-error";

describe("EDS 公共错误净化", () => {
  it("遮蔽秘密和本地路径、折叠控制字符并限制 Unicode 字符数", () => {
    const result = sanitizeEdsPublicError(
      `Authorization: Bearer top.secret\r\nC:\\Users\\Alice\\secret.xlsx\ntoken=abc123 \u0000${"数".repeat(800)}`,
    );

    expect(result).not.toMatch(/top\.secret|abc123|Alice|[\r\n\u0000]/u);
    expect(result).toContain("[REDACTED]");
    expect(result).toContain("[LOCAL_PATH]");
    expect(Array.from(result)).toHaveLength(500);
  });

  it("空白错误使用固定回退消息", () => {
    expect(sanitizeEdsPublicError("\r\n\u0000")).toBe("EDS 工作簿分析失败。");
  });
});
