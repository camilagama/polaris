import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/* Polaris v5.1: heights from the --h-* tokens (`h-ctl-*`: 32/28/24 with a mouse, 36/32/28 with touch; lg 36/40),
   a 48 px touch area through `touch-hit`, focus as a 3 px outline (`focus-ring`). */
const buttonVariants = cva(
  "group/button touch-hit focus-ring inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent font-medium text-sm transition-[background-color,border-color,color,box-shadow,transform] active:not-aria-[haspopup]:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default:
          "h-ctl-md px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        icon: "size-ctl-md",
        "icon-lg": "size-ctl-lg",
        "icon-sm": "size-ctl-sm [&_svg:not([class*='size-'])]:size-3.5",
        "icon-xs": "size-ctl-xs [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-ctl-lg px-4 has-data-[icon=inline-end]:pr-3.5 has-data-[icon=inline-start]:pl-3.5",
        sm: "h-ctl-sm gap-1 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-ctl-xs gap-1 px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[inset_0_1px_0_var(--btn-shine),0_1px_2px_var(--btn-drop)] hover:bg-primary/88",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/15 dark:bg-destructive/15 dark:hover:bg-destructive/20",
        ghost: "text-foreground hover:bg-accent aria-expanded:bg-accent",
        link: "h-auto rounded-sm px-0 text-foreground underline decoration-input underline-offset-4 hover:decoration-foreground",
        outline:
          "border-border bg-card text-foreground shadow-xs hover:bg-accent aria-expanded:bg-accent dark:bg-secondary/60 dark:hover:bg-accent",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-accent aria-expanded:bg-accent",
      },
    },
  }
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      className={cn(buttonVariants({ className, size, variant }))}
      data-slot="button"
      {...props}
    />
  );
}

export { Button };
