import type * as React from "react";
import { cn } from "@/lib/utils";

/* Polaris v5.1: 12 px of breathing room with touch, 16 with a mouse (`--card-spacing`); a 6% ring plus a short
   shadow, and in the dark theme a 1 px glow at the top (`--card-glow`, OKLCH). */
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl bg-card py-(--card-spacing) text-card-foreground text-sm shadow-xs ring-1 ring-foreground/[0.06] [--card-spacing:--spacing(3)] dark:shadow-[inset_0_1px_0_var(--card-glow)] md:[--card-spacing:--spacing(4)]",
        className
      )}
      data-slot="card"
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "group/card-header grid auto-rows-min items-start gap-0.5 px-(--card-spacing) has-data-[slot=card-description]:grid-rows-[auto_auto]",
        className
      )}
      data-slot="card-header"
      {...props}
    />
  );
}

/* A div, as in the registry: when the title names a section of the screen, the screen gives it the heading role
   and level (`role="heading" aria-level={2}`). */
function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("text-section", className)}
      data-slot="card-title"
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("text-muted-foreground text-support", className)}
      data-slot="card-description"
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("px-(--card-spacing)", className)}
      data-slot="card-content"
      {...props}
    />
  );
}

export { Card, CardContent, CardDescription, CardHeader, CardTitle };
