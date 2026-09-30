import type { ChartDataset } from "./config";

/** Synthetic, deliberately multiple transactions per quarter/type to exercise SUM rather than just plot input rows. */
export const salesSample: ChartDataset = {
  id: "synthetic-quarterly-sales-v1", name: "季度销售 · 模拟数据", synthetic: true, totalRows: 48,
  fields: [{ id: "quarter", name: "季度", type: "date" }, { id: "amount", name: "成交金额", type: "number" }, { id: "customer", name: "客户类型", type: "string" }],
  rows: Array.from({ length: 8 }, (_, q) => ["企业客户", "中小企业", "个人客户"].flatMap((customer, c) => [0, 1].map(part => ({
    quarter: `${2024 + Math.floor(q / 4)}-${String((q % 4) * 3 + 1 + part).padStart(2, "0")}-01T00:00:00Z`,
    amount: (q + 2) * (3 - c) * 12000 + part * 3000, customer,
  })))).flat().reverse(),
};
