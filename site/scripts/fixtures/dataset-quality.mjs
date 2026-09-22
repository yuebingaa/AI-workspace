// Explicit independent oracle, not computed with the product profiling helper.
export const QUALITY_FILE = 'synthetic-quality-contract.csv';
export const QUALITY_CSV = 'category,amount,note\nA,1,x\nA,01,x\nA,1.0,x\nB,2,\nB,2,"   "\n,,\nC,0,false\nC,0,false\nD,,NULL';
export const NORMALIZED_ROWS = [
  { category: 'A', amount: 1, note: 'x' },
  { category: 'A', amount: 1, note: 'x' },
  { category: 'A', amount: 1, note: 'x' },
  { category: 'B', amount: 2, note: null },
  { category: 'B', amount: 2, note: null },
  { category: null, amount: null, note: null },
  { category: 'C', amount: 0, note: 'false' },
  { category: 'C', amount: 0, note: 'false' },
  { category: 'D', amount: null, note: 'NULL' },
];
export const EXPECTED_COUNTS = { row_count: 9, column_count: 3, cell_count: 27,
  null_cells: 6, all_null_rows: 1, extra_duplicate_rows: 4 };
export const EXPECTED_FIELDS = {
  category: { type: 'string', nullCount: 1, uniqueCount: 4 },
  amount: { type: 'number', nullCount: 2, uniqueCount: 3 },
  note: { type: 'string', nullCount: 3, uniqueCount: 3 },
};
// Both programs operate on the same canonical Dataset. "NULL" and "false"
// are ordinary nonempty text; first occurrences are not duplicate rows.
export const QUALITY_SQL = `WITH distinct_rows AS (
  SELECT DISTINCT category, amount, note FROM quality_data
)
SELECT COUNT(*)::INTEGER AS row_count,
  3::INTEGER AS column_count,
  (COUNT(*) * 3)::INTEGER AS cell_count,
  SUM((category IS NULL)::INTEGER + (amount IS NULL)::INTEGER + (note IS NULL)::INTEGER)::INTEGER AS null_cells,
  SUM(CASE WHEN category IS NULL AND amount IS NULL AND note IS NULL THEN 1 ELSE 0 END)::INTEGER AS all_null_rows,
  (COUNT(*) - (SELECT COUNT(*) FROM distinct_rows))::INTEGER AS extra_duplicate_rows
FROM quality_data`;
export const QUALITY_PYTHON = `# Canonical Dataset values: empty/whitespace CSV cells were normalized at import.
# Compare these independent results with the fixed expected values, not only run success.
missing = quality_data.isna()
python_counts = pd.DataFrame([{
    'row_count': int(quality_data.shape[0]),
    'column_count': int(quality_data.shape[1]),
    'cell_count': int(quality_data.size),
    'null_cells': int(missing.to_numpy().sum()),
    'all_null_rows': int(missing.all(axis=1).sum()),
    'extra_duplicate_rows': int(quality_data.duplicated(keep='first').sum()),
}])
print('Explicit Dataset scope; NULL/false text is nonempty; duplicate first occurrence excluded.')`;
