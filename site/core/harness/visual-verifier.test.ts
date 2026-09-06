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
      pageUrl: "http://127.0.0.1:3102/",
      mimeType: "image/jpeg",
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

describe("Playwright + 多模态视觉 Verifier", () => {
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
        messages: Array<{ role: string; content: unknown }>;
      };
      expect(body.max_tokens).toBe(2_400);
      const user = body.messages.find((message) => message.role === "user");
      expect(Array.isArray(user?.content)).toBe(true);
      expect((user?.content as Array<{ type: string }>).filter((item) => item.type === "image_url")).toHaveLength(2);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          verdict: "passed",
          summary: "两个视口均无重叠，图表和文字清晰可读。",
          checks: [
            { id: "goal_match", label: "目标可见", status: "passed", detail: "目标看板已显示。" },
            { id: "layout_integrity", label: "布局完整", status: "passed", detail: "未发现越界、遮挡或裁切。" },
            { id: "legibility", label: "文字可读", status: "passed", detail: "标题、图例和坐标轴可读。" },
            { id: "responsive_layout", label: "响应式", status: "passed", detail: "窄屏使用局部滚动且整页无横向溢出。" },
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
      candidateMessage: "布局检查完成。",
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

  it("模型报告任一视觉问题时拒绝通过", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        verdict: "failed",
        summary: "窄屏下图表越界。",
        checks: [
          { id: "goal_match", label: "目标可见", status: "passed", detail: "看板已显示。" },
          { id: "layout_integrity", label: "布局完整", status: "failed", detail: "右侧图表超出容器。" },
          { id: "legibility", label: "文字可读", status: "failed", detail: "坐标轴标签相互重叠。" },
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
      candidateMessage: "代码测试通过。",
      signal: new AbortController().signal,
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.issues).toContain("900px 视口下图表超出右边界。");
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
