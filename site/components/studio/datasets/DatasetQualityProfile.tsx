"use client";

import { useMemo } from "react";
import type { DataRow, DataSourceDefinition } from "@/core/models";
import { profileDatasetRows } from "@/core/datasets/quality-profile";

export function DatasetQualityProfile({ source, rows }: { source: DataSourceDefinition; rows: DataRow[] }) {
  const profile = useMemo(() => profileDatasetRows(source, rows), [source, rows]);
  const count = (value: number) => value.toLocaleString("zh-CN");
  return <section className="dataset-current-profile" aria-label="当前数据统计">
    <header><h3>当前数据统计</h3><span>基于当前可用数据</span></header>
    {!profile.rowCountMatchesSource && <p className="dataset-profile-warning" role="status">
      当前可用 {count(profile.rowCount)} 行，数据源声明 {count(profile.declaredRowCount)} 行；以下不是全量统计。
    </p>}
    <dl>
      <div><dt>当前行数</dt><dd>{count(profile.rowCount)}</dd></div>
      <div><dt>声明字段</dt><dd>{count(profile.columnCount)}</dd></div>
      <div><dt>空单元格</dt><dd>{count(profile.nullCellCount)} / {count(profile.cellCount)} <small>({(profile.nullRate * 100).toFixed(1)}%)</small></dd></div>
      <div><dt>全空行</dt><dd>{count(profile.emptyRowCount)}</dd></div>
      <div><dt>额外重复行</dt><dd>{count(profile.duplicateRowCount)}</dd></div>
    </dl>
    <p>空值＝null 或缺失；空值率分母＝当前行数 × 声明字段数。</p>
    <p>全空行：全部声明字段为空；额外重复行：相同记录不计第一次。</p>
    <p>空字符串或纯空白字符串 {count(profile.nonNullBlankStringCount)} 个不算 null；仅统计当前数据，未检查原件物理行、表头或全空白行。</p>
  </section>;
}
