import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { normalizeIcpLicense, SiteComplianceFooter } from "./SiteComplianceFooter";

describe("SiteComplianceFooter", () => {
  it("未配置真实备案号时不渲染占位内容", () => {
    expect(renderToStaticMarkup(<SiteComplianceFooter license={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<SiteComplianceFooter license="   " />)).toBe("");
  });

  it("在主页底部展示配置的备案号并链接工信部备案系统", () => {
    const html = renderToStaticMarkup(<SiteComplianceFooter license="  示例 ICP 备案号  " />);
    expect(html).toContain("示例 ICP 备案号");
    expect(html).toContain('href="https://beian.miit.gov.cn/"');
    expect(html).toContain('target="_blank"');
  });

  it("拒绝控制字符和超长配置，避免把错误环境值公开展示", () => {
    expect(normalizeIcpLicense("示例\nICP备案号")).toBeNull();
    expect(normalizeIcpLicense("x".repeat(81))).toBeNull();
    expect(normalizeIcpLicense("  示例   ICP备案号  ")).toBe("示例 ICP备案号");
  });
});
