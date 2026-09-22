import { describe, expect, it } from "vitest";
import { normalizeNotebookSql } from "@/core/notebook/sql";
import { normalizeReadOnlySql } from "./read-only-query";

describe("shared SQL early validation compatibility", () => {
  it("keeps the Notebook compatibility entry as the same function", () => {
    expect(normalizeNotebookSql).toBe(normalizeReadOnlySql);
  });
  it.each([
    ["  SELECT 1  ", "SELECT 1"],
    ["/* first */ WITH x AS (SELECT 1) SELECT * FROM x; -- final", "/* first */ WITH x AS (SELECT 1) SELECT * FROM x"],
    ["SELECT ';DELETE' AS value; -- final", "SELECT ';DELETE' AS value"],
    ["SELECT 'it''s;DROP' AS value", "SELECT 'it''s;DROP' AS value"],
    ['SELECT "DROP" AS "a""b"', 'SELECT "DROP" AS "a""b"'],
    ["/* outer /* nested DELETE */ comment */ SELECT 1", "/* outer /* nested DELETE */ comment */ SELECT 1"],
    ["-- UPDATE ignored\nSELECT 1; /* end */", "-- UPDATE ignored\nSELECT 1"],
  ])("preserves normalized SQL without rewriting dialect: %s", (raw, expected) => {
    expect(normalizeReadOnlySql(raw)).toBe(expected);
  });

  it.each([
    ["", "SQL 必须为 1–10000 个字符"],
    ["   ", "SQL 必须为 1–10000 个字符"],
    ["SELECT 'open", "SQL 引号或注释没有闭合"],
    ["SELECT 1 /* open", "SQL 引号或注释没有闭合"],
    ["CALL example()", "第一版只支持 SELECT / WITH 查询"],
    ["EXPLAIN SELECT 1", "第一版只支持 SELECT / WITH 查询"],
    ["SELECT 1; SELECT 2", "每个 SQL 单元只能包含一条查询"],
    ["SELECT 1;;", "每个 SQL 单元只能包含一条查询"],
    ["WITH x AS (SELECT 1) DELETE FROM x", "SQL 单元不允许修改数据、配置或访问外部资源"],
    ["SELECT 1; DROP TABLE x", "每个 SQL 单元只能包含一条查询"],
  ])("keeps existing error ordering and text: %s", (raw, message) => {
    expect(() => normalizeReadOnlySql(raw)).toThrow(message);
  });

  it("keeps the original character limit and does not silently truncate SQL", () => {
    const exact = `SELECT 1 /*${"x".repeat(9_987)}*/`;
    expect(exact).toHaveLength(10_000);
    expect(normalizeReadOnlySql(exact)).toBe(exact);
    expect(() => normalizeReadOnlySql(`${exact} `)).toThrow("SQL 必须为 1–10000 个字符");
  });
});
