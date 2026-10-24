import { Badge } from "@/ui/badge";
import { Card } from "@/ui/card";
import type { HistoryRow } from "./sale-history-model";
import { Money } from "./sale-summary-panel";

/** The status of a sale, as the badges of the history and of the detail write it. */
export function SaleStatusBadges({
  backdated = false,
  returnsBadge,
  statusLabel,
  statusTone,
}: {
  backdated?: boolean;
  returnsBadge: string | null;
  statusLabel: string;
  statusTone: "cancelled" | "confirmed";
}) {
  return (
    <>
      <Badge variant={statusTone === "cancelled" ? "destructive" : "outline"}>
        {statusLabel}
      </Badge>
      {returnsBadge ? <Badge variant="warning">{returnsBadge}</Badge> : null}
      {backdated ? <Badge variant="outline">Retroativa</Badge> : null}
    </>
  );
}

const ROW = "flex items-center gap-3 px-3 py-2.5 md:px-4";

function RowBody({ row }: { row: HistoryRow }) {
  return (
    <>
      <span
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-full bg-muted font-medium text-muted-foreground text-xs"
      >
        {row.customerInitials}
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="font-medium">
            {row.dateText}
            {row.timeText ? (
              <span className="font-normal text-muted-foreground tabular-nums">
                {" "}
                · {row.timeText}
              </span>
            ) : null}
          </p>
          <SaleStatusBadges
            backdated={row.backdated}
            returnsBadge={row.returnsBadge}
            statusLabel={row.statusLabel}
            statusTone={row.statusTone}
          />
        </div>
        <p className="text-muted-foreground text-support [overflow-wrap:anywhere]">
          Cliente: {row.customerText}
        </p>
        <p className="text-muted-foreground text-support">
          {row.methodText} · {row.itemCountText}
        </p>
      </div>
      <Money
        className="shrink-0 font-semibold text-value-md tracking-tight"
        text={row.totalText}
      />
    </>
  );
}

/**
 * One sale. With a connection the whole row is the link to the detail (its touch area is the row, the focus ring
 * is drawn inside it because the card clips); without one there is no detail to open (it is read from the
 * server), so the row is plain text.
 */
function HistoryItem({ offline, row }: { offline: boolean; row: HistoryRow }) {
  return (
    <li>
      {offline ? (
        <div className={ROW}>
          <RowBody row={row} />
        </div>
      ) : (
        <a
          className={`${ROW} focus-ring hover:bg-muted/50 focus-visible:-outline-offset-3`}
          href={row.detailHref}
        >
          <RowBody row={row} />
        </a>
      )}
    </li>
  );
}

/** Newest first, one card with a line per sale (the pattern of the products list). */
export function SaleHistoryList({
  offline,
  rows,
}: {
  offline: boolean;
  rows: readonly HistoryRow[];
}) {
  return (
    <Card gap="none" pad="none">
      <ul aria-label="Vendas" className="divide-y divide-border">
        {rows.map((row) => (
          <HistoryItem key={row.id} offline={offline} row={row} />
        ))}
      </ul>
    </Card>
  );
}
