// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerContextMenu } from "./ComposerContextMenu";

const roots: Root[] = [];
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  while (roots.length) act(() => roots.pop()!.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(placement?: "above" | "below", box = new DOMRect(700, 60, 44, 32), viewport = { width: 1024, height: 768 }) {
  vi.stubGlobal("innerWidth", viewport.width);
  vi.stubGlobal("innerHeight", viewport.height);
  const anchor = document.createElement("button");
  anchor.textContent = "数据";
  vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(() => box);
  const container = document.createElement("div");
  document.body.appendChild(anchor);
  document.body.appendChild(container);
  const callbacks = { onClose: vi.fn(), onChooseFiles: vi.fn(), onImportData: vi.fn(), onSelectWorkspace: vi.fn(), onSelectDataSource: vi.fn(), onSelectResult: vi.fn() };
  const props: ComponentProps<typeof ComposerContextMenu> = { anchor, placement, workspaces: [{ id: "page", name: "测试界面" }], activeWorkspaceId: "page",
    dataSources: [{ id: "source", name: "合成数据" }], activeDataSourceId: "source", results: [], ...callbacks };
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<ComposerContextMenu {...props} />));
  const menu = document.querySelector<HTMLElement>(".composer-context-menu")!;
  const data = menu.querySelector<HTMLButtonElement>('[data-section="data"]')!;
  const openData = () => {
    act(() => data.click());
    return document.querySelector<HTMLElement>(".composer-context-submenu")!;
  };
  return { ...callbacks, menu, data, anchor, openData };
}

function withinViewport(menu: HTMLElement, width: number, height: number) {
  expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(12);
  expect(parseFloat(menu.style.left) + parseFloat(menu.style.width)).toBeLessThanOrEqual(width - 12);
  const verticalInset = parseFloat(menu.style.top || menu.style.bottom);
  expect(verticalInset).toBeGreaterThanOrEqual(12);
  expect(parseFloat(menu.style.maxHeight)).toBeGreaterThan(0);
  expect(verticalInset + parseFloat(menu.style.maxHeight)).toBeLessThanOrEqual(height - 12);
}

describe("ComposerContextMenu placement", () => {
  it("keeps default composer menus and submenus bottom-aligned above the trigger", () => {
    const { menu, openData } = mount(undefined, new DOMRect(700, 650, 44, 32));
    expect(menu.style.bottom).toBe("134px");
    expect(menu.style.top).toBe("");
    const submenu = openData();
    expect(submenu.style.bottom).toBe(menu.style.bottom);
    expect(submenu.style.top).toBe("");
    expect(submenu.style.maxHeight).toBe("340px");
    withinViewport(menu, 1024, 768);
    withinViewport(submenu, 1024, 768);
  });

  it("opens header menus below the button with the submenu sharing the same top edge", () => {
    const { menu, openData } = mount("below");
    expect(menu.style.top).toBe("100px");
    expect(menu.style.bottom).toBe("");
    const submenu = openData();
    expect(submenu.style.top).toBe(menu.style.top);
    expect(submenu.style.bottom).toBe("");
    withinViewport(menu, 1024, 768);
    withinViewport(submenu, 1024, 768);
  });

  it("keeps both menus scrollable and inside a narrow, short viewport", () => {
    const { menu, openData } = mount("below", new DOMRect(290, 200, 24, 32), { width: 320, height: 260 });
    const submenu = openData();
    expect(menu.style.overflowY).toBe("auto");
    expect(submenu.style.overflowY).toBe("auto");
    expect(submenu.style.top).toBe(menu.style.top);
    withinViewport(menu, 320, 260);
    withinViewport(submenu, 320, 260);
  });

  it("repositions the open menu and submenu together when the viewport changes", () => {
    const { menu, openData } = mount("below");
    const submenu = openData();
    vi.stubGlobal("innerWidth", 400);
    vi.stubGlobal("innerHeight", 300);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(menu.style.top).toBe("70px");
    expect(submenu.style.top).toBe(menu.style.top);
    withinViewport(menu, 400, 300);
    withinViewport(submenu, 400, 300);
  });

  it("retains keyboard submenu navigation and Escape focus restoration below the header", () => {
    const { data, onClose } = mount("below");
    act(() => {
      data.focus();
      data.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    const search = document.querySelector<HTMLInputElement>(".composer-context-submenu input")!;
    expect(document.activeElement).toBe(search);
    act(() => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector(".composer-context-submenu")).toBeNull();
    expect(document.activeElement).toBe(data);
    expect(onClose).not.toHaveBeenCalled();
    act(() => data.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("selects the actual data source and closes without changing the action contract", () => {
    const { openData, onSelectDataSource, onClose } = mount("below");
    const submenu = openData();
    act(() => submenu.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!.click());
    expect(onSelectDataSource).toHaveBeenCalledExactlyOnceWith("source");
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
  });
});
