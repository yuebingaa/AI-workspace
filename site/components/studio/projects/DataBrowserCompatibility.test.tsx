// @vitest-environment happy-dom
import { renderDialogMarkup as renderToStaticMarkup } from "@/test-support/render-dialog";
import { describe, expect, it, vi } from "vitest";
import { projectCompatibilityMessage, type ProjectCompatibility } from "@/core/projects/compatibility";
import { DataBrowser } from "./DataBrowser";

const { useProjects } = vi.hoisted(() => ({ useProjects: vi.fn() }));
vi.mock("./LocalProjectsProvider", () => ({ useLocalProjects: useProjects }));
// This test covers the current compatibility state; async project refresh is covered in browser checks.
vi.mock("@/core/projects/client", async importOriginal => ({
  ...await importOriginal<typeof import("@/core/projects/client")>(),
  loadProject: vi.fn(() => new Promise(() => {})),
  projectRequest: vi.fn(() => new Promise(() => {})),
}));

function render(compatibility?: ProjectCompatibility) {
  useProjects.mockReturnValue({
    session: { path: "C:\\synthetic\\project", manifest: { name: "合成项目", tables: [], files: [], state: null } },
    repository: null,
    status: { state: "error", message: compatibility ? projectCompatibilityMessage(compatibility) : "普通保存错误", ...(compatibility ? { compatibility } : {}) },
  });
  return renderToStaticMarkup(<DataBrowser onClose={vi.fn()} onImport={vi.fn()} onUse={vi.fn()}
    onRemoved={vi.fn()} onModel={vi.fn()} models={[]} notebooks={{}} canEdit />);
}

describe("Data Browser compatibility layout content", () => {
  it("keeps the status badge short while retaining full diagnostics and recovery actions", () => {
    const html = render({ code: "project_incompatible", reason: "notebook-cells", total: 900, omitted: 895,
      cells: Array.from({ length: 5 }, (_, index) => ({ notebookIndex: 1, cellIndex: index + 1, kind: "futureMatrix" })),
    });
    const badge = html.match(/<span class="project-save-status error">([^<]*)<\/span>/u)?.[1];
    expect(badge).toBe("版本不兼容 · 自动保存已暂停");
    expect(html).toContain("项目兼容性检查"); expect(html).toContain("另有 895 个");
    expect(html).toContain("重试保存"); expect(html).toContain("放弃未保存修改并重新打开");
    expect(html).toContain("合成项目"); expect(html).toContain("C:\\synthetic\\project");
  });

  it("keeps ordinary error text and retry behavior when no validated compatibility metadata exists", () => {
    const html = render();
    expect(html).toContain('<span class="project-save-status error">普通保存错误</span>');
    expect(html).not.toContain("项目兼容性检查"); expect(html).toContain("重试保存");
  });
});
