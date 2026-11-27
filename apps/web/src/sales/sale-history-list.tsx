import ChevronRightIcon from "lucide-react/dist/esm/icons/chevron-right";
import type { ReactElement, ReactNode } from "react";
import { Badge } from "@/ui/badge";
import { ListBlock } from "@/ui/list-block";
import { Money } from "@/ui/money";
import { Skeleton } from "@/ui/skeleton";
import { isPlainClick } from "../lib/plain-click";
import type { HistoryRow } from "./sale-history-model";

/**
 * The status of a sale, as the badges of the history and of the detail write it. With `commonStateAsText` (the list)
 * the ordinary state, confirmed, is not a badge: nearly every row is confirmed, so the same badge on all of them hides
 * the few that are not. It stays in the row's accessible name as text for the screen reader only, in the same place
 * the badge was.
 */
export function SaleStatusBadges({
  backdated = false,
  commonStateAsText = false,
  returnsBadge,
  statusLabel,
  statusTone,
}: {
  backdated?: boolean;
  commonStateAsText?: boolean;
  returnsBadge: string | null;
  statusLabel: string;
  statusTone: "cancelled" | "confirmed";
}) {
  const common = commonStateAsText && statusTone === "confirmed";
  return (
    <>
      {common ? (
        <span className="sr-only">{statusLabel}</span>
      ) : (
        <Badge variant={statusTone === "cancelled" ? "destructive" : "outline"}>
          {statusLabel}
        </Badge>
      )}
      {returnsBadge ? <Badge variant="warning">{returnsBadge}</Badge> : null}
      {backdated ? <Badge variant="outline">Retroativa</Badge> : null}
    </>
  );
}

/**
 * The line of the customer and the method wraps instead of cutting: the method (and the count) move under the name
 * when they do not fit beside it, and only the end of a name wider than the line gets an ellipsis. The date and the
 * time wrap the same way, the time as one piece. Narrower than 17.9 rem the row stops being one line of cells: the
 * data take the full width, nothing is cut, and the value goes under them, beside the chevron. The width is the row's
 * own (`@container` on the `li`) and in `rem`, so a bigger browser font reaches it on a wider window. A 320 px window
 * at the default font is 18 rem of row and keeps the layout beside the value; at 20 px the same window is about 14 rem
 * and wraps. From 20.5 rem (360 px, default font) up the avatar column fits.
 *
 * A sale paid in two parts always puts the methods and the count on the line under the name, with no "·" after the
 * name: both methods ("Pix + Crédito") are what tells it from a sale of one part, so they are never left to share a
 * line with a name that can cut them.
 */
const ROW =
  "flex items-center gap-2 px-2.5 py-2.5 md:gap-3 md:px-4 @max-[17.9rem]:flex-wrap";
const WRAPPED_DATA = "@max-[17.9rem]:basis-full @max-[17.9rem]:flex-none";
const WRAPPED_LINE =
  "@max-[17.9rem]:block @max-[17.9rem]:[&>span]:inline @max-[17.9rem]:[&_span]:overflow-visible @max-[17.9rem]:[&_span]:whitespace-normal @max-[17.9rem]:[&_span]:[overflow-wrap:anywhere]";
const SPLIT_METHODS_LINE = "@max-[17.9rem]:[&>span:last-child]:block";

function RowBody({ chevron, row }: { chevron: boolean; row: HistoryRow }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={`@max-[17.9rem]:hidden hidden size-8 shrink-0 place-items-center rounded-full font-medium text-muted-foreground text-xs md:size-9 min-[22.5rem]:grid ${row.customerInitials ? "bg-muted" : ""}`}
      >
        {row.customerInitials}
      </span>
      <div
        className={`grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-0.5 overflow-hidden ${WRAPPED_DATA}`}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="font-medium">
            {row.dateText}
            {row.timeText ? (
              <>
                {" "}
                <span className="whitespace-nowrap font-normal text-muted-foreground tabular-nums">
                  · {row.timeText}
                </span>
              </>
            ) : null}
          </p>
          <SaleStatusBadges
            backdated={row.backdated}
            commonStateAsText
            returnsBadge={row.returnsBadge}
            statusLabel={row.statusLabel}
            statusTone={row.statusTone}
          />
        </div>
        <p
          className={`flex min-w-0 flex-wrap gap-x-1 text-muted-foreground text-support ${row.splitPayment ? `${WRAPPED_LINE} ${SPLIT_METHODS_LINE}` : WRAPPED_LINE}`}
        >
          <span className="flex min-w-0 max-w-full">
            <span className="truncate">{row.customerText}</span>
          </span>{" "}
          <span
            className={
              row.splitPayment
                ? "min-w-0 max-w-full basis-full"
                : "min-w-0 max-w-full"
            }
          >
            {row.splitPayment ? null : "·\u00A0"}
            {`${row.methodText} ·\u00A0${row.itemCountText}`}
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
          className="size-4 shrink-0 text-muted-foreground"
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
function HistoryItem({
  offline,
  onOpen,
  row,
}: {
  offline: boolean;
  onOpen?: ((saleId: string) => void) | undefined;
  row: HistoryRow;
}) {
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
          onClick={
            onOpen === undefined
              ? undefined
              : (event) => {
                  if (isPlainClick(event)) {
                    onOpen(row.id);
                  }
                }
          }
        >
          <RowBody chevron row={row} />
        </a>
      )}
    </li>
  );
}

/** The title of the history's frame: the period is what the screen is about, the filters narrow it. */
const HISTORY_LIST_TITLE = "Vendas do período";

/** The shape of a row while the list loads: the date and the line under it. */
function HistoryRowShape() {
  return (
    <div className="grid gap-1.5">
      <Skeleton className="h-3.5 w-2/3" />
      <Skeleton className="h-3 w-1/3" />
    </div>
  );
}

type HistoryNoRows =
  | { state: "loading" }
  | { notice: ReactNode; state: "filtered-empty" };

/**
 * The frame of a history with no rows to draw: the skeleton while it loads, or the sentence of a list with no sales,
 * and the total always last. `total` is a `ListBlock.Total` element: the frame only takes it as the total when it is
 * one of its direct children.
 */
export function SaleHistoryNoRows({
  count,
  total,
  ...body
}: HistoryNoRows & { count: string; total: ReactElement }) {
  if (body.state === "loading") {
    return (
      <ListBlock
        count={count}
        skeleton={<HistoryRowShape />}
        state="loading"
        title={HISTORY_LIST_TITLE}
      >
        {total}
      </ListBlock>
    );
  }
  return (
    <ListBlock
      count={count}
      emptyNotice={body.notice}
      state="filtered-empty"
      title={HISTORY_LIST_TITLE}
    >
      {total}
    </ListBlock>
  );
}

/** Newest first, one line per sale in the frame of the history, and the total (a `ListBlock.Total`) as the last line. */
export function SaleHistoryList({
  count = "",
  footer,
  offline,
  onOpen,
  rows,
}: {
  count?: string;
  footer?: ReactElement | undefined;
  offline: boolean;
  onOpen?: ((saleId: string) => void) | undefined;
  rows: readonly HistoryRow[];
}) {
  return (
    <ListBlock count={count} state="rows" title={HISTORY_LIST_TITLE}>
      {rows.map((row) => (
        <HistoryItem key={row.id} offline={offline} onOpen={onOpen} row={row} />
      ))}
      {footer}
    </ListBlock>
  );
}
