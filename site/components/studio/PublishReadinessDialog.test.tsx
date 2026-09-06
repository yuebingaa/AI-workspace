import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublishReadinessDialog } from "./PublishReadinessDialog";

describe("PublishReadinessDialog", () => {
  it("明确区分本地保存、公网发布、数据文件与服务端密钥", () => {
    const html = renderToStaticMarkup(<PublishReadinessDialog onDownloadBackup={() => undefined} onClose={() => undefined} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("当前按钮不会直接提交代码或部署网站");
    expect(html).toContain("浏览器本地草稿");
    expect(html).toContain("不会随页面发布");
    expect(html).toContain("DeepSeek API Key 不得写入浏览器变量");
    expect(html).toContain("先下载工作区备份");
  });
});
