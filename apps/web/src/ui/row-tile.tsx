import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The 36 px square of a configuration row (Aparelhos, Formas de receber): the 16 px icon of what the row is, only
 * decoration, since the name already says it. A person is a circle of initials instead (`RowInitials`).
 */
export function RowTile({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-9 shrink-0 place-items-center self-start rounded-md bg-muted text-muted-foreground [&>svg]:size-4"
      data-row-tile=""
    >
      {children}
    </span>
  );
}

/**
 * The 36 px circle of initials of a row (Clientes, Produtos, Histórico): decoration only, since the name beside it
 * already says who or what the row is. The screen passes only what is its own: alignment, or a size and a visibility
 * rule.
 */
export function RowInitials({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-full bg-muted font-medium text-muted-foreground text-xs",
        className
      )}
      data-row-initials=""
    >
      {children}
    </span>
  );
}
