import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CsvUploadDialog } from "./CsvUploadDialog";

describe("CsvUploadDialog", () => {
  it("呈现拖拽、文件选择、进度限制和临时存储说明", () => {
    const html = renderToStaticMarkup(<CsvUploadDialog onUploaded={() => undefined} onClose={() => undefined} />);
    expect(html).toContain("上传 CSV");
    expect(html).toContain("拖拽 CSV 文件");
    expect(html).toContain("accept=\".csv,text/csv\"");
    expect(html).toContain("50,000 行");
    expect(html).toContain("未启用本地持久化时重启失效");
  });
});
