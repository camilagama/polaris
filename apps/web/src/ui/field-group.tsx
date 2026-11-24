import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The fields of one part of a form, set apart inside a dialog or a card: a `fieldset` with a 1 px border, rounded, no
 * fill. The name of the group is a `FieldLegend` child, which the screen reader reads before each field. A block of
 * data that is only read is `InsetBlock`.
 */
function FieldGroup({ className, ...props }: React.ComponentProps<"fieldset">) {
  return (
    <fieldset
      className={cn(
        "grid min-w-0 gap-3 rounded-lg border border-border p-3",
        className
      )}
      data-slot="field-group"
      {...props}
    />
  );
}

export { FieldGroup };
