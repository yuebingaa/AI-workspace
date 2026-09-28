"use client";

import { useRef, useState } from "react";
import { Popover } from "@radix-ui/themes";
import { Command } from "cmdk";
import { Button } from "./button";

export interface SearchOption { value: string; label: string; detail?: string; disabled?: boolean; }
export function SearchSelect({ id, label, value, options, placeholder = "请选择", disabled = false, invalid = false, describedBy, onValueChange }: {
  id: string; label: string; value: string; options: SearchOption[]; placeholder?: string; disabled?: boolean; invalid?: boolean;
  describedBy?: string; onValueChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), selectionClose = useRef(false);
  const selected = options.find(option => option.value === value);
  return <Popover.Root open={open && !disabled} onOpenChange={setOpen}>
    <Popover.Trigger>
      <Button id={id} ref={trigger} className="ui-combobox-trigger" role="combobox" aria-label={label}
        aria-expanded={open && !disabled} aria-invalid={invalid || undefined} aria-describedby={describedBy} disabled={disabled}
        onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); } }}>
        <span>{selected?.label ?? (value ? "字段已失效，请重新选择" : placeholder)}</span><span aria-hidden="true">⌄</span>
      </Button>
    </Popover.Trigger>

      <Popover.Content className="ui-combobox-content" sideOffset={5} align="start" collisionPadding={12}
        onCloseAutoFocus={event => { if (selectionClose.current) { event.preventDefault(); selectionClose.current = false; } }}>
        <Command label={`搜索${label}`} defaultValue={value} loop>
          <Command.Input placeholder="输入名称或字段名搜索…" aria-label={`搜索${label}`} />
          <Command.List>
            <Command.Empty>没有匹配项，换个关键词试试。</Command.Empty>
            {options.map(option => <Command.Item key={option.value} value={option.value} keywords={[option.label, option.detail ?? ""]} disabled={option.disabled}
              onSelect={() => { selectionClose.current = true; trigger.current?.focus(); setOpen(false); onValueChange(option.value); }}>
              <span><span>{option.label}</span>{option.detail && <small>{option.detail}</small>}</span><span aria-hidden="true">{option.value === value ? "✓" : ""}</span>
            </Command.Item>)}
          </Command.List>
        </Command>
      </Popover.Content>

  </Popover.Root>;
}
