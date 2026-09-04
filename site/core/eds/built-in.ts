export const EDS_TEMPLATE_VERSION = "EDS-REPORT-2026.09";
export const EDS_RULE_VERSION = "EDS-RULES-2026.09";

export interface EdsBuiltInIssue {
  raw: string;
  display: string;
}

export interface EdsBuiltInChannel {
  columnIndex: number;
  line: string;
  instance: string;
  displayLine: string;
  displayChannel: string;
}

const ISSUE_LABELS = [
  ["飞达工位飞达报警中", "飞达工位飞达报警中"],
  ["飞达工位飞达出标超时", "飞达工位飞达出标超时"],
  ["飞达工位取膜上相机返回数据NG", "飞达工位取膜上相机返回数据NG"],
  ["飞达工位取膜上相机三次NG", "飞达工位取膜上相机三次NG"],
  ["贴膜工位Cy_贴膜Robot上下气缸到位信号报警  输入:AI0_00 输出:AQ0_00", "贴膜Robot上下气缸到位信号报警"],
  ["贴膜工位Va_贴膜Robot真空1吸真空超时  输入:I04[00] 输出:吸Q04[00] 破Q04[01]", "贴膜Robot真空1吸真空超时"],
  ["贴膜工位Va_贴膜Robot真空2吸真空超时  输入:I04[01] 输出:吸Q04[02] 破Q04[03]", "贴膜Robot真空2吸真空超时"],
  ["贴膜工位Va_贴膜Robot真空3吸真空超时  输入:I04[02] 输出:吸Q04[04] 破Q04[05]", "贴膜Robot真空3吸真空超时"],
  ["贴膜工位Va_贴膜Robot真空4吸真空超时  输入:I04[03] 输出:吸Q04[06] 破Q04[07]", "贴膜Robot真空4吸真空超时"],
  ["贴膜工位抛料设定次数到达，请清洁抛料平台！", "贴膜工位抛料设定次数到达"],
  ["贴膜工位贴膜Robot定位超时报警", "贴膜工位贴膜Robot定位超时报警"],
  ["贴膜工位贴膜对位计算NG", "贴膜工位贴膜对位计算NG"],
  ["贴膜工位贴膜对位计算返回数据超时", "贴膜工位贴膜对位计算返回数据超时"],
  ["贴膜工位贴膜下相机返拍照NG", "贴膜工位贴膜下相机返拍照NG"],
] as const;

const LINE_LABELS = [
  [4, "DSA-5FAP-01", "A5FNL01"],
  [6, "DSA-5FAP-02", "A5FNL02"],
  [8, "DSA-5FAP-03", "A5FNL03"],
  [10, "DSA-5FAP-09", "A5FSL06"],
  [12, "DSB-5FAP-11", "B5FSL01"],
  [14, "DSA-5FAP-18", "A5FSL05"],
  [17, "DSA-5FAP-08", "A5FSL01"],
  [19, "DSA-5FAP-10", "A5FSL02"],
  [21, "DSA-5FAP-13", "A5FSL03"],
  [23, "DSA-5FAP-14", "A5FSL04"],
] as const;

export const EDS_BUILT_IN_ISSUES: readonly EdsBuiltInIssue[] = Object.freeze(
  ISSUE_LABELS.map(([raw, display]) => Object.freeze({ raw, display })),
);

export const EDS_BUILT_IN_CHANNELS: readonly EdsBuiltInChannel[] = Object.freeze(
  LINE_LABELS.flatMap(([columnIndex, line, displayLine]) => [
    Object.freeze({ columnIndex, line, instance: "EDS_Coat-1", displayLine, displayChannel: "1#" }),
    Object.freeze({ columnIndex: columnIndex + 1, line, instance: "EDS_Coat-2", displayLine, displayChannel: "2#" }),
  ]),
);

export const EDS_BUILT_IN_DEFINITION = Object.freeze({
  sheetName: "EDS飞达异常统计",
  issues: EDS_BUILT_IN_ISSUES,
  channels: EDS_BUILT_IN_CHANNELS,
});
