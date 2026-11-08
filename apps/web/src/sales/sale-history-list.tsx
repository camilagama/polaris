import ChevronRightIcon from "lucide-react/dist/esm/icons/chevron-right";
import type { ReactNode } from "react";
import { Badge } from "@/ui/badge";
import { Card } from "@/ui/card";
import { Money } from "@/ui/money";
import type { HistoryRow } from "./sale-history-model";

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

/**
 * Narrower than 17.9 rem the row stops being one line of cells: the data take the full width, wrapping instead of
 * being cut, and the value goes under them, beside the chevron. The width is the row's own (`@container` on the
 * `li`) and in `rem`, so a bigger browser font reaches it on a wider window. A 320 px window at the default font is
 * 18 rem of row, the narrowest width the one-line layout is proven at (the name is cut first, then the method; the
 * date and time stay whole), so it keeps that layout; at 20 px the same window is about 14 rem and wraps. From
 * 20.5 rem (360 px, default font) up the avatar column fits and nothing wraps.
 */
const ROW =
  "flex items-center gap-2 px-2.5 py-2.5 md:gap-3 md:px-4 @max-[17.9rem]:flex-wrap";
const WRAPPED_DATA = "@max-[17.9rem]:basis-full @max-[17.9rem]:flex-none";
const WRAPPED_LINE =
  "@max-[17.9rem]:block @max-[17.9rem]:[&>span]:inline @max-[17.9rem]:[&_span]:overflow-visible @max-[17.9rem]:[&_span]:whitespace-normal @max-[17.9rem]:[&_span]:[overflow-wrap:anywhere]";

function RowBody({ chevron, row }: { chevron: boolean; row: HistoryRow }) {
  return (
    <>
      <span
        aria-hidden="true"
        className="@max-[17.9rem]:hidden hidden size-8 shrink-0 place-items-center rounded-full bg-muted font-medium text-muted-foreground text-xs md:size-9 min-[22.5rem]:grid"
      >
        {row.customerInitials}
      </span>
      <div
        className={`grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-0.5 overflow-hidden ${WRAPPED_DATA}`}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="@max-[17.9rem]:whitespace-normal whitespace-nowrap font-medium">
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
        <p
          className={`flex min-w-0 text-muted-foreground text-support ${WRAPPED_LINE}`}
        >
          <span className="min-w-[5ch] truncate">{row.customerText}</span>
          <span className="flex max-w-[calc(100%_-_5ch)] shrink-0 whitespace-pre">
            <span className="overflow-hidden text-ellipsis">{` · ${row.methodText}`}</span>
            <span className="shrink-0">{` · ${row.itemCountText}`}</span>
          </span>
        </p>
      </div>
      <Money
        className="@max-[17.9rem]:ml-auto shrink-0 font-semibold tracking-tight md:text-value-md"
        size="sm"
        text={row.totalText}
      />
      {chevron ? (
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground md:size-4"
        />
      ) : null}
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
    <li className="@container">
      {offline ? (
        <div className={ROW}>
          <RowBody chevron={false} row={row} />
        </div>
      ) : (
        <a
          className={`${ROW} focus-ring hover:bg-muted/50 focus-visible:-outline-offset-3`}
          href={row.detailHref}
        >
          <RowBody chevron row={row} />
        </a>
      )}
    </li>
  );
}

/** Newest first, one card with a line per sale (the pattern of the products list). */
export function SaleHistoryList({
  footer,
  offline,
  rows,
}: {
  footer?: ReactNode;
  offline: boolean;
  rows: readonly HistoryRow[];
}) {
  return (
    <Card className="gap-0 py-0">
      <ul aria-label="Vendas" className="divide-y divide-border">
        {rows.map((row) => (
          <HistoryItem key={row.id} offline={offline} row={row} />
        ))}
      </ul>
      {footer}
    </Card>
  );
}
