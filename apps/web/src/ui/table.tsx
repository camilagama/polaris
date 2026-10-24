import type * as React from "react";
import { cn } from "@/lib/utils";

/* What a screen changes in a part is a prop, not a class (the classes are not merged, t320): `hover` of a row,
   `align` of a head and the `vertical` alignment of a head or a cell. */

/* Polaris v5.1: header in 12 px muted, cell of 12 x 10, first and last column aligned to the gutter, hover on
   `muted/60`. The container scrolls sideways when the table is wider than the screen. */
function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      className="relative w-full overflow-x-auto"
      data-slot="table-container"
    >
      <table
        className={cn("w-full caption-bottom text-sm", className)}
        data-slot="table"
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      className={cn("[&_tr]:border-b", className)}
      data-slot="table-header"
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      className={cn("[&_tr:last-child]:border-0", className)}
      data-slot="table-body"
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      data-slot="table-footer"
      {...props}
    />
  );
}

function TableRow({
  className,
  hover = true,
  ...props
}: React.ComponentProps<"tr"> & {
  /** The row tints under the pointer; the head row does not. */
  hover?: boolean;
}) {
  return (
    <tr
      className={cn(
        "border-b transition-colors has-aria-expanded:bg-muted/60 data-[state=selected]:bg-muted",
        hover ? "hover:bg-muted/60" : "hover:bg-transparent",
        className
      )}
      data-slot="table-row"
      {...props}
    />
  );
}

/* `column` is the head of a column (12 px, muted, one line); `row` is the head of a row (14 px in the text color,
   it may take more lines and sits at the top of the row). */
function TableHead({
  align = "left",
  className,
  variant = "column",
  ...props
}: React.ComponentProps<"th"> & {
  align?: "left" | "right";
  variant?: "column" | "row";
}) {
  return (
    <th
      className={cn(
        "px-3 first:pl-4 last:pr-4 [&:has([role=checkbox])]:pr-0",
        align === "right" ? "text-right" : "text-left",
        variant === "row"
          ? "h-auto whitespace-normal align-top font-[weight:inherit] text-foreground text-sm"
          : "h-9 whitespace-nowrap align-middle font-medium text-muted-foreground text-xs",
        className
      )}
      data-slot="table-head"
      {...props}
    />
  );
}

function TableCell({
  className,
  vertical = "middle",
  ...props
}: React.ComponentProps<"td"> & { vertical?: "middle" | "top" }) {
  return (
    <td
      className={cn(
        "whitespace-nowrap px-3 py-2.5 first:pl-4 last:pr-4 [&:has([role=checkbox])]:pr-0",
        vertical === "top" ? "align-top" : "align-middle",
        className
      )}
      data-slot="table-cell"
      {...props}
    />
  );
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      className={cn("mt-4 text-muted-foreground text-support", className)}
      data-slot="table-caption"
      {...props}
    />
  );
}

export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
};
