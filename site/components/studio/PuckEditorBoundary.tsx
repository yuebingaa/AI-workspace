"use client";

import dynamic from "next/dynamic";
import type { StudioPuckData } from "@/adapters/puck";

const ClientPuckEditor = dynamic(
  () => import("./PuckEditorClient").then((module) => module.PuckEditorClient),
  {
    ssr: false,
    loading: () => <div className="puck-loading">正在加载可视化编辑器…</div>,
  },
);

interface PuckEditorBoundaryProps {
  data: StudioPuckData;
  onChange: (data: StudioPuckData) => void;
  onRequestPreview: (data: StudioPuckData) => void;
}

export function PuckEditorBoundary(props: PuckEditorBoundaryProps) {
  return <ClientPuckEditor {...props} />;
}
