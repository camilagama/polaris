import { cn } from "@/lib/utils";
import { HelpTip } from "./help-tip";
import { MoneyText } from "./hidden-values";
import { Skeleton } from "./skeleton";

interface ListTotalFooterProps {
  className?: string | undefined;
  /** "14 vendas": what the total counts. Empty while it is unknown. */
  count: string;
  help?: { about: string; text: string } | undefined;
  label?: string | undefined;
  /** Empty keeps the line in the DOM, so the height does not move. */
  note?: string;
  notice?: string | undefined;
  /** "R$ 1.454,41", or a dash or an ellipsis while it is unknown; masked with the other values. */
  value: string | null;
  valueLoading?: boolean | undefined;
}

function FooterNotes({
  note,
  notice,
}: {
  note: string | undefined;
  notice: string | undefined;
}) {
  if (notice === undefined) {
    return note === undefined ? null : (
      <p
        className="min-h-5 text-muted-foreground text-support"
        data-list-total-note=""
      >
        {note}
      </p>
    );
  }
  // With `notice` a string (empty included) the status region stays mounted:
  // a live region that is already in the tree is what makes the screen reader
  // announce the money warning when it arrives. The warning takes the note
  // line while that line is empty and fits on one line; with a note it is
  // one extra line above it.
  return (
    <div
      className="grid min-h-5 text-muted-foreground text-support"
      data-list-total-note=""
    >
      <p role="status">{notice}</p>
      {note === undefined ? null : <p>{note}</p>}
    </div>
  );
}

/** Holds the last word and the (i) together, so a broken label never leaves the (i) alone on a line. */
function FooterLabel({
  help,
  label,
}: {
  help: ListTotalFooterProps["help"];
  label: string;
}) {
  if (help === undefined) {
    return label;
  }
  const cut = label.lastIndexOf(" ");
  return (
    <>
      {cut < 0 ? "" : `${label.slice(0, cut)} `}
      <span className="whitespace-nowrap">
        {cut < 0 ? label : label.slice(cut + 1)}
        <HelpTip about={help.about} className="ml-1 align-middle">
          {help.text}
        </HelpTip>
      </span>
    </>
  );
}

/**
 * The foot of a list: the total of what is on the screen, the figures right-aligned in tabular numerals so the
 * column of the rows above reads straight down to it. The box has the same height with and without rows (the lines
 * keep a minimum), so a filter that empties the list does not move what comes after. Narrower than 19 rem (the width
 * the list gives the foot: a 320 px window at the default font, and wider ones as the browser font grows) the count
 * and the total stack, the total under the count and as wide as the box, instead of one cutting the other. The width
 * is measured on a wrapper with no padding, so the foot with a padding on the right (under the figures of the rows)
 * and the one without it, the same list with and without rows, stack at the same width; the wrapper also makes the
 * foot take the width the list gives it, not the one its contents ask for.
 */
export function ListTotalFooter({
  className,
  count,
  help,
  label = "Total na tela",
  note,
  notice,
  value,
  valueLoading = false,
}: ListTotalFooterProps) {
  return (
    <div className="@container">
      <div
        className={cn(
          "grid gap-0.5 bg-muted/30 px-2.5 py-3 md:px-4",
          className
        )}
        data-list-total=""
      >
        <div className="flex @max-[18.999rem]:grid @max-[18.999rem]:grid-cols-[minmax(0,1fr)] items-end justify-between gap-x-4 @max-[18.999rem]:gap-y-1">
          <div className="grid min-w-0 gap-0.5">
            <p className="font-medium text-muted-foreground text-support">
              <FooterLabel help={help} label={label} />
            </p>
            <p className="min-h-5 @max-[18.999rem]:whitespace-normal whitespace-nowrap text-muted-foreground text-support">
              {count}
            </p>
          </div>
          <div className="@max-[18.999rem]:whitespace-normal whitespace-nowrap text-right font-semibold text-value-md tabular-nums @max-[18.999rem]:[overflow-wrap:anywhere]">
            {valueLoading ? <span className="sr-only">Lendo…</span> : null}
            {valueLoading ? (
              <Skeleton
                aria-hidden="true"
                className="ml-auto h-6 w-28 max-w-full"
                data-list-total-skeleton=""
              />
            ) : null}
            {value === null || valueLoading ? null : <MoneyText text={value} />}
          </div>
        </div>
        <FooterNotes note={note} notice={notice} />
      </div>
    </div>
  );
}
