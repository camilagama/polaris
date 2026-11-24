import { Button } from "@/ui/button";
import { TextLink } from "@/ui/text-link";
import type { HistoryView } from "./sale-history-model";

type EmptyView = Extract<HistoryView, { kind: "empty" }>;

/**
 * The sentence of a history with no sales, for the notice of the frame. With filters on, "Limpar filtros" is the way
 * out: the sentence alone made the person find the pills and take them out one by one.
 */
export function HistoryEmptyCard({
  onClearFilters,
  view,
}: {
  onClearFilters: () => void;
  view: EmptyView;
}) {
  return (
    <>
      <p className="text-muted-foreground">
        {view.message}
        {view.href ? (
          <>
            {" "}
            <TextLink href={view.href}>Registrar uma venda</TextLink>
          </>
        ) : null}
      </p>
      {view.clearFilters ? (
        <Button onClick={onClearFilters} type="button" variant="outline">
          Limpar filtros
        </Button>
      ) : null}
    </>
  );
}
