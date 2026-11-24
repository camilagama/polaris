import { Block, BlockHeader, BlockPanel } from "@/ui/block";
import type { SaleTimelineEvent } from "./sale-history-model";

/** Where the sale stands is the only dot with a color; the rest are the supporting gray. */
const DOT: Record<SaleTimelineEvent["tone"], string> = {
  cancelled: "bg-destructive",
  muted: "bg-muted-foreground",
  sale: "bg-chart-sales",
};

/** The line runs from the dot to the next one and stops at the last. */
const ITEM =
  "relative flex items-baseline justify-between gap-3 pb-3 pl-5 before:absolute before:top-3.5 before:-bottom-1.5 before:left-[0.21875rem] before:w-px before:bg-border last:pb-0 last:before:hidden";

/**
 * What happened to the sale and when, under the receipt. A sale with a single event has nothing to put in order, so
 * the section does not exist and the screen does not move. Every line is the word and the time: the dot is not read.
 */
export function SaleTimeline({
  events,
}: {
  events: readonly SaleTimelineEvent[];
}) {
  if (events.length < 2) {
    return null;
  }
  return (
    <Block aria-labelledby="sale-timeline-title">
      <BlockHeader id="sale-timeline-title" title="Linha do tempo" />
      <BlockPanel>
        <ol className="grid">
          {events.map((event) => (
            <li className={ITEM} key={event.key}>
              <span
                aria-hidden="true"
                className={`absolute top-1.5 left-0 size-2 rounded-full ${DOT[event.tone]}`}
              />
              <span>{event.label}</span>
              <span className="sr-only">, </span>
              <time
                className="shrink-0 text-muted-foreground text-xs tabular-nums"
                dateTime={event.at}
              >
                {event.timeText}
              </time>
            </li>
          ))}
        </ol>
      </BlockPanel>
    </Block>
  );
}
