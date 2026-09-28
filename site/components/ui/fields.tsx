"use client";

import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { Checkbox as ThemeCheckbox, Select as ThemeSelect, TextArea, TextField } from "@radix-ui/themes";

export { TextArea };
export const TextInput = TextField.Root;

export const Checkbox = forwardRef<HTMLButtonElement, Omit<ComponentPropsWithoutRef<typeof ThemeCheckbox>, "onCheckedChange"> & {
  onCheckedChange?: (checked: boolean) => void;
}>(function Checkbox({ onCheckedChange, ...props }, ref) {
  return <ThemeCheckbox {...props} ref={ref} onCheckedChange={checked => onCheckedChange?.(checked === true)} />;
});

type SelectProps = Omit<ComponentPropsWithoutRef<typeof ThemeSelect.Trigger>, "value" | "defaultValue" | "onChange" | "children"> & {
  value: string; onValueChange(value: string): void; children: ReactNode; name?: string; required?: boolean;
};

/** Encode every value so empty strings and arbitrary field names remain valid choices. */
export function SelectField({ value, onValueChange, children, name, required, disabled, className = "", ...trigger }: SelectProps) {
  return <ThemeSelect.Root value={JSON.stringify(value)} onValueChange={next => onValueChange(JSON.parse(next) as string)}
    name={name} required={required} disabled={disabled}>
    <ThemeSelect.Trigger {...trigger} className={`ui-select-field ${className}`} />
    <ThemeSelect.Content position="popper">{children}</ThemeSelect.Content>
  </ThemeSelect.Root>;
}

export function SelectItem({ value, children, ...props }: Omit<ComponentPropsWithoutRef<typeof ThemeSelect.Item>, "value"> & { value?: string }) {
  return <ThemeSelect.Item {...props} data-value={value ?? String(children)} value={JSON.stringify(value ?? String(children))}>{children}</ThemeSelect.Item>;
}
