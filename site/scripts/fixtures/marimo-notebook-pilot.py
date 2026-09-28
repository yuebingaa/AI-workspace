# /// script
# requires-python = ">=3.12"
# dependencies = ["marimo==0.25.0", "pandas==2.3.3", "duckdb==1.4.2", "altair==5.5.0", "pyarrow==23.0.1", "sqlglot==30.19.0"]
# ///
"""Standalone synthetic adoption pilot. No project data, credentials or Agent bridge."""
import marimo

__generated_with = "0.25.0"
app = marimo.App(width="full")


@app.cell
def _():
    import marimo as mo
    import pandas as pd
    import altair as alt
    return mo, pd, alt


@app.cell
def _(mo):
    mo.md("# 季度销售分析\n合成数据 · marimo 接入样板")
    return


@app.cell
def _(pd):
    sales = pd.DataFrame([
        {"quarter": quarter, "segment": segment, "revenue": (index + 1) * amount}
        for index, quarter in enumerate(["2025 Q1", "2025 Q2", "2025 Q3", "2025 Q4"])
        for segment, amount in [("企业客户", 32000), ("成长客户", 18000), ("小型客户", 9000)]
    ])
    sales
    return sales,


@app.cell
def _(mo):
    minimum = mo.ui.slider(start=0, stop=50000, step=1000, value=0, label="最低销售额")
    minimum
    return minimum,


@app.cell
def _(mo, sales, minimum):
    totals = mo.sql(f"""
        SELECT quarter, SUM(revenue) AS revenue
        FROM sales
        WHERE revenue >= {minimum.value}
        GROUP BY quarter
        ORDER BY quarter
    """)
    return totals,


@app.cell
def _(mo, alt, totals):
    plot = alt.Chart(totals).mark_area(opacity=0.3, line=True).encode(
        x=alt.X("quarter:N", title="季度"),
        y=alt.Y("revenue:Q", title="销售额"),
        tooltip=["quarter:N", "revenue:Q"],
    ).properties(height=300)
    mo.ui.altair_chart(plot)
    return


if __name__ == "__main__":
    import json
    import sys
    import sqlglot
    _outputs, _definitions = app.run()
    _totals = _definitions["totals"]
    _frame = _totals.to_pandas() if hasattr(_totals, "to_pandas") else _totals
    assert _frame["revenue"].tolist() == [59000, 118000, 177000, 236000]
    print(json.dumps({"rows": len(_frame), "revenue": int(_frame["revenue"].sum()), "python": sys.executable, "sqlglot": sqlglot.__version__}))
