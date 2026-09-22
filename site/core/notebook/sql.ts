// Compatibility entry for existing Notebook callers. There is one validator;
// remove this alias only when those callers have migrated to the SQL module.
export { normalizeReadOnlySql as normalizeNotebookSql } from "@/core/sql/read-only-query";
