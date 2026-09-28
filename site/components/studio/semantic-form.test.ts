import { describe, expect, it } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { SEMANTIC_AGGREGATIONS } from "@/core/semantic/contracts";
import { semanticDraftErrors } from "./semantic-form";

describe("semantic form feedback", () => {
  it("accepts a valid model", () => {
    const { model, source } = semanticFixture();
    expect(semanticDraftErrors(model, source, [model])).toEqual({});
  });
  it("locates missing name and metrics without exposing validator JSON", () => {
    const { model, source } = semanticFixture();
    const errors = semanticDraftErrors({ ...model, name: " ", measures: [] }, source);
    expect(errors.name).toContain("模型名称");
    expect(errors.measures).toContain("至少添加一个指标");
    expect(Object.keys(errors).sort()).toEqual(["measures", "name"]);
  });
  it("marks both members of a cross-kind duplicate key, including whitespace", () => {
    const { model, source } = semanticFixture();
    model.measures[0].key = " area ";
    const errors = semanticDraftErrors(model, source);
    expect(errors["dimensions.0.key"]).toContain("标识已被使用");
    expect(errors["measures.0.key"]).toBe(errors["dimensions.0.key"]);
  });
  it("marks missing fields and unsupported numeric aggregation", () => {
    const { model, source } = semanticFixture();
    model.dimensions[0].field = "missing_field";
    model.measures[0].field = "region";
    const errors = semanticDraftErrors(model, source);
    expect(errors["dimensions.0.field"]).toContain("不可用");
    expect(errors["measures.0.aggregation"]).toContain("不支持");
  });
  it("marks repeated dimension fields and reserved identifiers", () => {
    const { model, source } = semanticFixture();
    model.dimensions.push({ ...model.dimensions[0], key: "constructor" });
    const errors = semanticDraftErrors(model, source);
    expect(errors["dimensions.0.field"]).toBe(errors["dimensions.1.field"]);
    expect(errors["dimensions.1.key"]).toContain("保留名称");
  });
  it("detects an unavailable source and another model with the same name", () => {
    const { model } = semanticFixture();
    const errors = semanticDraftErrors(model, undefined, [{ ...model, id: "another_model" }]);
    expect(errors.sourceDatasetId).toContain("不可用");
    expect(errors.name).toContain("同名");
  });
  it.each(SEMANTIC_AGGREGATIONS)("accepts supported %s on a numeric measure", (aggregation) => {
    const { model, source } = semanticFixture();
    model.measures[0].aggregation = aggregation;
    expect(semanticDraftErrors(model, source)).toEqual({});
  });
  it.each(SEMANTIC_AGGREGATIONS)("marks only the measure whose field does not support %s", (aggregation) => {
    const { model, source } = semanticFixture();
    model.measures = [{ ...model.measures[0], aggregation }];
    source.fields[1].supportedAggregations = source.fields[1].supportedAggregations.filter(value => value !== aggregation);
    expect(semanticDraftErrors(model, source)).toEqual({
      "measures.0.aggregation": "当前字段不支持这种计算方式，请重新选择。",
    });
  });
  it.each(["sum", "average"] as const)("rejects %s on text even if field metadata advertises it", (aggregation) => {
    const { model, source } = semanticFixture();
    model.measures[0] = { ...model.measures[0], field: "region", aggregation };
    source.fields[0].supportedAggregations.push(aggregation);
    expect(semanticDraftErrors(model, source)).toEqual({
      "measures.0.aggregation": "当前字段不支持这种计算方式，请重新选择。",
    });
  });
  it.each(["count", "countDistinct", "min", "max"] as const)("accepts supported %s on a text measure", (aggregation) => {
    const { model, source } = semanticFixture();
    model.measures[0] = { ...model.measures[0], field: "region", aggregation };
    expect(semanticDraftErrors(model, source)).toEqual({});
  });
  it("does not apply measure aggregation validation to dimensions", () => {
    const { model, source } = semanticFixture();
    source.fields[0].supportedAggregations = [];
    expect(semanticDraftErrors(model, source)).toEqual({});
  });
  it("keeps error indexes local to measures and clears the error after correction", () => {
    const { model, source } = semanticFixture();
    model.dimensions.push({ key: "amount_group", label: "金额分组", field: "amount", description: "" });
    model.measures[1].field = "region";
    expect(semanticDraftErrors(model, source)).toEqual({
      "measures.1.aggregation": "当前字段不支持这种计算方式，请重新选择。",
    });
    model.measures[1].aggregation = "count";
    expect(semanticDraftErrors(model, source)).toEqual({});
  });
});
