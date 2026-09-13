import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import type { HarnessRequest } from "./contracts";
import { PlaywrightMultimodalVisualVerifier, type CapturedScreenshot } from "./visual-verifier";

function request(): HarnessRequest {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return {
    idempotencyKey: "request_visual_verifier",
    instruction: "检查当前看板在窄屏下是否有组件重叠",
    pageId: "page_home",
    role: "editor",
    appSpec: structuredClone(demoFixtureResult.data.dataProduct.appSpec),
    recipes: structuredClone(demoFixtureResult.data.dataProduct.recipes),
  };
}

function capture(viewport: { width: number; height: number }): CapturedScreenshot {
  const bytes = Buffer.from(`mock-jpeg-${viewport.width}x${viewport.height}`);
  return {
    bytes,
    evidence: {
      viewport,
      capturePosition: "initial",
      layout: {
        documentClientWidth: viewport.width,
        documentScrollWidth: viewport.width,
        canvasClientWidth: viewport.width,
        canvasScrollWidth: viewport.width,
        canvasScrollLeft: 0,
        canvasViewportLeft: 0,
        canvasViewportRight: viewport.width,
        assistantOverlapsCanvas: false,
      },
      pageUrl: "http://127.0.0.1:3102/",
      mimeType: "image/jpeg",
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

describe("Playwright + 多模态视觉 Verifier", () => {
  it("通过本机截图服务隔离 Vinext Worker 与 Playwright 浏览器驱动", async () => {
    const captured = capture({ width: 900, height: 1000 });
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === "http://127.0.0.1:3198/capture") {
        return new Response(JSON.stringify({
          captures: [{
            imageBase64: captured.bytes.toString("base64"),
            evidence: captured.evidence,
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: `页面观察如下：\n${JSON.stringify({
          summary: "截图服务证据已进入 Planner 前置感知。",
          findings: ["900px 页面截图可读取。"],
          uncertainties: [],
        })}\n结束` } }],
        usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
      }), { status: 200 });
    });
    const verifier = new PlaywrightMultimodalVisualVerifier({
      baseUrl: "http://127.0.0.1:3102/",
      apiUrl: "https://vision.example.test/v1/chat/completions",
      apiKey: "test-key",
      model: "vision-test",
      fetchImpl,
      captureServiceUrl: "http://127.0.0.1:3198/capture",
      viewports: [{ width: 900, height: 1000 }],
    });

    const perception = await verifier.perceive({ request: request(), signal: new AbortController().signal });

    expect(perception.summary).toBe("截图服务证据已进入 Planner 前置感知。");
    expect(perception.captures).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("在 Planner 前把截图、DOM、控制台和交互证据交给多模态观察器", async () => {
    const captured = capture({ width: 900, height: 1000 });
    captured.browserObservation = {
      viewport: { width: 900, height: 1000 },
      pageTitle: "DataCanvas AI",
      pageUrl: "http://127.0.0.1:3102/",
      dom: {
        visibleText: "EDS 报告 AI 助手",
        landmarkCount: 2,
        landmarks: [
          { tag: "main", label: "EDS 报告", left: 0, top: 0, width: 600, height: 800 },
          { tag: "aside", label: "AI 助手", left: 600, top: 0, width: 300, height: 800 },
        ],
      },
      console: { errors: [], warnings: ["测试警告"], failedRequests: [] },
      interactions: {
        checked: 2,
        reachable: 2,
        disabled: 0,
        occluded: 0,
        samples: [{ label: "发送", tag: "button", status: "reachable" }],
      },
    };
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }> };
      const user = body.messages.find((message) => message.role === "user");
      const items = user?.content as Array<{ type: string; text?: string }>;
      expect(items.filter((item) => item.type === "image_url")).toHaveLength(1);
      const metadata = JSON.parse(items.find((item) => item.type === "text")?.text ?? "{}") as Record<string, unknown>;
      expect(metadata).toMatchObject({
        userGoal: expect.stringContaining("窄屏"),
        browserObservations: [expect.objectContaining({
          console: expect.objectContaining({ warnings: ["测试警告"] }),
          interactions: expect.objectContaining({ reachable: 2, occluded: 0 }),
        })],
      });
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          summary: "页面结构可见，控件命中检测正常。",
          findings: ["900px 下两个控件均可达。"],
          uncertainties: [],
        }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      }), { status: 200 });
    });
    const verifier = new PlaywrightMultimodalVisualVerifier({
      baseUrl: "http://127.0.0.1:3102/",
      apiUrl: "https://vision.example.test/v1/chat/completions",
      apiKey: "test-key",
      model: "vision-test",
      fetchImpl,
      viewports: [{ width: 900, height: 1000 }],
      capture: async () => [captured],
    });

    const perception = await verifier.perceive({ request: request(), signal: new AbortController().signal });

    expect(perception).toMatchObject({
      summary: "页面结构可见，控件命中检测正常。",
      findings: ["900px 下两个控件均可达。"],
      captures: [captured],
      browserObservations: [expect.objectContaining({ pageTitle: "DataCanvas AI" })],
      usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
    });
  });

  it("把用户上传图片交给视觉模型并只返回结构化文字证据", async () => {
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }> };
      const user = body.messages.find((message) => message.role === "user");
      expect((user?.content as Array<{ type: string }>).filter((item) => item.type === "image_url")).toHaveLength(1);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          summary: "图片显示数据健康度卡片被右侧面板遮挡。",
          visibleText: ["数据健康度"],
          findings: ["环形图右侧不可见。"],
          uncertainties: [],
        }) } }],
        usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
      }), { status: 200 });
    });
    const verifier = new PlaywrightMultimodalVisualVerifier({
      baseUrl: "http://127.0.0.1:3102/",
      apiUrl: "https://vision.example.test/v1/chat/completions",
      apiKey: "test-key",
      model: "vision-test",
      fetchImpl,
    });

    const evidence = await verifier.inspectUploadedImages({
      instruction: "这张图有什么布局问题？",
      images: [{
        bytes: imageBytes,
        manifest: {
          id: "uploaded_image_1",
          fileName: "页面截图.jpg",
          mimeType: "image/jpeg",
          byteLength: imageBytes.byteLength,
          sha256: createHash("sha256").update(imageBytes).digest("hex"),
        },
      }],
      signal: new AbortController().signal,
    });

    expect(evidence).toMatchObject({
      source: "uploaded-image-multimodal",
      summary: "图片显示数据健康度卡片被右侧面板遮挡。",
      model: "vision-test",
      usage: { promptTokens: 80, completionTokens: 40, totalTokens: 120 },
    });
    expect(JSON.stringify(evidence)).not.toContain("data:image");
  });

  it("把多个视口的真实截图作为 image input 并返回结构化证据", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        max_tokens: number;
        thinking: { type: string };
        messages: Array<{ role: string; content: unknown }>;
      };
      expect(body.max_tokens).toBe(2_400);
      expect(body.thinking).toEqual({ type: "disabled" });
      const system = body.messages.find((message) => message.role === "system");
      expect(system?.content).toContain("在画布内横向滚动，这是受支持的导航设计");
      const user = body.messages.find((message) => message.role === "user");
      expect(Array.isArray(user?.content)).toBe(true);
      expect((user?.content as Array<{ type: string }>).filter((item) => item.type === "image_url")).toHaveLength(2);
      const metadata = (user?.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
      expect(JSON.parse(metadata ?? "{}")).toMatchObject({
        verificationMode: "inspection",
        layoutFacts: {
          measurementCoverage: true,
          globalHorizontalOverflow: false,
          localCanvasHorizontalScroll: false,
          localCanvasRightEdgeCaptured: true,
          assistantOverlapsCanvas: false,
        },
        responsivePolicy: {
          acceptedLocalCanvasScroll: true,
        },
      });
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          verdict: "passed",
          summary: "候选答案与两个视口的检查证据一致。",
          checks: [
            { id: "goal_match", label: "目标覆盖", status: "passed", detail: "候选答案回答了布局检查目标。" },
            { id: "layout_integrity", label: "布局判断", status: "passed", detail: "候选答案与截图中的布局一致。" },
            { id: "legibility", label: "可读性判断", status: "passed", detail: "候选答案与文字可读性证据一致。" },
            { id: "chart_integrity", label: "图表判断", status: "passed", detail: "候选答案与图表完整性证据一致。" },
            { id: "responsive_layout", label: "响应式判断", status: "passed", detail: "候选答案正确识别局部滚动且整页无横向溢出。" },
          ],
          issues: [],
        }) } }],
        usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const verifier = new PlaywrightMultimodalVisualVerifier({
      baseUrl: "http://127.0.0.1:3102/",
      apiUrl: "https://vision.example.test/v1/chat/completions",
      apiKey: "test-key",
      model: "vision-test",
      fetchImpl,
      capture: async ({ viewports }) => viewports.map(capture),
    });

    const evidence = await verifier.verify({
      request: request(),
      outcome: "completed",
      verificationMode: "inspection",
      candidateMessage: "桌面和窄屏均未发现重叠；窄屏通过局部横向滚动访问完整看板，整页没有横向溢出。",
      signal: new AbortController().signal,
    });

    expect(evidence).toMatchObject({
      required: true,
      status: "passed",
      source: "playwright-multimodal",
      model: "vision-test",
      usage: { promptTokens: 120, completionTokens: 80, totalTokens: 200 },
    });
    expect(evidence.screenshots).toHaveLength(2);
    expect(evidence.screenshots.every((item) => /^[a-f0-9]{64}$/u.test(item.sha256))).toBe(true);
  });

  it("验收模式下模型报告任一视觉问题时拒绝通过", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        verdict: "failed",
        summary: "窄屏下图表越界。",
        checks: [
          { id: "goal_match", label: "目标可见", status: "passed", detail: "看板已显示。" },
          { id: "layout_integrity", label: "布局完整", status: "failed", detail: "右侧图表超出容器。" },
          { id: "legibility", label: "文字可读", status: "failed", detail: "坐标轴标签相互重叠。" },
          { id: "chart_integrity", label: "图表完整", status: "failed", detail: "图表右侧不可见。" },
          { id: "responsive_layout", label: "响应式", status: "failed", detail: "窄屏没有可用的局部滚动。" },
        ],
        issues: ["900px 视口下图表超出右边界。"],
      }) } }],
    }), { status: 200 }));
    const verifier = new PlaywrightMultimodalVisualVerifier({
      baseUrl: "http://localhost:3102/",
      apiUrl: "https://vision.example.test/v1/chat/completions",
      apiKey: "test-key",
      model: "vision-test",
      fetchImpl,
      viewports: [{ width: 900, height: 1000 }],
      capture: async ({ viewports }) => viewports.map(capture),
    });

    const evidence = await verifier.verify({
      request: request(),
      outcome: "completed",
      verificationMode: "acceptance",
      candidateMessage: "代码测试通过。",
      signal: new AbortController().signal,
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.issues).toContain("900px 视口下图表超出右边界。");
  });

  it("检查模式下页面存在缺陷但候选答案准确报告时任务通过", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        verdict: "passed",
        summary: "候选答案准确报告了窄屏标签重叠问题。",
        checks: [
          { id: "goal_match", label: "目标覆盖", status: "passed", detail: "答案明确给出页面缺陷。" },
          { id: "layout_integrity", label: "布局判断", status: "passed", detail: "答案正确指出组件没有越界。" },
          { id: "legibility", label: "可读性判断", status: "passed", detail: "答案正确指出坐标轴标签重叠。" },
          { id: "chart_integrity", label: "图表判断", status: "passed", detail: "图表主体完整。" },
          { id: "responsive_layout", label: "响应式判断", status: "passed", detail: "答案正确区分局部滚动和整页溢出。" },
        ],
        issues: [],
      }) } }],
    }), { status: 200 }));
    const verifier = new PlaywrightMultimodalVisualVerifier({
      baseUrl: "http://localhost:3102/",
      apiUrl: "https://vision.example.test/v1/chat/completions",
      apiKey: "test-key",
      model: "vision-test",
      fetchImpl,
      viewports: [{ width: 900, height: 1000 }],
      capture: async ({ viewports }) => viewports.map(capture),
    });

    const evidence = await verifier.verify({
      request: request(),
      outcome: "completed",
      verificationMode: "inspection",
      candidateMessage: "窄屏下坐标轴标签发生重叠；看板使用局部横向滚动，整页没有横向溢出。",
      signal: new AbortController().signal,
    });

    expect(evidence.status).toBe("passed");
    expect(evidence.summary).toContain("准确报告");
    expect(evidence.issues).toEqual([]);
  });

  it("浏览器滚动条宽度导致 scrollLeft 小于理论差值时仍确认已截取最右端", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }> };
      const user = body.messages.find((message) => message.role === "user");
      const metadata = (user?.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
      expect(JSON.parse(metadata ?? "{}")).toMatchObject({
        layoutFacts: {
          measurementCoverage: true,
          globalHorizontalOverflow: false,
          localCanvasHorizontalScroll: true,
          localCanvasRightEdgeCaptured: true,
          assistantOverlapsCanvas: false,
        },
      });
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          verdict: "passed",
          summary: "左右两端截图证明局部横向滚动内容完整可达。",
          checks: [
            { id: "goal_match", label: "目标覆盖", status: "passed", detail: "答案覆盖检查目标。" },
            { id: "layout_integrity", label: "布局判断", status: "passed", detail: "无整页溢出。" },
            { id: "legibility", label: "可读性判断", status: "passed", detail: "文字可读。" },
            { id: "chart_integrity", label: "图表判断", status: "passed", detail: "图表可通过局部滚动完整查看。" },
            { id: "responsive_layout", label: "响应式判断", status: "passed", detail: "局部横向滚动正常。" },
          ],
          issues: [],
        }) } }],
      }), { status: 200 });
    });
    const initial = capture({ width: 900, height: 1000 });
    initial.evidence.layout = {
      ...initial.evidence.layout!,
      canvasClientWidth: 885,
      canvasScrollWidth: 1104,
    };
    const horizontalEnd = capture({ width: 900, height: 1000 });
    horizontalEnd.evidence.capturePosition = "horizontalEnd";
    horizontalEnd.evidence.layout = {
      ...horizontalEnd.evidence.layout!,
      canvasClientWidth: 885,
      canvasScrollWidth: 1104,
      canvasScrollLeft: 204,
    };
    const verifier = new PlaywrightMultimodalVisualVerifier({
      baseUrl: "http://localhost:3102/",
      apiUrl: "https://vision.example.test/v1/chat/completions",
      apiKey: "test-key",
      model: "vision-test",
      fetchImpl,
      viewports: [{ width: 900, height: 1000 }],
      capture: async () => [initial, horizontalEnd],
    });

    const evidence = await verifier.verify({
      request: request(),
      outcome: "completed",
      verificationMode: "inspection",
      candidateMessage: "窄屏通过局部横向滚动访问完整看板，整页没有横向溢出。",
      signal: new AbortController().signal,
    });

    expect(evidence.status).toBe("passed");
    expect(evidence.screenshots).toHaveLength(2);
  });

  it("拒绝让 Playwright 访问非本机页面", () => {
    expect(() => new PlaywrightMultimodalVisualVerifier({
      baseUrl: "https://example.com/",
      apiUrl: "https://vision.example.test/v1/chat/completions",
      apiKey: "test-key",
      model: "vision-test",
    })).toThrow("只允许访问本机 loopback 页面");
  });
});
