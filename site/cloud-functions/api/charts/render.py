"""Render a bounded chart request to PNG or SVG with Matplotlib.

EdgeOne Makers maps this file to POST /api/charts/render.
"""

from http.server import BaseHTTPRequestHandler
from io import BytesIO
import json
import math
import re

import matplotlib

matplotlib.use("Agg")
from matplotlib import pyplot as plt  # noqa: E402


MAX_BODY_BYTES = 64 * 1024
MAX_POINTS = 50
CHART_TYPES = {"bar", "line", "area", "pie", "donut"}
OUTPUT_FORMATS = {"png", "svg"}
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
DEFAULT_COLORS = ["#13866B", "#62B49D", "#7B6FE8", "#E89AA3", "#E0A447", "#3E83C5"]

matplotlib.rcParams["font.sans-serif"] = [
    "Noto Sans CJK SC",
    "Microsoft YaHei",
    "SimHei",
    "Arial Unicode MS",
    "DejaVu Sans",
]
matplotlib.rcParams["axes.unicode_minus"] = False


class ChartRequestError(ValueError):
    """A safe validation error suitable for a client response."""


def _bounded_text(value, field, maximum, required=True):
    if value is None and not required:
        return ""
    if not isinstance(value, str):
        raise ChartRequestError(f"{field} 必须是文本。")
    clean = value.strip()
    if required and not clean:
        raise ChartRequestError(f"{field} 不能为空。")
    if len(clean) > maximum:
        raise ChartRequestError(f"{field} 最多 {maximum} 个字符。")
    return clean


