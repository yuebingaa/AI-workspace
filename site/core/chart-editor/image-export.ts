export type ChartImageFormat = "svg" | "png";
export interface ChartImageFile { name: string; mime: string; content: string | Uint8Array<ArrayBuffer> }

/** Accept only the local renderer's export outputs, not URLs or arbitrary file content. */
export function chartImageFiles(format: ChartImageFormat, images: string[], title: string): ChartImageFile[] {
  if (!images.length) throw Error("图表尚未完成渲染，请稍后重试。");
  const cleaned = Array.from(title.trim()).filter(char => char.charCodeAt(0) >= 32 && !'<>:"/\\|?*'.includes(char)).join("").slice(0, 80).replace(/[. ]+$/u, "");
  const stem = !cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(cleaned) ? "图表" : cleaned;
  return images.map((image, index) => {
    const name = `${stem}${images.length > 1 ? `-${index + 1}` : ""}.${format}`;
    if (format === "svg") {
      if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/u.test(image) || !image.includes("</svg>")) throw Error("组件未返回有效的 SVG，未下载文件。");
      return { name, mime: "image/svg+xml;charset=utf-8", content: image };
    }
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(image)) throw Error("组件未返回有效的 PNG，未下载文件。");
    const binary = atob(image.slice("data:image/png;base64,".length));
    const content = Uint8Array.from(binary, char => char.charCodeAt(0));
    if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => content[i] === byte)) throw Error("PNG 内容不完整，未下载文件。");
    return { name, mime: "image/png", content };
  });
}
