export const ROW_COUNT = 1324;
export const CSV = `seq,amount\n${Array.from({ length: ROW_COUNT }, (_, index) => `${index + 1},1`).join('\n')}\n`;
export const EXPECTED = [{ record_count: ROW_COUNT, total_amount: ROW_COUNT, unique_seq: ROW_COUNT, last_seq: ROW_COUNT }];
export const COUNT_SQL = 'SELECT COUNT(*)::DOUBLE AS record_count, SUM(amount)::DOUBLE AS total_amount, COUNT(DISTINCT seq)::DOUBLE AS unique_seq, MAX(seq)::DOUBLE AS last_seq FROM saved_rows';
export const TRUNCATED_SQL = 'SELECT * FROM raw_rows ORDER BY seq';
export const CELLS = {
  data: { label: 'Data', title: '1324 行原始数据', output: 'raw_rows' },
  transform: { label: 'DataRecipe', title: '完整结果与展示预览', output: 'complete_rows' },
  saved: { label: 'Data', title: '重新读取已保存的完整结果', output: 'saved_rows' },
  count: { label: 'SQL', title: '核验完整 1324 行而非预览', output: 'saved_counts' },
  truncated: { label: 'SQL', title: '真实截断结果不可保存', output: 'truncated_rows' },
};
