import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

/* Polaris v5.1: `warning` and `destructive` with a border and a background at 10%. Only the error interrupts
   the screen reader (`role="alert"`); information and warning are a polite `status`. */
const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-lg border px-3 py-2.5 text-left text-sm has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg:not([class*='size-'])]:size-4 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current",
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        /* an explanation, not a warning: a muted ground with the ink color, and `outline`: the card with a border of ink */
        muted: "bg-muted/60 text-foreground",
        outline: "border-foreground/15 bg-card text-foreground",
        destructive:
          "border-destructive/30 bg-destructive/10 text-destructive *:data-[slot=alert-description]:text-destructive",
        warning:
          "border-warning/30 bg-warning/10 text-warning *:data-[slot=alert-description]:text-warning",
      },
    },
  }
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      className={cn(alertVariants({ variant }), className)}
      data-slot="alert"
      role={variant === "destructive" ? "alert" : "status"}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "font-semibold group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3",
        className
      )}
      data-slot="alert-title"
      {...props}
    />
  );
}

/* The color, the type size and the space between paragraphs are variants (the classes are not merged, t320): `tone`
   (muted, or `foreground` for text that is the point of the notice), `size` (`support`, or `reading` for the legal
   text, 14/20 and 16/24 with touch) and `paragraphs` (`spaced`, or `tight` when the paragraphs are in a grid). */
const alertDescriptionVariants = cva(
  "text-balance md:text-pretty [&_a]:underline [&_a]:underline-offset-3",
  {
    defaultVariants: {
      paragraphs: "spaced",
      size: "support",
      tone: "muted",
    },
    variants: {
      paragraphs: {
        spaced: "[&_p:not(:last-child)]:mb-4",
        tight: "[&_p:not(:last-child)]:mb-0",
      },
      size: {
        reading: "text-sm/5 touch:text-base/6",
        support: "text-support",
      },
      tone: {
        foreground: "text-foreground",
        muted: "text-muted-foreground",
      },
    },
  }
);

function AlertDescription({
  className,
  paragraphs,
  size,
  tone,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof alertDescriptionVariants>) {
  return (
    <div
      className={cn(
        alertDescriptionVariants({ paragraphs, size, tone }),
        className
      )}
      data-slot="alert-description"
      {...props}
    />
  );
}

export { Alert, AlertDescription, AlertTitle };
