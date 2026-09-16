import { createHash } from "node:crypto";
import writeXlsxFile from "write-excel-file/node";
import { describe, expect, it } from "vitest";
import type { NotebookRun } from "@/core/notebook/contracts";
import { POST } from "./route";

describe("Python 原件经真实 Notebook API 执行", () => {
  it("用 pandas 读取两个 Excel 工作表、concat 后由 SQL 汇总，结果保留原件摘要", async () => {
    const bytes = await writeXlsxFile(["A", "B"].map((sheet, index) => ({ sheet, data: [
      [{ value: "station", type: String }, { value: "seconds", type: String }],
      [{ value: "EDS", type: String }, { value: (index + 1) * 60, type: Number }],
    ] }))).toBuffer();
    const form = new FormData();
    form.set("payload", JSON.stringify({ pageId: "test", document: { name: "合成 Excel", revision: 2, cells: [
      { id: "python", kind: "python", title: "读取工作簿", inputCellIds: [], fileNames: ["synthetic.xlsx"], outputName: "records",
        code: "sheets = pd.read_excel(files['synthetic.xlsx'], sheet_name=None)\nprint('sheets:', ','.join(sheets))\nrecords = pd.concat([frame.assign(sheet=name) for name, frame in sheets.items()], ignore_index=True)" },
      { id: "sql", kind: "sql", title: "停机汇总", inputCellIds: ["python"], outputName: "summary",
        sql: "SELECT station, COUNT(*) AS alarms, SUM(seconds) / 60 AS minutes FROM records GROUP BY station" },
      { id: "chart", kind: "chart", title: "停机图", inputCellId: "sql", chartType: "bar", categoryField: "station", valueFields: ["minutes"] },
    ] } }));
    form.append("file", new File([new Uint8Array(bytes)], "synthetic.xlsx"));
    const response = await POST(new Request("http://127.0.0.1:3001/api/notebook/run", { method: "POST", body: form }));
    const body = await response.json() as { run: NotebookRun };
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.run.status, JSON.stringify(body)).toBe("success");
    expect(body.run.cells[0].stdout).toBe("sheets: A,B\n");
    expect(body.run.cells[0].table?.rows).toEqual([{ station: "EDS", seconds: 60, sheet: "A" }, { station: "EDS", seconds: 120, sheet: "B" }]);
    expect(body.run.cells[1].table?.rows).toEqual([{ station: "EDS", alarms: 2, minutes: 3 }]);
    expect(body.run.cells[2].resultRef?.sourceFiles).toEqual([{ name: "synthetic.xlsx", sha256: createHash("sha256").update(bytes).digest("hex") }]);
  }, 30_000);

  it("缺失文件明确失败，路径穿越和重复文件名被拒绝", async () => {
    const payload = { pageId: "test", document: { name: "缺失文件", revision: 0, cells: [
      { id: "python", title: "读取", kind: "python", inputCellIds: [], fileNames: ["missing.xlsx"], outputName: "result", code: "result = pd.read_excel(files['missing.xlsx'])" },
    ] } };
    const request = () => new Request("http://127.0.0.1:3001/api/notebook/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const response = await POST(request());
    expect((await response.json() as { run: NotebookRun }).run.cells[0]).toMatchObject({ status: "failure", error: expect.stringContaining("当前不可用") });
    payload.document.cells[0].fileNames = ["../secret.csv"];
    expect((await POST(request())).status).toBe(400);
    const form = new FormData(); form.set("payload", JSON.stringify(payload));
    form.append("file", new File(["x\n1"], "same.csv")); form.append("file", new File(["x\n2"], "same.csv"));
    expect((await POST(new Request("http://127.0.0.1:3001/api/notebook/run", { method: "POST", body: form }))).status).toBe(400);
  });
});
