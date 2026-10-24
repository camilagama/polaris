import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

/* Polaris v5.1: 12 px of breathing room with touch, 16 with a mouse (`--card-spacing`); a 6% ring plus a short
   shadow, and in the dark theme a 1 px glow at the top (`--card-glow`, OKLCH).
   The gap between the parts, the padding above and below and the tone are variants, not classes of the caller (the
   classes are not merged, t320): `gap` and `pad` replace the default of `--card-spacing`, and `tone="quiet"` is a card
   with no shadow on a muted background (a goal that is over). */
const cardVariants = cva(
  "group/card flex flex-col overflow-hidden rounded-xl text-card-foreground text-sm ring-1 ring-foreground/[0.06] [--card-spacing:--spacing(3)] dark:shadow-[inset_0_1px_0_var(--card-glow)] md:[--card-spacing:--spacing(4)]",
  {
    defaultVariants: {
      gap: "default",
      pad: "default",
      tone: "default",
    },
    variants: {
      gap: {
        "1.5": "gap-1.5",
        "2": "gap-2",
        "3": "gap-3",
        default: "gap-(--card-spacing)",
        none: "gap-0",
      },
      pad: {
        "6": "py-6",
        default: "py-(--card-spacing)",
        none: "py-0",
      },
      tone: {
        default: "bg-card shadow-xs",
        quiet: "bg-muted/30 shadow-none",
      },
    },
  }
);

function Card({
  className,
  gap,
  pad,
  tone,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return (
    <div
      className={cn(cardVariants({ gap, pad, tone }), className)}
      data-slot="card"
      {...props}
    />
  );
}

/* The layout of the header is a variant: `stack` (title over description), `row` (title and an action side by side,
   wrapping), `wide-row` (the same with more room between the lines) and `action` (a title column and one action). */
const cardHeaderVariants = cva(
  "auto-rows-min px-(--card-spacing) has-data-[slot=card-description]:grid-rows-[auto_auto]",
  {
    defaultVariants: {
      layout: "stack",
    },
    variants: {
      layout: {
        action: "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-0.5",
        row: "flex flex-wrap items-center justify-between gap-3",
        stack: "grid items-start gap-0.5",
        "wide-row":
          "flex flex-wrap items-center justify-between gap-x-4 gap-y-2",
      },
    },
  }
);

function CardHeader({
  className,
  layout,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof cardHeaderVariants>) {
  return (
    <div
      className={cn(
        "group/card-header",
        cardHeaderVariants({ layout }),
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
