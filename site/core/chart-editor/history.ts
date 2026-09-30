import type { ChartConfig } from "./config";

export interface ChartHistory { past: ChartConfig[]; present: ChartConfig; future: ChartConfig[] }
export type ChartHistoryAction = { type: "edit"; config: ChartConfig } | { type: "undo" | "redo" };
export const chartHistoryLimit = 50;
export function createChartHistory(config: ChartConfig): ChartHistory { return { past: [], present: config, future: [] }; }

/** Only chart configuration is recorded; never duplicate source rows in undo history. */
export function chartHistoryReducer(state: ChartHistory, action: ChartHistoryAction): ChartHistory {
  if (action.type === "edit") {
    if (JSON.stringify(action.config) === JSON.stringify(state.present)) return state;
    return { past: [...state.past, state.present].slice(-chartHistoryLimit), present: action.config, future: [] };
  }
  if (action.type === "undo") {
    const previous = state.past.at(-1);
    return previous ? { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future] } : state;
  }
  const next = state.future[0];
  return next ? { past: [...state.past, state.present].slice(-chartHistoryLimit), present: next, future: state.future.slice(1) } : state;
}
