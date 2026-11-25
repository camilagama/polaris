import type { ReactNode } from "react";

/**
 * The 36 px square of a configuration row (Aparelhos, Formas de receber): the 16 px icon of what the row is, only
 * decoration, since the name already says it. A person is a circle of initials instead (Clientes).
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
