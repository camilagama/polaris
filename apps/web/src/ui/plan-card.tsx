import type { MouseEvent } from "react";
import { buttonVariants } from "./button";
import { Card } from "./card";

/**
 * The strip of the card: bars that grow, in the muted tone, the last one in ink at low opacity. Tokens only, no
 * gradient and no bitmap, and nothing for a reader: the words say it all. A window shorter than 56 rem leaves it out,
 * so the destinations of the column keep their room.
 */
function PlanCardArt() {
  return (
    <svg
      aria-hidden="true"
      className="hidden h-10 w-full [@media(min-height:56rem)]:block"
      data-plan-card-art=""
      focusable="false"
      preserveAspectRatio="xMidYMid slice"
      viewBox="0 0 224 40"
    >
      <rect className="fill-muted" height="40" width="224" />
      <rect
        className="fill-foreground/10"
        height="12"
        rx="2"
        width="22"
        x="60"
        y="28"
      />
      <rect
        className="fill-foreground/10"
        height="18"
        rx="2"
        width="22"
        x="90"
        y="22"
      />
      <rect
        className="fill-foreground/10"
        height="26"
        rx="2"
        width="22"
        x="120"
        y="14"
      />
      <rect
        className="fill-primary/25"
        height="34"
        rx="2"
        width="22"
        x="150"
        y="6"
      />
    </svg>
  );
}

/** The thin bar of the use: only drawn (the number is written above it), never past full. */
function PlanCardBar({ share }: { share: number }) {
  return (
    <span
      aria-hidden="true"
      className="block h-1 overflow-hidden rounded-full bg-muted"
      data-plan-card-bar=""
    >
      <span
        className="block h-full rounded-full bg-primary"
        style={{ width: `${Math.min(Math.max(share, 0), 1) * 100}%` }}
      />
    </span>
  );
}

/**
 * The card of the plan at the foot of the menu: the use in words with a thin bar under it, what the plan above adds
 * and a button of outline (the brand red is only for the mark dot and "where you are") that is a link. `art` is
 * the strip of the desktop; the phone's card is the compact one, without it. Nothing closes it.
 */
export function PlanCard({
  art,
  buttonLabel,
  href,
  onOpen,
  pitch,
  usage,
}: {
  art: boolean;
  buttonLabel: string;
  href: string;
  onOpen?: (event: MouseEvent<HTMLAnchorElement>) => void;
  pitch: string;
  /** The sentence of the use and the share of the limit it fills; null when the numbers are not known. */
  usage: { share: number; text: string } | null;
}) {
  return (
    <Card className="gap-0 bg-background py-0" data-plan-card="">
      {art ? <PlanCardArt /> : null}
      <div className="grid gap-2 p-3 [@media(min-width:47.5rem)_and_(max-height:45rem)]:gap-1.5 [@media(min-width:47.5rem)_and_(max-height:45rem)]:p-2">
        {usage === null ? null : (
          <div className="grid gap-1.5">
            <p className="text-foreground text-sm">{usage.text}</p>
            <PlanCardBar share={usage.share} />
          </div>
        )}
        <p className="text-muted-foreground text-xs [@media(min-width:47.5rem)_and_(max-height:45rem)]:hidden">
          {pitch}
        </p>
        <a
          className={buttonVariants({
            className: "w-full",
            size: "sm",
            variant: "outline",
          })}
          href={href}
          onClick={onOpen}
        >
          {buttonLabel}
        </a>
      </div>
    </Card>
  );
}
