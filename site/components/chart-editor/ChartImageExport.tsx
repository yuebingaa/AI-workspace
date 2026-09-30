"use client";

import { useEffect, useRef, useState, type ComponentRef, type RefObject } from "react";
import type { PureRenderer } from "@kanaries/graphic-walker";
import { Button } from "@/components/ui/button";
import { chartImageFiles, type ChartImageFormat } from "@/core/chart-editor/image-export";

export function ChartImageExport({ renderer, revision, enabled, title }: {
  renderer: RefObject<ComponentRef<typeof PureRenderer> | null>; revision: string; enabled: boolean; title: string;
}) {
  const current = useRef(revision);
  useEffect(() => { current.current = revision; }, [revision]);
  const [result, setResult] = useState<{ revision: string; busy?: ChartImageFormat; error?: boolean; message?: string } | null>(null);
  const active = result?.revision === revision ? result : null;
  async function exportImage(format: ChartImageFormat) {
    if (!enabled || active?.busy) return;
    const handle = renderer.current;
    setResult({ revision, busy: format });
    try {
      if (!handle) throw Error("图表尚未完成渲染，请稍后重试。");
      // Public PureRenderer ref. Never scrape its ShadowDOM or capture the whole editor.
      const images = await (format === "svg" ? handle.getSVGData() : handle.getCanvasData());
      if (current.current !== revision || renderer.current !== handle) return;
      const files = chartImageFiles(format, images, title);
      for (const file of files) {
        const url = URL.createObjectURL(new Blob([file.content], { type: file.mime }));
        const link = document.createElement("a"); link.href = url; link.download = file.name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setResult({ revision, message: `已生成 ${files.length} 个 ${format.toUpperCase()} 文件；不包含页面标题和配置面板。` });
    } catch (caught) {
      if (current.current === revision) setResult({ revision, error: true, message: caught instanceof Error ? caught.message : "图表导出失败，请稍后重试。" });
    }
  }
  return <div className="gw-image-export">
    <div><Button size="small" disabled={!enabled || Boolean(active?.busy)} loading={active?.busy === "svg"} title="下载当前图形，不包含页面标题和配置面板" onClick={() => { void exportImage("svg"); }}>导出 SVG</Button>
      <Button size="small" disabled={!enabled || Boolean(active?.busy)} loading={active?.busy === "png"} title="下载当前图形，不包含页面标题和配置面板" onClick={() => { void exportImage("png"); }}>导出 PNG</Button></div>
    {active?.message && <small role={active.error ? "alert" : "status"} className={active.error ? "gw-export-error" : ""}>{active.message}</small>}
  </div>;
}