def _bounded_number(value, field, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ChartRequestError(f"{field} 必须是有限数字。")
    if value < minimum or value > maximum:
        raise ChartRequestError(f"{field} 必须在 {minimum} 到 {maximum} 之间。")
    return float(value)


def validate_chart_request(payload):
    if not isinstance(payload, dict):
        raise ChartRequestError("请求体必须是 JSON 对象。")
    allowed = {"title", "subtitle", "chartType", "labels", "values", "colors", "format", "width", "height"}
    unknown = sorted(set(payload) - allowed)
    if unknown:
        raise ChartRequestError(f"不支持的字段：{', '.join(unknown)}。")

    chart_type = payload.get("chartType")
    if chart_type not in CHART_TYPES:
        raise ChartRequestError("chartType 仅支持 bar、line、area、pie、donut。")
    output_format = payload.get("format", "png")
    if output_format not in OUTPUT_FORMATS:
        raise ChartRequestError("format 仅支持 png 或 svg。")

    labels = payload.get("labels")
    values = payload.get("values")
    if not isinstance(labels, list) or not isinstance(values, list):
        raise ChartRequestError("labels 和 values 必须是数组。")
    if not labels or len(labels) > MAX_POINTS or len(labels) != len(values):
        raise ChartRequestError(f"labels 与 values 数量必须相同，且为 1 到 {MAX_POINTS} 项。")
    clean_labels = [_bounded_text(label, f"labels[{index}]", 80) for index, label in enumerate(labels)]
    clean_values = [_bounded_number(value, f"values[{index}]", -1e15, 1e15) for index, value in enumerate(values)]

    if chart_type in {"pie", "donut"}:
        if len(clean_values) > 12:
            raise ChartRequestError("饼图或环形图最多支持 12 个分类；请改用排序柱状图。")
        if any(value < 0 for value in clean_values) or sum(clean_values) <= 0:
            raise ChartRequestError("饼图或环形图只支持非负值，且总和必须大于 0。")

    colors = payload.get("colors", DEFAULT_COLORS)
    if not isinstance(colors, list) or not colors or len(colors) > 12:
        raise ChartRequestError("colors 必须是 1 到 12 项的十六进制颜色数组。")
    clean_colors = []
    for index, color in enumerate(colors):
        if not isinstance(color, str) or not HEX_COLOR.fullmatch(color):
            raise ChartRequestError(f"colors[{index}] 必须是 #RRGGBB。")
        clean_colors.append(color.upper())

    return {
        "title": _bounded_text(payload.get("title", "DataCanvas 图表"), "title", 120),
        "subtitle": _bounded_text(payload.get("subtitle"), "subtitle", 180, required=False),
        "chartType": chart_type,
        "labels": clean_labels,
        "values": clean_values,
        "colors": clean_colors,
        "format": output_format,
        "width": int(_bounded_number(payload.get("width", 1200), "width", 640, 2000)),
        "height": int(_bounded_number(payload.get("height", 720), "height", 360, 1400)),
    }


def render_chart(payload):
    request = validate_chart_request(payload)
    width = request["width"]
    height = request["height"]
    figure, axis = plt.subplots(figsize=(width / 120, height / 120), dpi=120, constrained_layout=True)
    figure.patch.set_facecolor("white")
    axis.set_facecolor("white")
    labels = request["labels"]
    values = request["values"]
    colors = request["colors"]
    chart_type = request["chartType"]
    positions = list(range(len(labels)))

    try:
        if chart_type == "bar":
            bars = axis.bar(positions, values, color=[colors[index % len(colors)] for index in positions], width=0.72)
            axis.axhline(0, color="#91A09B", linewidth=0.8)
            axis.bar_label(bars, fmt="%.2g", padding=3, fontsize=8)
            axis.set_xticks(positions, labels)
            if len(labels) > 8 or max(map(len, labels)) > 8:
                axis.tick_params(axis="x", labelrotation=90, labelsize=8)
        elif chart_type in {"line", "area"}:
            axis.plot(positions, values, color=colors[0], marker="o", linewidth=2.2)
            if chart_type == "area":
                axis.fill_between(positions, values, 0, color=colors[0], alpha=0.22)
            axis.axhline(0, color="#91A09B", linewidth=0.8)
            axis.set_xticks(positions, labels)
            if len(labels) > 8 or max(map(len, labels)) > 8:
                axis.tick_params(axis="x", labelrotation=90, labelsize=8)
        else:
            wedges, _, _ = axis.pie(
                values,
                labels=labels,
                colors=[colors[index % len(colors)] for index in positions],
                autopct=lambda percentage: f"{percentage:.1f}%" if percentage >= 2 else "",
                startangle=90,
                counterclock=False,
                wedgeprops={"width": 0.42 if chart_type == "donut" else 1.0, "edgecolor": "white"},
            )
            if chart_type == "donut":
                axis.text(0, 0, f"{sum(values):,.4g}", ha="center", va="center", fontsize=14, fontweight="bold")
            axis.axis("equal")
            for wedge in wedges:
                wedge.set_linewidth(1)

        if chart_type not in {"pie", "donut"}:
            axis.grid(axis="y", color="#E6ECE9", linewidth=0.8)
            axis.set_axisbelow(True)
            axis.spines[["top", "right"]].set_visible(False)
            axis.spines[["left", "bottom"]].set_color("#CBD6D2")
        axis.set_title(request["title"], loc="left", fontsize=15, fontweight="bold", pad=18)
        if request["subtitle"]:
            figure.text(0.01, 0.965, request["subtitle"], ha="left", va="top", fontsize=9, color="#66736E")

        output = BytesIO()
        figure.savefig(output, format=request["format"], facecolor="white", metadata={"Creator": "DataCanvas AI"})
        return output.getvalue(), request["format"]
    finally:
        plt.close(figure)


class handler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send_json(200, {
            "service": "DataCanvas Matplotlib chart renderer",
            "route": "POST /api/charts/render",
            "chartTypes": sorted(CHART_TYPES),
            "formats": sorted(OUTPUT_FORMATS),
            "maxPoints": MAX_POINTS,
        })

    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "Content-Length 无效。"})
            return
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            self._send_json(413, {"error": f"请求体必须为 1 到 {MAX_BODY_BYTES} 字节。"})
            return
        if "application/json" not in self.headers.get("Content-Type", "").lower():
            self._send_json(415, {"error": "Content-Type 必须是 application/json。"})
            return
        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            body, output_format = render_chart(payload)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"error": "请求体不是有效的 UTF-8 JSON。"})
            return
        except ChartRequestError as error:
            self._send_json(422, {"error": str(error)})
            return
        except Exception:
            self._send_json(500, {"error": "图表渲染失败，请稍后重试。"})
            return

        content_type = "image/png" if output_format == "png" else "image/svg+xml; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Disposition", f'attachment; filename="datacanvas-chart.{output_format}"')
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)
