import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import type { HistoryView } from "./sale-history-model";

type EmptyView = Extract<HistoryView, { kind: "empty" }>;

/**
 * Empty, in the same card the products and the stock use. With filters on, "Limpar filtros" is the way out: the
 * sentence alone made the person find the pills and take them out one by one.
 */
export function HistoryEmptyCard({
  onClearFilters,
  view,
}: {
  onClearFilters: () => void;
  view: EmptyView;
}) {
  return (
    <Card className="items-center px-(--card-spacing) text-center">
      <p className="text-muted-foreground">
        {view.message}
        {view.href ? (
          <>
            {" "}
            <a
              className="touch-hit focus-ring rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground"
              href={view.href}
            >
              Registrar uma venda
            </a>
          </>
        ) : null}
      </p>
      {view.clearFilters ? (
        <Button onClick={onClearFilters} type="button" variant="outline">
          Limpar filtros
        </Button>
      ) : null}
    </Card>
  );
}
