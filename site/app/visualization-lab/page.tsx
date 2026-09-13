import type { Metadata } from "next";
import { VisualizationLab } from "@/components/visualization-lab/VisualizationLab";

export const metadata: Metadata = { title: "可视化测试 · DataCanvas AI" };
export default function VisualizationLabPage() { return <VisualizationLab />; }
