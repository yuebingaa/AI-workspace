import { TextInput } from "@/components/ui/fields";
import { useId, useState } from "react";

/** A form draft is not a recipe value: an empty or incomplete number is not zero. */
export function parseRecipeNumberInput(raw: string): number | null {
  const text = raw.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

export function RecipeNumberInput({ value, onChange, label, min, max, integer = false }: {
  value: number; onChange: (value: number) => void; label?: string;
  min?: number; max?: number; integer?: boolean;
}) {
  const [raw, setRaw] = useState(String(value));
  const errorId = useId();
  const accepts = (number: number | null): number is number => number !== null
    && (min === undefined || number >= min) && (max === undefined || number <= max)
    && (!integer || Number.isInteger(number));
  const invalid = !accepts(parseRecipeNumberInput(raw));
  return <>
    <TextInput type="number" data-recipe-number="" required step={integer ? 1 : "any"}
      aria-label={label} aria-invalid={invalid || undefined} aria-describedby={invalid ? errorId : undefined}
      min={min} max={max} value={raw} onChange={(event) => {
        const next = event.target.value;
        setRaw(next);
        const number = parseRecipeNumberInput(next);
        // Keep the last valid domain value until this local draft is valid again.
        // The parent form also guards save and mode changes against invalid inputs.
        if (accepts(number)) onChange(number);
      }} />
    {invalid && <small id={errorId} role="alert">{integer
      ? `请输入 ${min ?? "有效下限"}–${max ?? "有效上限"} 范围内的整数。`
      : "请输入有效数值；空值不会自动变成 0。"}</small>}
  </>;
}
