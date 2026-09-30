// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StudioTheme } from "@/components/ui/studio-theme";
import type { NotebookCell } from "@/core/notebook/definition";
import { NotebookChartWorkspace } from "./NotebookChartWorkspace";

// Test the host lifecycle, not the third-party drawing engine (browser verified).
vi.mock("./NotebookChartEditor", () => ({ NotebookChartEditor: ({ cell, layout, disabled, onDirtyChange, onCancel, onSave }: {
  cell: NotebookCell; layout: string; disabled: boolean; onDirtyChange(value: boolean): void; onCancel(): void; onSave(cell: NotebookCell): void;
}) => {
  useEffect(() => onDirtyChange(false), [onDirtyChange]);
  return <div data-editor-layout={layout}><span>{cell.title}</span>
    <button disabled={disabled} onClick={() => onDirtyChange(true)}>change</button>
    <button disabled={disabled} onClick={() => onSave({ ...cell, title: "已保存图" })}>save</button>
    <button onClick={onCancel}>discard</button></div>;
} }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const host = document.createElement("div"); document.body.appendChild(host);
let root = createRoot(host);
const cell: Extract<NotebookCell, { kind: "chart" }> = { id: "chart", kind: "chart", title: "模拟图", inputCellId: "data", chartType: "bar", categoryField: "x", valueFields: ["y"] };
const changed = vi.fn(), saved = vi.fn();
function render(current = cell, disabled = false) {
  act(() => root.render(<StudioTheme><NotebookChartWorkspace cell={current} availableInputs={[]} inputCatalog={{}} disabled={disabled} onDirtyChange={changed} onSave={saved} /></StudioTheme>));
}
function button(text: string) { return [...host.querySelectorAll("button")].find(item => item.textContent === text)!; }
afterEach(() => { act(() => root.unmount()); root = createRoot(host); changed.mockClear(); saved.mockClear(); });

it("opens Data/Style immediately, keeps editor after save and refreshes the saved baseline", () => {
  render(); expect(host.querySelector('[data-editor-layout="data-style"]')).not.toBeNull();
  act(() => button("change").click()); expect(changed).toHaveBeenLastCalledWith("chart", true);
  expect(button("官方原生布局").disabled).toBe(true);
  act(() => button("save").click()); expect(saved.mock.calls[0][0].title).toBe("已保存图");
  render(saved.mock.calls[0][0]);
  expect(host.querySelector('[data-editor-layout="data-style"]')?.textContent).toContain("已保存图");
  expect(changed).toHaveBeenLastCalledWith("chart", false);
  expect(button("官方原生布局").disabled).toBe(false);
});
it("discard restores the always-open editor without saving or switching layout", () => {
  render(); act(() => button("change").click()); act(() => button("discard").click());
  expect(changed).toHaveBeenLastCalledWith("chart", false); expect(saved).not.toHaveBeenCalled();
  expect(host.querySelector('[data-editor-layout="data-style"]')).not.toBeNull();
  act(() => button("官方原生布局").click()); expect(host.querySelector('[data-editor-layout="native"]')).not.toBeNull();
});
it("shows the complete editor but retains read-only / execution locks", () => {
  render(cell, true); expect(button("change").disabled).toBe(true);
  expect(button("官方原生布局").disabled).toBe(true);
  expect(host.querySelector('[data-editor-layout="data-style"]')).not.toBeNull();
  expect(saved).not.toHaveBeenCalled();
});
