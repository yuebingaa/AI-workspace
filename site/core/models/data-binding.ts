export type DataFieldType = "string" | "number" | "date" | "boolean";

export type DataAggregation =
  | "none"
  | "sum"
  | "average"
  | "count"
  | "countDistinct"
  | "min"
  | "max";

export type DataFilterOperator =
  | "equals"
  | "notEquals"
  | "contains"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "lessThan"
  | "lessThanOrEqual";

export type DataValue = string | number | boolean | null;
export type DataRow = Record<string, DataValue>;

export interface DataFilter {
  field: string;
  operator: DataFilterOperator;
  value: string | number | boolean;
}

export interface DataSort {
  field: string;
  direction: "asc" | "desc";
}

export interface DataFormat {
  style: "auto" | "text" | "number" | "currency" | "percent";
  currency?: "CNY" | "USD";
  notation?: "standard" | "compact";
  decimals?: number;
  prefix?: string;
  suffix?: string;
}

export interface DataColumnBinding {
  field: string;
  label?: string;
  aggregation: DataAggregation;
  format: DataFormat;
}

export interface DataBinding {
  dataSourceId: string;
  field: string;
  aggregation: DataAggregation;
  groupBy: string | null;
  filters: DataFilter[];
  sort: DataSort[];
  limit: number;
  format: DataFormat;
  columns?: DataColumnBinding[];
}

export interface DataSourceField {
  name: string;
  label: string;
  type: DataFieldType;
  aggregatable: boolean;
  supportedAggregations: DataAggregation[];
}

export interface DataSourceDefinition {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  qualityScore: number;
  updatedAt: string;
  sourceType: "csv" | "json" | "local-fixture";
  fields: DataSourceField[];
}

export interface LocalDataRuntime {
  rowsByDataSourceId: Record<string, DataRow[]>;
}
