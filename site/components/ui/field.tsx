"use client";

import type { ReactNode } from "react";
export { TextInput as Input, TextArea as Textarea, SelectField as Select } from "./fields";

export function Field({ id, label, description, error, children, className = "" }: {
  id: string; label: string; description?: string; error?: string; children: ReactNode; className?: string;
}) {
  return <div className={`ui-field ${className}`}>
    <label htmlFor={id}>{label}</label>
    {children}
    {description && <span className="ui-field-hint" id={`${id}-hint`}>{description}</span>}
    {error && <span className="ui-field-error" id={`${id}-error`} role="alert">{error}</span>}
  </div>;
}
