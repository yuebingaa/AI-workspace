import type { CSSProperties } from "react";
import type { TypographyProps } from "@/core/models";

const fontFamilies: Record<NonNullable<TypographyProps["fontFamily"]>, string> = {
  system: "var(--font-sans), system-ui, sans-serif",
  yahei: '"Microsoft YaHei", "PingFang SC", sans-serif',
  arial: "Arial, sans-serif",
  serif: '"Songti SC", SimSun, serif',
  monospace: '"Cascadia Code", Consolas, monospace',
};

const fontWeights: Record<NonNullable<TypographyProps["fontWeight"]>, number> = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
};

export function componentTypographyStyle(props: TypographyProps): CSSProperties {
  return {
    ...(props.fontFamily ? { fontFamily: fontFamilies[props.fontFamily] } : {}),
    ...(props.fontSize ? { fontSize: `${props.fontSize}px` } : {}),
    ...(props.fontColor ? { color: props.fontColor } : {}),
    ...(props.fontWeight ? { fontWeight: fontWeights[props.fontWeight] } : {}),
    ...(props.fontStyle ? { fontStyle: props.fontStyle } : {}),
    ...(props.textDecoration ? { textDecoration: props.textDecoration } : {}),
  };
}
