import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "cloud-functions" / "api" / "charts" / "render.py"
SPEC = importlib.util.spec_from_file_location("datacanvas_chart_renderer", MODULE_PATH)
RENDERER = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(RENDERER)


class ChartRendererTests(unittest.TestCase):
    def payload(self, chart_type="bar", output_format="png"):
        return {
            "title": "异常类型分布",
            "subtitle": "2026-09-05 · 白班",
            "chartType": chart_type,
            "labels": ["视觉超时", "位置异常", "通信异常"],
            "values": [44, 21, 8],
            "format": output_format,
        }

    def test_renders_png(self):
        body, output_format = RENDERER.render_chart(self.payload())
        self.assertEqual(output_format, "png")
        self.assertTrue(body.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertGreater(len(body), 10_000)

    def test_renders_svg_donut(self):
        body, output_format = RENDERER.render_chart(self.payload("donut", "svg"))
        self.assertEqual(output_format, "svg")
        self.assertIn(b"<svg", body)
        self.assertIn(b"DataCanvas AI", body)

    def test_rejects_negative_pie_values(self):
        payload = self.payload("pie")
        payload["values"] = [3, -1, 2]
        with self.assertRaisesRegex(RENDERER.ChartRequestError, "非负值"):
            RENDERER.render_chart(payload)

    def test_rejects_mismatched_arrays_and_unknown_fields(self):
        mismatch = self.payload()
        mismatch["values"] = [1]
        with self.assertRaisesRegex(RENDERER.ChartRequestError, "数量必须相同"):
            RENDERER.validate_chart_request(mismatch)
        unknown = self.payload()
        unknown["sourceUrl"] = "https://example.com/data.csv"
        with self.assertRaisesRegex(RENDERER.ChartRequestError, "不支持的字段"):
            RENDERER.validate_chart_request(unknown)


if __name__ == "__main__":
    unittest.main()
