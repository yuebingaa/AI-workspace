import { describe, expect, it } from "vitest";
import { instructionRequestsRawWorkbook } from "./raw-workbook";

describe("Harness 原始工作簿请求识别", () => {
  it.each([
    "读取原始数据第 20 行",
    "查看白班明细工作表",
    "分析这些逐行明细",
    "把整份表格读完并统计",
    "完整扫描全部数据",
    "read raw workbook rows",
  ])("识别需要附带原始工作簿的指令：%s", (instruction) => {
    expect(instructionRequestsRawWorkbook(instruction)).toBe(true);
  });

  it("仅在上一轮属于原始数据任务时承接省略式追问", () => {
    expect(instructionRequestsRawWorkbook("那下一行呢", "读取原始工作簿第 2 行")).toBe(true);
    expect(instructionRequestsRawWorkbook("那下一行呢", "比较白班和夜班派生汇总")).toBe(false);
    expect(instructionRequestsRawWorkbook("比较白班和夜班", "读取原始工作簿第 2 行")).toBe(false);
  });
});
