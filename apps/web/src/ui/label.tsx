import type * as React from "react";
import { cn } from "@/lib/utils";

/* A label that holds a disabled control (the root of the Base UI check box, radio and switch is a span, so
   `peer-disabled` never matches a child) fades as a whole through `has-data-disabled`; the control then stays at 1
   (`group-has-data-disabled/label:opacity-100!` in checkbox, radio and switch), so the two never multiply to 25%. */
function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control comes through the props (htmlFor or a child)
    <label
      className={cn(
        "group/label flex select-none items-center gap-2 font-medium text-sm leading-5 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 has-data-disabled:opacity-50 group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50",
        className
      )}
      data-slot="label"
      {...props}
    />
  );
}

export { Label };
