import { cva, type VariantProps } from "class-variance-authority";
import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { Label } from "@/ui/label";

/* Polaris v5.1: label 14/20, 6 px from label to control, help and error in 13/18 (the error weighs 500 and carries
   an icon, so color is never the only signal). A checked choice card has a `foreground/70` border and a
   `foreground/10` ring. */
function FieldSet({
  className,
  gap = "4",
  ...props
}: React.ComponentProps<"fieldset"> & { gap?: "3" | "4" }) {
  return (
    <fieldset
      className={cn(
        "flex min-w-0 flex-col has-[>[data-slot=radio-group]]:gap-3",
        gap === "3" ? "gap-3" : "gap-4",
        className
      )}
      data-slot="field-set"
      {...props}
    />
  );
}

const legendSpace = { default: "mb-1.5", loose: "mb-3", none: "mb-0" } as const;

function FieldLegend({
  className,
  space = "default",
  variant = "legend",
  ...props
}: React.ComponentProps<"legend"> & {
  /** The space under the legend: 6 px, none, or 12 px. */
  space?: keyof typeof legendSpace;
  variant?: "legend" | "label";
}) {
  return (
    <legend
      className={cn(
        "font-medium data-[variant=label]:text-sm data-[variant=legend]:text-section",
        legendSpace[space],
        className
      )}
      data-slot="field-legend"
      data-variant={variant}
      {...props}
    />
  );
}

/* What a screen changes is a variant, not a class (the classes are not merged, t320): `width` (the field takes the
   row, or only what it needs), `gap` (6 px, or 16 px beside a check box) and, in a horizontal field, `align`
   (centered, or from the top for a control beside a text of several lines). */
const fieldVariants = cva(
  "group/field flex data-[invalid=true]:text-foreground",
  {
    compoundVariants: [
      { align: "center", class: "items-center", orientation: "horizontal" },
      { align: "start", class: "items-start", orientation: "horizontal" },
    ],
    defaultVariants: {
      align: "center",
      gap: "default",
      orientation: "vertical",
      width: "full",
    },
    variants: {
      align: {
        center: "",
        start: "",
      },
      gap: {
        default: "gap-1.5",
        wide: "gap-4",
      },
      orientation: {
        horizontal:
          "flex-row has-[>[data-slot=field-content]]:items-start *:data-[slot=field-label]:flex-auto has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
        vertical: "flex-col *:w-full [&>.sr-only]:w-auto",
      },
      width: {
        auto: "w-auto",
        full: "w-full",
      },
    },
  }
);

/* A label, its control and their texts. No role (the registry gives it "group"): one control is no group of
   controls, and a choice card would announce a nameless group inside its label. */
function Field({
  align,
  className,
  gap,
  orientation = "vertical",
  width,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof fieldVariants>) {
  return (
    <div
      className={cn(
        fieldVariants({ align, gap, orientation, width }),
        className
      )}
      data-orientation={orientation}
      data-slot="field"
      {...props}
    />
  );
}

function FieldContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "group/field-content flex flex-1 flex-col gap-0.5 leading-snug",
        className
      )}
      data-slot="field-content"
      {...props}
    />
  );
}

/* Around a `Field` it becomes a choice card: the whole card is the target and shows the focus outline. */
function FieldLabel({
  className,
  plain = false,
  ...props
}: React.ComponentProps<"label"> & { plain?: boolean }) {
  return (
    <Label
      className={cn(
        "group/field-label peer/field-label w-fit has-[>[data-slot=field]]:has-[:focus-visible]:outline-3 has-[>[data-slot=field]]:has-[:focus-visible]:outline-ring has-[>[data-slot=field]]:has-[:focus-visible]:outline-offset-2 has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col has-[>[data-slot=field]]:rounded-md has-[>[data-slot=field]]:border has-data-checked:border-foreground/70 has-[>[data-slot=field]]:bg-card has-data-checked:ring-1 has-data-checked:ring-foreground/10 has-[>[data-slot=field]]:transition-[border-color,box-shadow] has-[>[data-slot=field]]:not-has-[:disabled,[data-disabled]]:hover:border-input *:data-[slot=field]:px-3 *:data-[slot=field]:py-2 group-data-[disabled=true]/field:opacity-50",
        className
      )}
      data-slot="field-label"
      leading={plain ? "5" : "snug"}
      plain={plain}
      {...props}
    />
  );
}

/* The title of a choice card: the text of the label, without being a second <label>. */
function FieldTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex w-fit items-center gap-2 font-medium text-sm leading-5 group-data-[disabled=true]/field:opacity-50",
        className
      )}
      data-slot="field-label"
      {...props}
    />
  );
}

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn(
        "text-left font-normal text-muted-foreground text-support group-has-data-horizontal/field:text-balance [[data-variant=legend]+&]:-mt-1.5",
        "nth-last-2:-mt-1 last:mt-0",
        "[&>a]:underline [&>a]:underline-offset-4",
        className
      )}
      data-slot="field-description"
      {...props}
    />
  );
}

/* The error of a field: `role="alert"`, as the field errors of the sale today, with an icon besides the color.
   Renders nothing without a message. */
function FieldError({
  children,
  className,
  ...props
}: React.ComponentProps<"div">) {
  if (!children) {
    return null;
  }
  return (
    <div
      className={cn(
        "flex items-start gap-1.5 font-medium text-destructive text-support",
        className
      )}
      data-slot="field-error"
      role="alert"
      {...props}
    >
      <CircleAlertIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
};
