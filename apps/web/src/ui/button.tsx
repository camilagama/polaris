import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/* Polaris v5.1: heights from the --h-* tokens (`h-ctl-*`: 32/28/24 with a mouse, 36/32/28 with touch; lg 36/40),
   a 48 px touch area through `touch-hit`, focus as a 3 px outline (`focus-ring`).
   No class of the base is repeated by a variant (the classes are not merged, t320): what changes with the size, the
   shape, the type size or the color is set by the variant of that axis alone. `shape` is `fixed` (one line, the
   height of the size), `wrap` (the text may take more lines: `wrap` prop) or `link` (the `link` variant). */
const SVG_4 = "[&_svg:not([class*='size-'])]:size-4";
const SVG_3_5 = "[&_svg:not([class*='size-'])]:size-3.5";

const buttonCva = cva(
  "group/button touch-hit focus-ring inline-flex select-none items-center justify-center border font-medium transition-[background-color,border-color,color,box-shadow,transform] active:not-aria-[haspopup]:scale-[0.98] disabled:pointer-events-none aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    compoundVariants: [
      { class: "h-ctl-md px-3", shape: "fixed", size: "default" },
      { class: "h-ctl-lg px-4", shape: "fixed", size: "lg" },
      { class: "h-ctl-sm px-2.5", shape: "fixed", size: "sm" },
      { class: "h-ctl-xs px-2", shape: "fixed", size: "xs" },
      { class: "h-auto min-h-ctl-md px-3", shape: "wrap", size: "default" },
      { class: "h-auto min-h-ctl-lg px-4", shape: "wrap", size: "lg" },
      { class: "h-auto min-h-ctl-sm px-2.5", shape: "wrap", size: "sm" },
      { class: "h-auto min-h-ctl-xs px-2", shape: "wrap", size: "xs" },
    ],
    defaultVariants: {
      busy: false,
      shape: "fixed",
      shrink: false,
      size: "default",
      text: "sm",
      variant: "default",
    },
    variants: {
      /* the opacity of a disabled button: 70% while it waits for an answer (the Google button), 50% otherwise */
      busy: {
        false: "disabled:opacity-50",
        true: "disabled:opacity-70",
      },
      shape: {
        fixed: "whitespace-nowrap rounded-md",
        link: "h-auto whitespace-nowrap rounded-sm px-0",
        wrap: "whitespace-normal rounded-md",
      },
      /* `shrink-0` unless the button is a flex item that gives way (a row of buttons that share the width) */
      shrink: {
        false: "shrink-0",
        true: "",
      },
      size: {
        default: `gap-1.5 ${SVG_4} has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5`,
        icon: `size-ctl-md gap-1.5 ${SVG_4}`,
        "icon-lg": `size-ctl-lg gap-1.5 ${SVG_4}`,
        "icon-sm": `size-ctl-sm gap-1.5 ${SVG_3_5}`,
        "icon-xs": `size-ctl-xs gap-1.5 ${SVG_3_5}`,
        lg: `gap-1.5 ${SVG_4} has-data-[icon=inline-end]:pr-3.5 has-data-[icon=inline-start]:pl-3.5`,
        sm: `gap-1 ${SVG_3_5} has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2`,
        xs: `gap-1 ${SVG_3_5} has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5`,
      },
      /* the type size: `sm` for every size but `xs`; `support` and `13` for the link in a line of help text */
      text: {
        "13": "text-[0.8125rem]",
        sm: "text-sm",
        support: "text-support",
        xs: "text-xs",
      },
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow-[inset_0_1px_0_var(--btn-shine),0_1px_2px_var(--btn-drop)] hover:bg-primary/88",
        destructive:
          "border-transparent bg-destructive/10 text-destructive hover:bg-destructive/15 dark:bg-destructive/15 dark:hover:bg-destructive/20",
        ghost:
          "border-transparent text-foreground hover:bg-accent aria-expanded:bg-accent",
        /* a ghost button in the muted color (the caller adds the color of the hover) and one in the destructive color */
        "ghost-destructive":
          "border-transparent text-destructive hover:bg-destructive/10 aria-expanded:bg-accent",
        "ghost-muted":
          "border-transparent text-muted-foreground hover:bg-accent aria-expanded:bg-accent",
        link: "border-transparent text-foreground underline decoration-input underline-offset-4 hover:decoration-foreground",
        outline:
          "border-border bg-card text-foreground shadow-xs hover:bg-accent aria-expanded:bg-accent dark:bg-secondary/60 dark:hover:bg-accent",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-accent aria-expanded:bg-accent",
      },
    },
  }
);

interface ButtonStyleProps {
  /** Waiting for an answer: the disabled button is at 70% instead of 50%. */
  busy?: boolean | undefined;
  size?: NonNullable<VariantProps<typeof buttonCva>["size"]>;
  /** The button gives way in a flex row (it is not `shrink-0`). */
  shrink?: boolean | undefined;
  /** The type size, when it is not the one of the size (`sm`, or `xs` for the `xs` size). */
  text?: "13" | "support" | undefined;
  variant?: NonNullable<VariantProps<typeof buttonCva>["variant"]>;
  /** The text may take more lines (the height grows from the one of the size). */
  wrap?: boolean | undefined;
}

function buttonVariants({
  busy = false,
  shrink = false,
  size = "default",
  text,
  variant = "default",
  wrap = false,
}: ButtonStyleProps = {}) {
  let shape: "fixed" | "link" | "wrap" = wrap ? "wrap" : "fixed";
  if (variant === "link") {
    shape = "link";
  }
  return buttonCva({
    busy,
    shape,
    shrink,
    size,
    text: text ?? (size === "xs" ? "xs" : "sm"),
    variant,
  });
}

function Button({
  busy,
  className,
  variant = "default",
  shrink,
  size = "default",
  text,
  wrap,
  ...props
}: ButtonPrimitive.Props & ButtonStyleProps) {
  return (
    <ButtonPrimitive
      className={cn(
        buttonVariants({ busy, shrink, size, text, variant, wrap }),
        className
      )}
      data-slot="button"
      {...props}
    />
  );
}

export { Button, buttonVariants };
