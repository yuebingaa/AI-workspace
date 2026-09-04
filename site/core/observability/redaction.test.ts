import { describe, expect, it } from "vitest";
import { redactOperationalText } from "./redaction";

describe("运维日志脱敏", () => {
  it("移除 Bearer、常见密钥赋值和本地路径", () => {
    const redacted = redactOperationalText("Authorization: Bearer abc.def token=secret123 C:\\Users\\User\\private.xlsx /home/user/private.csv");
    expect(redacted).not.toContain("abc.def");
    expect(redacted).not.toContain("secret123");
    expect(redacted).not.toContain("private.xlsx");
    expect(redacted).not.toContain("private.csv");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).toContain("[LOCAL_PATH]");
  });
});
