import { describe, expect, it } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import type { HarnessRequest, HarnessSemanticIntentDecision } from "./contracts";
import { selectHarnessSkills, selectedHarnessSkillSummaries } from "./skill-registry";

function request(instruction: string, previousInstruction?: string): HarnessRequest {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return {
    idempotencyKey: `skill_${instruction.length}_${previousInstruction?.length ?? 0}`,
    instruction,
    pageId: "page_home",
    role: "editor",
    appSpec: structuredClone(demoFixtureResult.data.dataProduct.appSpec),
    recipes: structuredClone(demoFixtureResult.data.dataProduct.recipes),
    ...(previousInstruction ? { conversationContext: { previousInstruction } } : {}),
  };
}

function edsRequest(instruction: string, previousInstruction?: string): HarnessRequest {
  const input = request(instruction, previousInstruction);
  input.appSpec.dataSources[0].id = "dataset_eds_overview";
  return input;
}

describe("Harness Skill 自动发现", () => {
  it("模型语义结果可以为没有关键词命中的自然表达动态加载 Skill", async () => {
    const semanticIntent: HarnessSemanticIntentDecision = {
      mode: "changePreview",
      wantsData: true,
      wantsEdsAnalysis: false,
      wantsRawWorkbook: false,
      wantsFields: false,
      wantsRecipe: false,
      wantsAppInspection: false,
      wantsExcel: false,
      changeAction: "add",
      changeTarget: "chart",
      componentKind: "chart",
      chartType: "pie",
      skillIds: ["data-visualization", "dashboard-editing"],
      confidence: 0.93,
      rationale: "用户希望以分类占比视图呈现数据。",
    };
    const skills = await selectHarnessSkills(request("页面右侧应该呈现各区域收入的圆形占比视图"), false, semanticIntent);

    expect(skills.map((skill) => skill.id)).toEqual(expect.arrayContaining(["data-visualization", "dashboard-editing"]));
  });

  it.each(["增加一个异常次数饼图", "增加一个饼状图", "把柱状图改为折线图", "visualize this as a donut chart"])("为可视化请求动态加载内置 Skill：%s", async (instruction) => {
    const skills = await selectHarnessSkills(request(instruction));
    const visualization = skills.find((skill) => skill.id === "data-visualization");
    expect(visualization).toMatchObject({ id: "data-visualization", name: "数据可视化", version: "1.0.0" });
    expect(visualization?.instructions.join("\n")).toContain("bar、line、area、pie、donut");
  });

  it("可以依据上一轮指令为省略式追问继续加载 Skill", async () => {
    expect((await selectHarnessSkills(request("换成蓝色", "刚才的异常类型柱状图"))).map((skill) => skill.id))
      .toContain("data-visualization");
  });

  it("普通数据问答不会加载任何 Skill 正文", async () => {
    expect(await selectHarnessSkills(request("这份数据一共有多少行"))).toEqual([]);
    expect(await selectHarnessSkills(request("检查字段摘要，不要修改页面，不要创建 ChangeSet"))).toEqual([]);
  });

  it("任务摘要只公开 Skill 身份，不复制完整指令", () => {
    const summaries = selectedHarnessSkillSummaries(request("生成一个饼图"));
    expect(summaries).toEqual(expect.arrayContaining([
      { id: "data-visualization", name: "数据可视化", version: "1.0.0" },
      { id: "dashboard-editing", name: "看板组件编辑", version: "1.0.0" },
    ]));
    expect(JSON.stringify(summaries)).not.toContain("instructions");
  });

  it("EDS 分析、表格修改和原始工作簿问题分别动态加载精确技能", async () => {
    const [analysis, tableEdit, workbook] = await Promise.all([
      selectHarnessSkills(edsRequest("比较白班和夜班异常次数")),
      selectHarnessSkills(edsRequest("线体与异常分类明细先按线体再按异常分类排序")),
      selectHarnessSkills(edsRequest("完整扫描原始工作簿并统计全部匹配行")),
    ]);

    expect(analysis.map((skill) => skill.id)).toContain("eds-analysis");
    expect(tableEdit.map((skill) => skill.id)).toEqual(expect.arrayContaining(["eds-analysis", "dashboard-editing"]));
    expect(workbook.map((skill) => skill.id)).toEqual(expect.arrayContaining(["eds-analysis", "workbook-analysis"]));
    expect(await selectHarnessSkills(edsRequest("谢谢"))).toEqual([]);
  });
});
