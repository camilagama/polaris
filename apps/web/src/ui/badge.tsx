import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/* Polaris v5.1: a 20 px pill. Only the variants the screens use: `outline` (synced, sending), `warning` (offline),
   `destructive` (needs attention), and for the state of a goal `secondary` (in progress) and `ink` (reached).
   A badge is never the only signal: an icon and a text go with the color. */
const badgeVariants = cva(
  "group/badge focus-ring inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-full border border-transparent px-2 font-medium text-xs leading-none motion-full:transition-colors has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    defaultVariants: {
      variant: "outline",
    },
    variants: {
      variant: {
        destructive:
          "bg-destructive/10 text-destructive dark:bg-destructive/15",
        ink: "bg-primary text-primary-foreground",
        outline: "border-border bg-card text-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        warning: "border-warning/30 bg-warning/10 text-warning",
      },
    },
  }
);

function Badge({
  className,
  variant = "outline",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
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
