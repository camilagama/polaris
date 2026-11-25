import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "@/lib/utils";

/* `gap-3`: 12 px between choice cards (DESIGN.md), so the 44 px touch areas of two radios never overlap
   (the ui-guardrails check measures it). A group marked `aria-invalid` (the screen has no field to mark: the
   choice is the field) draws a destructive ring around the whole group and the destructive border of each radio,
   so the card is not painted: the message below the group says what is missing. The ring is an outline, which
   takes no space and leaves the layout alone. */
function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      className={cn(
        "group/radio-group grid w-full gap-3 rounded-lg aria-invalid:outline-2 aria-invalid:outline-destructive/50 aria-invalid:outline-offset-2",
        className
      )}
      data-slot="radio-group"
      {...props}
    />
  );
}

/* Polaris v5.1: 16 px (18 with touch), a 44 × 44 touch area through ::after (inside a choice card the whole card
   is a target too), focus as a border and a 30% halo. Inside a choice card the card draws the focus outline, so
   the halo of the radio steps back (as in the registry) instead of showing two rings; `!` because the group
   variant has the specificity of a single class and would lose to `focus-visible:ring-[3px]`. Disabled it fades by
   itself (`data-disabled`, the root is a span). The choice cards fade as a whole (`has-data-disabled:opacity-50` on
   their `FieldLabel`), so inside any `FieldLabel` it stays at 1 to keep the two from multiplying to 25% (`!` again,
   to win over `data-disabled`); a `FieldLabel` that holds a disabled radio must fade itself. */
function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      className={cn(
        "group/radio-group-item peer relative flex aspect-square size-4 touch:size-4.5 shrink-0 rounded-full border border-input outline-none motion-full:transition-colors after:absolute after:-inset-2 touch:after:-inset-3.5 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 group-has-data-disabled/field-label:opacity-100! group-has-[:focus-visible]/field-label:ring-0! aria-invalid:border-destructive group-aria-invalid/radio-group:border-destructive data-disabled:cursor-not-allowed data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-disabled:opacity-50 dark:bg-input/30 dark:data-checked:bg-primary",
        className
      )}
      data-slot="radio-group-item"
      {...props}
    >
      <RadioPrimitive.Indicator
        className="flex size-full items-center justify-center"
        data-slot="radio-group-indicator"
      >
        <span className="size-1.5 rounded-full bg-primary-foreground" />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
