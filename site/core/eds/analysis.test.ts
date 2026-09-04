import { describe, expect, it } from "vitest";
import { createSyntheticEdsFixture } from "@/fixtures/eds-synthetic";
import { analyzeEdsWorkbook, analyzeEdsWorkbookForSelection, EdsAnalysisError, EdsSelectionRequiredError, parseEdsTemplate } from "./analysis";

describe("EDS 确定性统计", () => {
  it("不提供外部目标表时从输入自动识别范围并使用内置版本化规则", () => {
    const fixture = createSyntheticEdsFixture();
    const result = analyzeEdsWorkbook(fixture.sourceSheets);

    expect(result.summary).toMatchObject({ date: "2026-08-25", shift: "白班", matchedRows: result.summary.totalOccurrences });
    expect(result.comparison).toBeNull();
    expect(result.configuration).toEqual({
      templateVersion: "EDS-REPORT-2026.09",
      ruleVersion: "EDS-RULES-2026.09",
      comparisonMode: "not_requested",
    });
    expect(result.detailRows).toHaveLength(28);
    expect(result.lineSummary).toHaveLength(10);
  });

  it("按日期、班次、线体、通道和完整异常名称计算 14×20×2 核心值", () => {
    const fixture = createSyntheticEdsFixture();
    const result = analyzeEdsWorkbook(fixture.sourceSheets, fixture.templateSheets);

    expect(result.summary).toMatchObject({
      date: "2026-08-25",
      shift: "白班",
      issueCount: 14,
      channelCount: 20,
    });
    expect(result.detailRows).toHaveLength(28);
    expect(result.detailRows.every((row) => row.length === 20)).toBe(true);
    expect(result.comparison).toMatchObject({
      coreMatched: 560,
      coreTotal: 560,
      reportMatched: 660,
      reportTotal: 660,
      mismatchCount: 0,
    });
    expect(result.summary.matchedRows).toBe(result.summary.totalOccurrences);
    expect(result.summary.matchedRows).toBeLessThan(result.summary.inputRows);
    expect(result.issueSummary).toHaveLength(14);
    expect(result.lineSummary).toHaveLength(10);
    expect(result.configuration.comparisonMode).toBe("custom_template");
  });

  it("多个共同日期或班次返回可选范围，并可按用户选择独立分析", () => {
    const fixture = createSyntheticEdsFixture();
    for (const sheet of fixture.sourceSheets) {
      const extra = structuredClone(sheet.data[1]);
      extra[4] = new Date("2026-08-26T00:00:00.000Z");
      sheet.data.push(extra);
    }
    try {
      analyzeEdsWorkbook(fixture.sourceSheets);
      throw new Error("expected selection requirement");
    } catch (error) {
      expect(error).toBeInstanceOf(EdsSelectionRequiredError);
      expect((error as EdsSelectionRequiredError).selections).toEqual([
        { date: "2026-08-25", shift: "白班" },
        { date: "2026-08-26", shift: "白班" },
      ]);
    }

    const selected = analyzeEdsWorkbookForSelection(
      fixture.sourceSheets,
      { date: "2026-08-26", shift: "白班" },
    );
    expect(selected.summary).toMatchObject({ date: "2026-08-26", shift: "白班", matchedRows: 2 });
    expect(() => analyzeEdsWorkbookForSelection(
      fixture.sourceSheets,
      { date: "2026-08-27", shift: "白班" },
    )).toThrow(/不在当前工作簿/u);
  });

  it("目标值发生变化时给出精确单元格差异，不降低比对标准", () => {
    const fixture = createSyntheticEdsFixture();
    fixture.templateSheets[0].data[6][4] = Number(fixture.templateSheets[0].data[6][4]) + 1;
    const result = analyzeEdsWorkbook(fixture.sourceSheets, fixture.templateSheets);

    expect(result.comparison.coreMatched).toBe(559);
    expect(result.comparison.reportMatched).toBe(659);
    expect(result.comparison.mismatchCount).toBe(1);
    expect(result.comparison.mismatches[0]).toMatchObject({ cell: "E7" });
    expect(result.warnings[0]).toContain("1 个数值差异");
  });

  it("外部验收表不能改写内置异常和通道规则", () => {
    const fixture = createSyntheticEdsFixture();
    fixture.templateSheets[0].data[6][0] = "自定义异常规则";

    expect(() => analyzeEdsWorkbook(fixture.sourceSheets, fixture.templateSheets))
      .toThrow(/与内置模板 EDS-REPORT-2026\.09.*映射不一致/u);
    expect(analyzeEdsWorkbook(fixture.sourceSheets).summary.totalOccurrences).toBeGreaterThan(0);
  });

  it("缺少原始表、模板规则或唯一线体映射时安全失败", () => {
    const fixture = createSyntheticEdsFixture();
    expect(() => analyzeEdsWorkbook(fixture.sourceSheets.slice(0, 1), fixture.templateSheets)).toThrow(EdsAnalysisError);

    const missingIssue = createSyntheticEdsFixture();
    missingIssue.templateSheets[0].data[6][0] = null;
    expect(() => analyzeEdsWorkbook(missingIssue.sourceSheets, missingIssue.templateSheets)).toThrow(/缺少完整异常名称/);

    const duplicateLine = createSyntheticEdsFixture();
    duplicateLine.sourceSheets[0].data.push([...duplicateLine.sourceSheets[1].data[1]]);
    expect(() => analyzeEdsWorkbook(duplicateLine.sourceSheets, duplicateLine.templateSheets)).toThrow(/只能匹配一张/);
  });

  it("拒绝无效日历日期、无效 Date 和无法有限累计的时长", () => {
    for (const invalidValue of ["2026-02-29", "2026-02-31", "2026-09-31", "2026-08-25garbage", "08/25/2026"]) {
      const invalidCalendar = createSyntheticEdsFixture();
      invalidCalendar.templateSheets[0].data[0][2] = invalidValue;
      expect(() => parseEdsTemplate(invalidCalendar.templateSheets)).toThrow(/有效日期/);
    }
    for (const validValue of ["2024-02-29", "2026/8/25", "2026-08-25T00:00:00.000Z"]) {
      const validCalendar = createSyntheticEdsFixture();
      validCalendar.templateSheets[0].data[0][2] = validValue;
      expect(() => parseEdsTemplate(validCalendar.templateSheets)).not.toThrow();
    }

    const invalidDate = createSyntheticEdsFixture();
    invalidDate.templateSheets[0].data[0][2] = new Date(Number.NaN);
    expect(() => parseEdsTemplate(invalidDate.templateSheets)).toThrow(/无效 Date/);

    const overflow = createSyntheticEdsFixture();
    const matching = structuredClone(overflow.sourceSheets[0].data[1]);
    matching[3] = 1e308;
    overflow.sourceSheets[0].data.push(matching, structuredClone(matching));
    expect(() => analyzeEdsWorkbook(overflow.sourceSheets, overflow.templateSheets)).toThrow(/有限数值范围/);
  });

  it("目标候选行非法日期显式失败而无关备注行仍可忽略", () => {
    const invalidCandidate = createSyntheticEdsFixture();
    invalidCandidate.sourceSheets[0].data[1][4] = "bad-date";
    expect(() => analyzeEdsWorkbook(invalidCandidate.sourceSheets, invalidCandidate.templateSheets)).toThrow(/工作日/);

    const unrelatedFooter = createSyntheticEdsFixture();
    unrelatedFooter.sourceSheets[0].data.at(-1)![4] = "bad-date";
    expect(analyzeEdsWorkbook(unrelatedFooter.sourceSheets, unrelatedFooter.templateSheets).comparison)
      .toMatchObject({ coreMatched: 560, reportMatched: 660, mismatchCount: 0 });
  });

  it("小数秒、负零与目标缓存舍入保持汇总和比对语义一致", () => {
    const fractional = createSyntheticEdsFixture();
    const matchingRows = fractional.sourceSheets.flatMap((sheet) => sheet.data).filter((row) => (
      row[4] instanceof Date
      && row[4].toISOString().startsWith("2026-08-25")
      && row[5] === "白班"
      && row[2] === fractional.templateSheets[0].data[6][0]
    ));
    expect(matchingRows.length).toBeGreaterThanOrEqual(3);
    matchingRows[0][3] = 0.1;
    matchingRows[1][3] = 0.2;
    matchingRows[2][3] = -0;
    const result = analyzeEdsWorkbook(fractional.sourceSheets, fractional.templateSheets);
    const publicMinutes = [
      result.summary.totalMinutes,
      ...result.issueSummary.map((item) => item.minutes),
      ...result.lineSummary.map((item) => item.minutes),
      ...result.reportRows.filter((_, index) => index % 2 === 1).flat(),
    ];
    expect(publicMinutes.every((value) => Number.isFinite(value) && value >= 0 && !Object.is(value, -0))).toBe(true);
    expect(result.issueSummary.reduce((total, item) => total + item.minutes, 0)).toBeCloseTo(result.summary.totalMinutes, 12);
    expect(result.lineSummary.reduce((total, item) => total + item.minutes, 0)).toBeCloseTo(result.summary.totalMinutes, 12);

    const withinTolerance = createSyntheticEdsFixture();
    withinTolerance.templateSheets[0].data[6][4] = Number(withinTolerance.templateSheets[0].data[6][4]) + 1e-9;
    expect(analyzeEdsWorkbook(withinTolerance.sourceSheets, withinTolerance.templateSheets).comparison.mismatchCount).toBe(0);

    const outsideTolerance = createSyntheticEdsFixture();
    outsideTolerance.templateSheets[0].data[6][4] = Number(outsideTolerance.templateSheets[0].data[6][4]) + 1e-4;
    const comparison = analyzeEdsWorkbook(outsideTolerance.sourceSheets, outsideTolerance.templateSheets).comparison;
    expect(comparison.mismatchCount).toBe(1);
    expect(comparison.mismatches[0]).toMatchObject({ cell: "E7" });
  });

  it("源 DT(s) 非数值类型拒绝而目标统计格非数值形成明确差异", () => {
    for (const invalidDuration of [true, false, null, "", " ", "#DIV/0!"]) {
      const fixture = createSyntheticEdsFixture();
      fixture.sourceSheets[0].data[1][3] = invalidDuration;
      expect(() => analyzeEdsWorkbook(fixture.sourceSheets, fixture.templateSheets))
        .toThrow(/存在无法统计的 DT\(s\) 值/u);
    }
    const zero = createSyntheticEdsFixture();
    zero.sourceSheets[0].data[1][3] = 0;
    expect(() => analyzeEdsWorkbook(zero.sourceSheets, zero.templateSheets)).not.toThrow();

    for (const invalidExpected of [true, false, null, "", " ", "#DIV/0!"]) {
      const fixture = createSyntheticEdsFixture();
      fixture.templateSheets[0].data[6][4] = invalidExpected;
      const result = analyzeEdsWorkbook(fixture.sourceSheets, fixture.templateSheets);
      expect(result.comparison.mismatchCount).toBe(1);
      expect(result.comparison.mismatches[0]).toMatchObject({ cell: "E7", expected: null });
      expect(result.warnings).toEqual([expect.stringMatching(/1 个数值差异/u)]);
    }
  });

  it("拒绝同一来源表头行重复出现必需字段", () => {
    for (const duplicateHeader of ["Line", "Instance", "Issue Description", "DT(s)", "工作日", "班次"]) {
      const fixture = createSyntheticEdsFixture();
      fixture.sourceSheets[0].data[0].push(duplicateHeader);
      const normalizedHeader = duplicateHeader
        .normalize("NFKC")
        .replace(/\s+/gu, "")
        .toLocaleLowerCase("en-US")
        .replace(/[()]/gu, "\\$&");
      expect(() => analyzeEdsWorkbook(fixture.sourceSheets, fixture.templateSheets))
        .toThrow(new RegExp(`必需表头.*${normalizedHeader}.*只能出现一次`, "u"));
    }
  });

  it("只在前 20 行识别完整表头并跳过合并式空洞", () => {
    const atBoundary = createSyntheticEdsFixture();
    for (const sheet of atBoundary.sourceSheets) {
      sheet.data.unshift(
        ...Array.from({ length: 18 }, (_, index) => [`标题 ${index + 1}`]),
        ["Line", "Instance", null, "DT(s)", null, "班次"],
      );
    }
    const result = analyzeEdsWorkbook(atBoundary.sourceSheets, atBoundary.templateSheets);
    expect(result.comparison).toMatchObject({ coreMatched: 560, reportMatched: 660, mismatchCount: 0 });

    const afterBoundary = createSyntheticEdsFixture();
    for (const sheet of afterBoundary.sourceSheets) {
      sheet.data.unshift(...Array.from({ length: 20 }, (_, index) => [`标题 ${index + 1}`]));
    }
    expect(() => analyzeEdsWorkbook(afterBoundary.sourceSheets, afterBoundary.templateSheets))
      .toThrow(/至少需要两张包含 EDS 必需字段的原始明细表/u);
  });

  it("拒绝与导出双列合并结构不一致的通道线体映射", () => {
    const fixture = createSyntheticEdsFixture();
    fixture.templateSheets[0].data[2][5] = "SYN-UNPAIRED-LINE";
    fixture.templateSheets[0].data[4][5] = "未配对线体";

    expect(() => parseEdsTemplate(fixture.templateSheets)).toThrow(/必须成对映射同一线体/);
  });
});
