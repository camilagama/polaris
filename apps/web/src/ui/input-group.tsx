"use client";

import { Input as InputPrimitive } from "@base-ui/react/input";
import { cva, type VariantProps } from "class-variance-authority";
import { type ComponentProps, type MouseEvent, useCallback } from "react";
import { cn } from "@/lib/utils";

/* The Polaris text field. With touch the 48 px area comes from the group itself (touch-hit-field): a touch on the
   band above or below the field focuses the text. No role: one field (with or without the "R$" beside it) is no
   group of controls, and a nameless group would only add "group" to what the screen reader says. */
/* What a screen changes in the group is a variant, not a class (the classes are not merged, t320): `shape` (`field`: one
   line of the height of the control; `area`: it grows with a text area), `width` (the row, or a short number field of
   14, 16 or 20 spacing units; `auto-40` is the month picker, no wider than its content and at least 10 rem) and
   `surface` (the field, or `raised` for a control that looks like a button). */
const inputGroupVariants = cva(
  "group/input-group touch-hit-field relative flex rounded-md border border-input outline-none transition-[border-color,box-shadow] has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot][aria-invalid=true]]:border-destructive has-disabled:bg-muted has-disabled:opacity-60 has-[[data-slot=input-group-control]:focus-visible]:ring-[3px] has-[[data-slot=input-group-control]:focus-visible]:ring-ring/30 has-[[data-slot][aria-invalid=true]]:focus-within:ring-[3px] has-[[data-slot][aria-invalid=true]]:focus-within:ring-destructive/25 dark:has-disabled:bg-muted has-[>[data-align=inline-end]]:[&>input]:pr-1.5 has-[>[data-align=inline-start]]:[&>input]:pl-1.5",
  {
    defaultVariants: {
      shape: "field",
      surface: "field",
      width: "full",
    },
    variants: {
      shape: {
        area: "h-auto items-stretch",
        field: "h-ctl-md items-center",
      },
      surface: {
        field: "dark:bg-input/30",
        raised: "bg-card shadow-xs dark:bg-secondary/60",
      },
      width: {
        "14": "w-14 min-w-0",
        "16": "w-16 min-w-0",
        "20": "w-20 min-w-0",
        "auto-40": "w-auto min-w-40",
        full: "w-full min-w-0",
      },
    },
  }
);

function InputGroup({
  className,
  onClick,
  shape,
  surface,
  width,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof inputGroupVariants>) {
  const focusOnBand = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      onClick?.(event);
      if (event.target === event.currentTarget) {
        event.currentTarget
          .querySelector<HTMLElement>("[data-slot=input-group-control]")
          ?.focus();
      }
    },
    [onClick]
  );
  return (
    // The click only helps the pointer (the band around the field focuses it); the keyboard reaches the
    // control itself, so the wrapper needs no key handler.
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: see above
    // biome-ignore lint/a11y/noStaticElementInteractions: see above
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above
    <div
      className={cn(inputGroupVariants({ shape, surface, width }), className)}
      data-slot="input-group"
      onClick={focusOnBand}
      {...props}
    />
  );
}

/* Text beside the control (the "R$" of a price). It lets the pointer through, so a click on it lands on the band
   of the group and focuses the control; the text stays in the accessibility tree. Only inline: the block
   alignments come back with the first screen that needs them. */
const inputGroupAddonVariants = cva(
  "pointer-events-none flex h-auto select-none items-center justify-center gap-2 py-1.5 text-muted-foreground text-sm [&>svg:not([class*='size-'])]:size-4",
  {
    defaultVariants: {
      align: "inline-start",
    },
    variants: {
      align: {
        "inline-end": "order-last pr-3",
        "inline-start": "order-first pl-3",
      },
    },
  }
);

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      className={cn(inputGroupAddonVariants({ align }), className)}
      data-align={align}
      data-slot="input-group-addon"
      {...props}
    />
  );
}

/* The control inside the group: no border of its own (border, focus and error belong to the group). 16 px only with
   touch (iOS zooms in below that). */
function InputGroupInput({
  className,
  inset = "default",
  ...props
}: ComponentProps<"input"> & {
  /** The space beside the text: 12 px, or 4 px in a short number field (the quantity stepper). */
  inset?: "default" | "tight";
}) {
  return (
    <InputPrimitive
      className={cn(
        "h-full w-full min-w-0 flex-1 bg-transparent text-sm touch:text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed",
        inset === "tight" ? "px-1" : "px-3",
        className
      )}
      data-slot="input-group-control"
      {...props}
    />
  );
}

/* A text area in a group (a note of several lines): the group is `h-auto items-stretch` there, so it grows with the
   text; the area is a native element, resized by the person only downward. */
function InputGroupTextarea({
  className,
  ...props
}: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "min-h-20 w-full min-w-0 flex-1 resize-y bg-transparent px-3 py-2 text-sm touch:text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed",
        className
      )}
      data-slot="input-group-control"
      {...props}
    />
  );
}

export { InputGroup, InputGroupAddon, InputGroupInput, InputGroupTextarea };
