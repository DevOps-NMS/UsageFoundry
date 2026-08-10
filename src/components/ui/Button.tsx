"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white border-transparent hover:brightness-110",
  secondary: "bg-inset text-ink border-line-strong hover:border-ink-faint",
  danger: "bg-danger text-white border-transparent hover:brightness-110",
  ghost: "bg-transparent text-ink-muted border-transparent hover:bg-inset hover:text-ink",
};

export function Button({
  children,
  variant = "primary",
  className = "",
  ...rest
}: {
  children: ReactNode;
  variant?: ButtonVariant;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`cursor-pointer rounded-sm border px-3.5 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100 ${VARIANT[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function ButtonRow({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {children}
    </div>
  );
}
