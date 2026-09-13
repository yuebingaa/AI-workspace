// This is an early-error check, NOT the security boundary. SQL is parsed again
// by DuckDB inside a disposable Wasm runtime without host filesystem/network APIs.
export function normalizeNotebookSql(raw: string): string {
  if (!raw.trim() || raw.length > 10_000) throw new Error("SQL 必须为 1–10000 个字符");
  let tokens = "";
  let depth = 0;
  let quote = "";
  let lineComment = false;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i], n = raw[i + 1];
    if (lineComment) { if (c === "\n") lineComment = false; tokens += " "; continue; }
    if (depth) {
      if (c === "/" && n === "*") { depth++; i++; tokens += " "; }
      else if (c === "*" && n === "/") { depth--; i++; tokens += " "; }
      tokens += " "; continue;
    }
    if (quote) {
      if (c === quote) { if (n === quote) { i++; tokens += " "; } else quote = ""; }
      tokens += " "; continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; tokens += " "; }
    else if (c === "-" && n === "-") { lineComment = true; tokens += "  "; i++; }
    else if (c === "/" && n === "*") { depth++; tokens += "  "; i++; }
    else tokens += c;
  }
  if (quote || depth) throw new Error("SQL 引号或注释没有闭合");
  if (!/^\s*(SELECT|WITH)\b/iu.test(tokens)) throw new Error("第一版只支持 SELECT / WITH 查询");
  const semicolons = [...tokens.matchAll(/;/gu)].map((m) => m.index!);
  if (semicolons.length > 1 || (semicolons.length && tokens.slice(semicolons[0] + 1).trim())) throw new Error("每个 SQL 单元只能包含一条查询");
  if (/\b(ATTACH|DETACH|COPY|INSTALL|LOAD|CALL|PRAGMA|SET|RESET|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|EXPORT|IMPORT)\b/iu.test(tokens)) {
    throw new Error("SQL 单元不允许修改数据、配置或访问外部资源");
  }
  return semicolons.length ? raw.slice(0, semicolons[0]).trim() : raw.trim();
}
