import type * as React from "react";
import { cn } from "@/lib/utils";

/* The label is a medium line of 20 px (`leading="5"`), or a line of plain text (`plain`: the label of a check box
   with a sentence, regular weight, in a block). `leading="snug"` is the label of a choice card. These are props, not
   classes of the caller: the classes are not merged (t320). */
function Label({
  className,
  leading = "5",
  plain = false,
  ...props
}: React.ComponentProps<"label"> & {
  leading?: "5" | "snug";
  plain?: boolean;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control comes through the props (htmlFor or a child)
    <label
      className={cn(
        "select-none items-center gap-2 text-sm peer-disabled:cursor-not-allowed peer-disabled:opacity-50 group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50",
        plain ? "block font-normal" : "flex font-medium",
        leading === "5" ? "leading-5" : "leading-snug",
        className
      )}
      data-slot="label"
      {...props}
    />
  );
}

export { Label };
