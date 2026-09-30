"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ChartEditorBoundary } from "./ChartEditorBoundary";
import { useChartExitGuard } from "./useChartExitGuard";

export function ChartEditorPage() {
  const router = useRouter();
  const exit = useChartExitGuard(() => router.push("/"));
  return <main style={{ height: "100dvh", display: "flex", flexDirection: "column", background: "#faf9f8", padding: 16, gap: 12 }}>
    <nav style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}><Button size="small" variant="ghost" onClick={exit.requestClose}>← 返回工作台</Button><span>单图分析 · 模拟销售样例 · 不调用 AI 或数据库</span></nav>
    <div style={{ flex: 1, minHeight: 0 }}><ChartEditorBoundary onDirtyChange={exit.onDirtyChange} /></div>
    {exit.confirmation}
  </main>;
}
