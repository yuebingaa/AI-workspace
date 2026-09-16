// Runs inside the browser's WebAssembly Python VM, never in the Node host.
export const PYTHON_CELL_PROGRAM = String.raw`
import json as _ac_json, io as _ac_io, contextlib as _ac_contextlib, traceback as _ac_traceback
import datetime as _ac_datetime, math as _ac_math
import pandas as _ac_pd
import numpy as _ac_np

class _AcCapture(_ac_io.TextIOBase):
    def __init__(self): self.text = ""
    def write(self, text):
        self.text = (self.text + str(text))[:2000]
        return len(text)
    def flush(self): pass

def _ac_run_cell(payload_text):
    payload = _ac_json.loads(payload_text)
    output, error = _AcCapture(), _AcCapture()
    namespace = {"__name__": "__notebook__", "pd": _ac_pd, "np": _ac_np,
                 "files": payload["files"]}
    for table in payload["tables"]:
        df = _ac_pd.DataFrame(table["rows"], columns=[f["name"] for f in table["fields"]])
        for field in table["fields"]:
            name, kind = field["name"], field["type"]
            if kind == "number": df[name] = _ac_pd.to_numeric(df[name], errors="raise")
            elif kind == "boolean": df[name] = df[name].astype("boolean")
            elif kind == "date": df[name] = _ac_pd.to_datetime(df[name], errors="raise")
            else: df[name] = df[name].astype("string")
        namespace[table["name"]] = df
    try:
        with _ac_contextlib.redirect_stdout(output), _ac_contextlib.redirect_stderr(error):
            exec(compile(payload["code"], "<notebook-python>", "exec"), namespace)
        df = namespace.get(payload["outputName"])
        if not isinstance(df, _ac_pd.DataFrame):
            raise ValueError("请将结果赋给输出表名 " + payload["outputName"] + "，类型必须为 pandas.DataFrame")
        if not 1 <= len(df.columns) <= 30: raise ValueError("Python 输出必须包含 1 到 30 列")
        if len(df) > 50000: raise ValueError("Python 输出超过 50000 行，请在当前单元内先筛选或汇总")
        if not df.columns.is_unique or any(not isinstance(c, str) or not c or len(c) > 120 for c in df.columns):
            raise ValueError("输出列名必须为唯一且不超过 120 字的非空文本")
        fields, columns = [], {}
        def scalar(value):
            if value is None or value is _ac_pd.NA or value is _ac_pd.NaT: return None
            if isinstance(value, _ac_np.generic): value = value.item()
            if isinstance(value, float) and not _ac_math.isfinite(value): return None
            if isinstance(value, (_ac_datetime.datetime, _ac_datetime.date)): return value.isoformat()
            if not isinstance(value, (str, bool, int, float)):
                raise ValueError("输出含列表、字典或其他对象，请先转为标量列")
            if isinstance(value, str) and len(value) > 20000: raise ValueError("单个输出值超过 20000 字")
            return value
        for name in df.columns:
            series = df[name]
            values = [scalar(v) for v in series.tolist()]
            present = [v for v in values if v is not None]
            kind = "string"
            if _ac_pd.api.types.is_datetime64_any_dtype(series.dtype): kind = "date"
            elif present and all(isinstance(v, bool) for v in present): kind = "boolean"
            elif present and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in present):
                if any(isinstance(v, int) and abs(v) > 9007199254740991 for v in present):
                    values = [None if v is None else str(v) for v in values]
                else: kind = "number"
            elif not present:
                if _ac_pd.api.types.is_bool_dtype(series.dtype): kind = "boolean"
                elif _ac_pd.api.types.is_numeric_dtype(series.dtype): kind = "number"
            if kind == "string": values = [None if v is None else str(v) for v in values]
            fields.append({"name": name, "label": name, "type": kind})
            columns[name] = values
        rows = [dict(zip(columns, values)) for values in zip(*columns.values())]
        result = {"table": {"fields": fields, "rows": rows, "truncated": False}, "stdout": output.text, "stderr": error.text}
        serialized = _ac_json.dumps(result, ensure_ascii=False, allow_nan=False)
        if len(serialized.encode("utf-8")) > 16 * 1024 * 1024: raise ValueError("Python 结果超过 16 MiB，请先汇总")
        return serialized
    except BaseException as caught:
        return _ac_json.dumps({"error": type(caught).__name__ + ": " + str(caught)[:700],
            "stdout": output.text, "stderr": (error.text + _ac_traceback.format_exc())[-2000:]}, ensure_ascii=False)
`;
