import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/* Polaris v5.1: a 20 px pill. Only the variants the screens use: `outline` (synced, sending), `warning` (offline),
   `destructive` (needs attention), and for the state of a goal `secondary` (in progress) and `ink` (reached).
   A badge is never the only signal: an icon and a text go with the color. */
const badgeVariants = cva(
  "group/badge focus-ring inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border px-2 font-medium text-xs transition-colors has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    defaultVariants: {
      variant: "outline",
      wrap: false,
    },
    variants: {
      variant: {
        destructive:
          "border-transparent bg-destructive/10 text-destructive dark:bg-destructive/15",
        ink: "border-transparent bg-primary text-primary-foreground",
        outline: "border-border bg-card text-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        warning: "border-warning/30 bg-warning/10 text-warning",
      },
      /* one line of 20 px (the pill), or a text that may take more lines (`wrap`: the height grows from 20 px) */
      wrap: {
        false: "h-5 whitespace-nowrap leading-none",
        true: "h-auto min-h-5 whitespace-normal leading-4",
      },
    },
  }
);

function Badge({
  className,
  variant = "outline",
  wrap = false,
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant, wrap }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  });
}

export { Badge };
