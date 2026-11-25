import type * as React from "react";
import { cn } from "@/lib/utils";
import { Checkbox } from "./checkbox";
import { Label } from "./label";

type CheckableOptionProps = Omit<React.ComponentProps<"label">, "onChange"> & {
  checked: boolean;
  disabled?: boolean | undefined;
  onCheckedChange: (checked: boolean) => void;
};

/**
 * One choice among several that can all be on (the variants an image belongs to): a checkbox and its text inside a
 * 1 px border, the whole row being the target. The text is the name of the checkbox, so the label is the row.
 */
function CheckableOption({
  checked,
  children,
  className,
  disabled,
  onCheckedChange,
  ...props
}: CheckableOptionProps) {
  return (
    <Label
      className={cn(
        "group/option min-h-ctl-md rounded-md border border-border px-3 has-disabled:cursor-not-allowed",
        className
      )}
      data-slot="checkable-option"
      {...props}
    >
      <Checkbox
        checked={checked}
        disabled={disabled ?? false}
        onCheckedChange={onCheckedChange}
      />
      <span className="[overflow-wrap:anywhere] group-has-disabled/option:opacity-50">
        {children}
      </span>
    </Label>
  );
}

export { CheckableOption };
