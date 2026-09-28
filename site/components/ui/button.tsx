"use client";

import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { Button as ThemeButton, IconButton } from "@radix-ui/themes";

type ButtonProps = ComponentPropsWithoutRef<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "default" | "small" | "icon";
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = "secondary", size = "default", loading = false, disabled, className = "", children, type = "button", ...props
}, ref) {
  const Component = size === "icon" ? IconButton : ThemeButton;
  const selected = props["aria-pressed"] === true || props["aria-selected"] === true || Boolean(props["aria-current"] && props["aria-current"] !== "false");
  return <Component {...props} ref={ref} type={type} disabled={disabled || loading} loading={loading}
    aria-label={props["aria-label"] ?? (loading && typeof children === "string" ? children : undefined)}
    aria-busy={loading ? true : props["aria-busy"]} size={size === "small" ? "1" : "2"}
    variant={variant === "primary" ? "solid" : variant === "danger" || selected ? "soft" : variant === "ghost" ? "ghost" : "surface"}
    color={variant === "danger" ? "red" : variant === "primary" || selected ? undefined : "gray"}
    className={`ui-button ${className}`}>{children}</Component>;
});
