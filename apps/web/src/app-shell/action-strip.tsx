import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * "⚠ Precisa de ação" under the title of a screen (Estoque, Pendências): the warning triangle, the name, and one line
 * with the numbers, each a link when it leads to a list. The block only holds what needs action; a screen with nothing
 * to do does not draw it.
 */
export function ActionStrip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border bg-card px-3 py-2.5 text-sm",
        className
      )}
      data-slot="action-strip"
    >
      <span className="inline-flex items-center gap-1.5 font-semibold">
        <TriangleAlertIcon
          aria-hidden="true"
          className="size-4 shrink-0 translate-y-0.5 text-warning"
        />
        Precisa de ação
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}
