// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { StudioTheme } from "@/components/ui/studio-theme";
import { initialConfig, type ChartConfig } from "@/core/chart-editor/config";
import { salesSample } from "@/core/chart-editor/sample";
import ChartEditor from "./ChartEditor";

vi.mock("./ChartCanvas", () => ({ ChartCanvas: ({ config, unavailableReason }: { config: ChartConfig; unavailableReason?: string }) =>
  <output data-waiting={Boolean(unavailableReason)}>{config.channels.x?.field}</output> }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

it("fresh upstream retires the old save error without discarding edited fields", () => {
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
  const empty = { ...salesSample, rows: [], truncated: true }, config = initialConfig(salesSample), changed = vi.fn();
  try {
    act(() => root.render(<StudioTheme><ChartEditor dataset={empty} dataUnavailable="等待上游" onDirtyChange={changed}
      owner={{ config, onSave() { throw Error("请先运行上游"); } }} /></StudioTheme>));
    expect(host.querySelector("output")?.dataset.waiting).toBe("true");
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="添加字段 客户类型"]')!.click());
    expect(host.querySelector("output")?.textContent).toBe("customer");
    act(() => [...host.querySelectorAll("button")].find(item => item.textContent === "保存单元")!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("请先运行上游");
    act(() => root.render(<StudioTheme><ChartEditor dataset={salesSample} onDirtyChange={changed} owner={{ config, onSave() {} }} /></StudioTheme>));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector("output")?.textContent).toBe("customer");
    expect(host.querySelector("output")?.dataset.waiting).toBe("false");
    expect(changed).toHaveBeenLastCalledWith(true);
  } finally { act(() => root.unmount()); host.remove(); }
});
