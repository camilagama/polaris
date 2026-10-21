import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

/* Buttons and a field glued into one control (the quantity stepper of the sale: − field +). Only the horizontal
   orientation, the one the sale uses; the inner corners square off and the shared borders collapse. The focused
   child rises above its neighbours so its outline is not covered. */
const buttonGroupVariants = cva(
  "flex w-fit items-stretch *:focus-visible:relative *:focus-visible:z-10 *:has-focus-visible:z-10",
  {
    defaultVariants: {
      orientation: "horizontal",
    },
    variants: {
      orientation: {
        horizontal:
          "*:data-slot:rounded-r-none [&>[data-slot]:not(:has(~[data-slot]))]:rounded-r-md! [&>[data-slot]~[data-slot]]:rounded-l-none [&>[data-slot]~[data-slot]]:border-l-0",
      },
    },
  }
);

function ButtonGroup({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof buttonGroupVariants>) {
  return (
    // A group of controls inside a field, not a form section: no fieldset (the caller names it with aria-label).
    // biome-ignore lint/a11y/useSemanticElements: see above
    <div
      className={cn(buttonGroupVariants({ orientation }), className)}
      data-orientation={orientation}
      data-slot="button-group"
      role="group"
      {...props}
    />
  );
}

export { ButtonGroup };
