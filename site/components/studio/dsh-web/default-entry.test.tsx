import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Home from "@/app/page";
import DshConversationPage from "@/app/dsh/page";
import DshOfficialWebPage from "@/app/dsh/web/page";
import { StudioWorkspace } from "../StudioWorkspace";

const navigation = vi.hoisted(() => ({ redirect: vi.fn(), permanentRedirect: vi.fn() }));
vi.mock("next/navigation", () => navigation);
vi.mock("@/components/studio/StudioWorkspace", () => ({
  StudioWorkspace: () => <main data-workspace="shared-dsh-workspace" />,
}));

beforeEach(() => vi.clearAllMocks());

describe("default official DSH entry", () => {
  it.each([
    ["/", Home], ["/dsh", DshConversationPage], ["/dsh/web", DshOfficialWebPage],
  ] as const)("%s renders the shared workspace directly, without redirecting or selecting another experience", (_path, Page) => {
    const element = Page();
    expect(element.type).toBe(StudioWorkspace);
    expect(element.props).toEqual({});
    expect(renderToStaticMarkup(element)).toBe('<main data-workspace="shared-dsh-workspace"></main>');
    expect(navigation.redirect).not.toHaveBeenCalled();
    expect(navigation.permanentRedirect).not.toHaveBeenCalled();
  });

  it("the actual workspace entry fixes DSH conversation without an overridable default", () => {
    const source = readFileSync(new URL("../StudioWorkspace.tsx", import.meta.url), "utf8");
    // Deliberately inspect only the composition entry: exercising its full
    // project, storage and iframe lifecycle belongs to the browser acceptance.
    const entry = source.match(/export function StudioWorkspace\(\)\s*\{([\s\S]*?)\n\}/u)?.[1];
    expect(entry).toBeDefined();
    expect(entry).toMatch(/<LocalProjectsProvider>\s*<StudioProjectWorkspace\s+assistantExperience="dsh-conversation"\s*\/>\s*<\/LocalProjectsProvider>/u);
    expect(source).toMatch(/<AgentEngineSettings\s+hideTrigger\b/u);
    const settings = readFileSync(new URL("../AgentEngineSettings.tsx", import.meta.url), "utf8");
    expect(settings).toContain("当前对话固定使用 DSH");
    expect(settings).not.toMatch(/conversationOnly|onEngineChange|onApply/u);
    expect(settings).toContain('fetch(pluginEndpoint, { method: "PATCH"');
    expect(settings).not.toMatch(/fetch\(engineEndpoint,\s*\{\s*method:/u);
  });

  it("the workspace and navigation no longer offer the classic or transitional entry switch", () => {
    const workspace = readFileSync(new URL("../StudioWorkspace.tsx", import.meta.url), "utf8");
    const menu = readFileSync(new URL("../WorkspaceNavigation.tsx", import.meta.url), "utf8");
    expect(workspace).not.toMatch(/navigateAssistantEntry|返回过渡入口|试用官方对话界面/u);
    expect(menu).not.toMatch(/dshConversation|DSH 对话 · 预览版/u);
  });

  it("loads DSH styles once from the global layout, not independently from route aliases", () => {
    const root = new URL("../../../", import.meta.url);
    const layout = readFileSync(new URL("app/layout.tsx", root), "utf8");
    const globals = readFileSync(new URL("app/globals.css", root), "utf8");
    expect(layout.match(/import\s+["']\.\/globals\.css["']/gu)).toHaveLength(1);
    expect(globals.match(/@import\s+["']\.\/dsh\/dsh\.css["']\s+layer\(studio-legacy\)/gu)).toHaveLength(1);
    for (const path of ["app/page.tsx", "app/dsh/page.tsx", "app/dsh/web/page.tsx"]) {
      expect(readFileSync(new URL(path, root), "utf8")).not.toMatch(/import\s+["'][^"']*\.css["']/u);
    }
  });
});
