export const CELL_MODULES_CSV = 'region,amount\nEast,100\nEast,50\nSouth,80\n';
export const CELL_LABELS = { data: 'Data', sql: 'SQL', python: 'Python', transform: 'DataRecipe', table: '表格',
  chart: '图表', text: '说明', semanticQuery: '语义查询', warehouseSql: '数据库 SQL' };
export const CELL_TITLES = { data: '合成销售源', sql: '地区 SQL 汇总', python: 'Python 加权', transform: '处理规则投影',
  table: '加权结果表格', chart: '加权地区图表', text: '兼容取消说明', semanticQuery: '本地语义汇总', warehouseSql: '仅目录替身 SQL' };
export const CELL_OUTPUTS = { data: 'sales_data', sql: 'sales_totals', python: 'weighted_data', transform: 'projected_data',
  semanticQuery: 'semantic_totals', warehouseSql: 'directory_only' };
export const CELL_MODULES_SQL = 'SELECT region, SUM(amount)::DOUBLE AS revenue FROM sales_data GROUP BY region ORDER BY region';
export const CELL_MODULES_PYTHON = "weighted_data = sales_totals.assign(weighted=sales_totals['revenue'] * 2)[['region', 'weighted']]\nprint('Synthetic 2x weighting')";
export const SQL_EXPECTED = [{ region: 'East', revenue: 150 }, { region: 'South', revenue: 80 }];
export const WEIGHTED_EXPECTED = [{ region: 'East', weighted: 300 }, { region: 'South', weighted: 160 }];
export const SEMANTIC_EXPECTED = [{ region: 'East', revenue: 150 }, { region: 'South', revenue: 80 }];
// Only a public directory descriptor. No credentials, host, provider execution,
// or actual connection configuration is created or changed by this fixture.
export const DIRECTORY_CONNECTION = { id: 'cell_modules_directory', name: '合成目录（不连接数据库）', kind: 'postgresql', allowAi: false };
