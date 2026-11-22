import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one component that writes a number that is not an amount in reais (a quantity, a stock, a percent, a count, a
 * rate, a term in days): Geist Mono, whose digits all advance the same, with `tabular-nums`, so a column reads down its
 * digits. It takes the size of the line it is in. `align="end"` is for the cell of a column of figures; a number inside a
 * sentence ("3 vendas hoje") and a date, a time, a phone or a document stay in Geist and do not come through here.
 */
interface FigureProps {
  align?: "end" | "start" | undefined;
  children: ReactNode;
  className?: string | undefined;
}

export function Figure({ align = "start", children, className }: FigureProps) {
  return (
    <span
      className={cn(
        "whitespace-nowrap font-mono tabular-nums",
        align === "end" && "block text-right",
        className
      )}
      data-figure=""
    >
      {children}
    </span>
  );
}
