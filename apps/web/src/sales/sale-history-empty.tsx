import ShoppingBagIcon from "lucide-react/dist/esm/icons/shopping-bag";
import { Button, buttonVariants } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import type { HistoryView } from "./sale-history-model";

type EmptyView = Extract<HistoryView, { kind: "empty" }>;

/**
 * The sentence of a history whose filters left no sale, for the notice of the frame. "Limpar filtros" is the way out:
 * the sentence alone made the person find the pills and take them out one by one.
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
      <p className="text-muted-foreground" role="status">
        {view.message}
      </p>
      {view.clearFilters ? (
        <Button onClick={onClearFilters} type="button" variant="outline">
          Limpar filtros
        </Button>
      ) : null}
    </>
  );
}

/** A store with no sale and no filter on: only the empty state, with no frame and no total (zero over nothing says nothing). */
export function HistoryNothingYet({ view }: { view: EmptyView }) {
  return (
    <EmptyState
      afterRead
      icon={ShoppingBagIcon}
      title={view.message}
      {...(view.support === null ? {} : { support: view.support })}
    >
      {view.href ? (
        <a className={buttonVariants()} href={view.href}>
          Registrar uma venda
        </a>
      ) : null}
    </EmptyState>
  );
}
