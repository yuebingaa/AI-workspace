import type {
  DataAggregation,
  DataFieldType,
  DataFilterOperator,
  DataRow,
  DataValue,
} from "./data-binding";

export type RecipeAggregation = Exclude<DataAggregation, "none">;
export type RecipeCastType = DataFieldType;

export type RecipeOperand =
  | { kind: "field"; field: string }
  | { kind: "literal"; value: number };

export type DataRecipeStep =
  | { id: string; type: "selectFields"; fields: string[] }
  | { id: string; type: "filter"; field: string; operator: DataFilterOperator; value: string | number | boolean }
  | { id: string; type: "renameField"; field: string; newName: string; newLabel?: string }
  | { id: string; type: "castField"; field: string; to: RecipeCastType }
  | {
    id: string;
    type: "deriveField";
    field: string;
    label: string;
    operator: "add" | "subtract" | "multiply" | "divide";
    left: RecipeOperand;
    right: RecipeOperand;
  }
  | {
    id: string;
    type: "groupAggregate";
    groupBy: string[];
    aggregations: Array<{
      field: string;
      aggregation: RecipeAggregation;
      as: string;
      label: string;
    }>;
  }
  | { id: string; type: "sort"; by: Array<{ field: string; direction: "asc" | "desc" }> }
  | { id: string; type: "limit"; count: number };

export interface DataRecipe {
  id: string;
  name: string;
  sourceDatasetId: string;
  outputDatasetId: string;
  status: "draft" | "ready";
  steps: DataRecipeStep[];
}

export interface RecipeFieldSchema {
  name: string;
  label: string;
  type: DataFieldType;
  nullable: boolean;
}

export interface RecipeLineageTransformation {
  stepId: string;
  stepType: DataRecipeStep["type"];
  description: string;
}

export interface RecipeFieldLineage {
  field: string;
  sourceFields: string[];
  transformations: RecipeLineageTransformation[];
}

export interface RecipeStepExecutionSummary {
  stepId: string;
  stepIndex: number;
  stepType: DataRecipeStep["type"];
  status: "success" | "failure";
  inputRowCount: number;
  outputRowCount: number;
  durationMs: number;
  fields: RecipeFieldSchema[];
  error?: string;
}

interface RecipeExecutionBase {
  rows: DataRow[];
  fields: RecipeFieldSchema[];
  lineage: RecipeFieldLineage[];
  steps: RecipeStepExecutionSummary[];
  totalDurationMs: number;
}

export type DataRecipeExecutionResult =
  | (RecipeExecutionBase & { success: true })
  | (RecipeExecutionBase & { success: false; failedStepId: string; error: string });

export interface RecipePreviewRow {
  [field: string]: DataValue;
}
