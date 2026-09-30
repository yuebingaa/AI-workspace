"use client";

import { Component, lazy, Suspense, useSyncExternalStore, type ReactNode } from "react";
import type { ChartDataset } from "@/core/chart-editor/config";
import { salesSample } from "@/core/chart-editor/sample";
import type { ChartEditorProps } from "./ChartEditor";
import type { ChartConfig } from "@/core/chart-editor/config";
import type { MaterializedChartCanvas } from "./MaterializedChartCanvas";
import type { ComponentProps } from "react";
import type { NativeChartEditorProps } from "./NativeChartEditor";
import "./chart-editor.css";
const Editor = lazy(() => import("./ChartEditor"));
const NativeEditor = lazy(() => import("./NativeChartEditor"));
const Canvas = lazy(() => import("./ChartCanvas").then(module => ({ default: module.ChartCanvas })));
const MaterializedCanvas = lazy(() => import("./MaterializedChartCanvas").then(module => ({ default: module.MaterializedChartCanvas })));
const subscribe = () => () => {};
class LoadingGuard extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() { return this.state.error ? <p role="alert">图表编辑器加载失败。请刷新后重试；已保存的配置不会被覆盖。</p> : this.props.children; }
}
/** GW's browser bundle must not execute in RSC/SSR (styled-components and browser computation workers). */
export function ChartEditorBoundary({ dataset = salesSample, ...props }: Omit<ChartEditorProps, "dataset"> & { dataset?: ChartDataset }) {
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  return <LoadingGuard><Suspense fallback={<p role="status">正在加载 Graphic Walker 图表编辑器…</p>}>
    {mounted ? <Editor key={dataset.id} dataset={dataset} {...props} /> : <p role="status">正在准备图表编辑器…</p>}
  </Suspense></LoadingGuard>;
}
export function ChartCanvasBoundary({ dataset, config }: { dataset: ChartDataset; config: ChartConfig }) {
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  return <LoadingGuard><Suspense fallback={<p role="status">正在加载图表…</p>}>
    {mounted ? <Canvas dataset={dataset} config={config} /> : <p role="status">正在准备图表…</p>}
  </Suspense></LoadingGuard>;
}
export function NativeChartEditorBoundary(props: NativeChartEditorProps) {
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  return <LoadingGuard><Suspense fallback={<p role="status">正在加载 Graphic Walker 官方编辑器…</p>}>
    {mounted ? <NativeEditor key={props.dataset.id} {...props} /> : <p role="status">正在准备图表编辑器…</p>}
  </Suspense></LoadingGuard>;
}
export function MaterializedChartCanvasBoundary(props: ComponentProps<typeof MaterializedChartCanvas>) {
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  return <LoadingGuard><Suspense fallback={<p role="status">正在加载完整结果图表…</p>}>
    {mounted ? <MaterializedCanvas {...props} /> : <p role="status">正在准备图表…</p>}
  </Suspense></LoadingGuard>;
}
