import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CsvUploadDialog } from "./CsvUploadDialog";

describe("CsvUploadDialog", () => {
  it("呈现拖拽、文件选择、进度限制和临时存储说明", () => {
    const html = renderToStaticMarkup(<CsvUploadDialog onUploaded={() => undefined} onClose={() => undefined} />);
    expect(html).toContain("导入本机表格");
    expect(html).toContain("拖拽 CSV 或 XLSX 到这里");
    expect(html).toContain(".csv,.xlsx");
    expect(html).toContain("multiple=\"\"");
    expect(html).toContain("支持一次多选");
    expect(html).toContain("50,000 行");
    expect(html).toContain("注册数据源最多保留 30 分钟");
  });
});
