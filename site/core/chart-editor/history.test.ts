import { describe, expect, it } from "vitest";
import { initialConfig } from "./config";
import { chartHistoryLimit, chartHistoryReducer, createChartHistory } from "./history";
import { salesSample } from "./sample";

describe("chart configuration history", () => {
  it("keeps the initial state immutable and supports undo / redo", () => {
    const initial = createChartHistory(initialConfig(salesSample));
    const edited = chartHistoryReducer(initial, { type: "edit", config: { ...initial.present, title: "新标题" } });
    expect(initial.past).toEqual([]);
    const undone = chartHistoryReducer(edited, { type: "undo" });
    expect(undone.present).toBe(initial.present);
    expect(chartHistoryReducer(undone, { type: "redo" }).present).toBe(edited.present);
  });
  it("does not add no-op history or duplicate source rows", () => {
    const state = createChartHistory(initialConfig(salesSample));
    expect(chartHistoryReducer(state, { type: "edit", config: structuredClone(state.present) })).toBe(state);
    expect(chartHistoryReducer(state, { type: "undo" })).toBe(state);
    expect(chartHistoryReducer(state, { type: "redo" })).toBe(state);
    expect(JSON.stringify(state)).not.toContain('"rows"');
  });
  it("clears redo on a new branch and retains only 50 configuration snapshots", () => {
    let state = createChartHistory(initialConfig(salesSample));
    for (let i = 0; i < 60; i++) state = chartHistoryReducer(state, { type: "edit", config: { ...state.present, title: `${i}` } });
    expect(state.past).toHaveLength(chartHistoryLimit);
    state = chartHistoryReducer(state, { type: "undo" });
    expect(state.future).toHaveLength(1);
    state = chartHistoryReducer(state, { type: "edit", config: { ...state.present, mark: "bar" } });
    expect(state.future).toEqual([]);
  });
  it("restores field / filter / style edits together without affecting saved snapshots", () => {
    const saved = initialConfig(salesSample);
    const edited = { ...saved, channels: { ...saved.channels, y: null }, filters: [{ field: "amount", kind: "range" as const, min: 1, max: 9 }], style: { ...saved.style, fontSize: 18 } };
    const state = chartHistoryReducer(createChartHistory(saved), { type: "edit", config: edited });
    expect(chartHistoryReducer(state, { type: "undo" }).present).toEqual(saved);
    expect(saved.channels.y).not.toBeNull();
  });
});
