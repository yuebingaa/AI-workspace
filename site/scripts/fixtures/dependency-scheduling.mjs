// Synthetic data and independent expected results; no user project or credentials.
export const CSV = 'region,amount\nEast,100\nEast,50\nSouth,80\n';
export const EXPECTED = [{ region: 'East', revenue: 150 }, { region: 'South', revenue: 80 }];
export const SQL = 'SELECT region, SUM(amount)::DOUBLE AS revenue FROM sales_data GROUP BY region ORDER BY region';
export const DEPENDENT_SQL = 'SELECT region, revenue FROM sales_totals ORDER BY region';
export const INVALID_SQL = 'SELECT missing_synthetic_column FROM sales_data';
export const CELLS = {
  data: { label: 'Data', title: '依赖调度原始数据', output: 'sales_data' },
  sql: { label: 'SQL', title: '依赖调度地区汇总', output: 'sales_totals' },
  downstream: { label: 'SQL', title: '汇总下游候选校验', output: 'dependent_totals' },
  chart: { label: '图表', title: '显示在前的地区图表' },
};
