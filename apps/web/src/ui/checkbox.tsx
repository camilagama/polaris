import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import CheckIcon from "lucide-react/dist/esm/icons/check";
import { cn } from "@/lib/utils";

/* Polaris v5.1: 16 px (18 with touch), a 48 × 48 touch area through ::after, focus as a border and a 30% halo,
   the mark in --primary. */
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        "peer relative flex size-4 touch:size-[18px] shrink-0 items-center justify-center rounded-[4px] border border-input outline-none motion-full:transition-colors after:absolute after:-inset-2 touch:after:-inset-4 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 group-has-[:focus-visible]/field-label:ring-0! aria-invalid:border-destructive data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground group-data-[disabled=true]/field:opacity-50 dark:bg-input/30 dark:data-checked:bg-primary",
        className
      )}
      data-slot="checkbox"
      {...props}
    >
      <CheckboxPrimitive.Indicator
        className="grid place-content-center text-current transition-none [&>svg]:size-3"
        data-slot="checkbox-indicator"
      >
        <CheckIcon aria-hidden="true" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
