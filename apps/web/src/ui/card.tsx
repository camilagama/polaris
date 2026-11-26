import ArrowRightIcon from "lucide-react/dist/esm/icons/arrow-right";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "./button";

const CARD_SURFACE =
  "overflow-hidden rounded-xl text-card-foreground text-sm shadow-xs ring-1 ring-foreground/[0.06] dark:shadow-[inset_0_1px_0_var(--card-glow)]";

/* Polaris v5.1: 12 px of breathing room with touch, 16 with a mouse (`--card-spacing`); a 6% ring plus a short
   shadow, and in the dark theme a 1 px glow at the top (`--card-glow`, OKLCH). */
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "group/card flex flex-col gap-(--card-spacing) bg-card py-(--card-spacing) [--card-spacing:--spacing(3)] md:[--card-spacing:--spacing(4)]",
        CARD_SURFACE,
        className
      )}
      data-slot="card"
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "group/card-header grid auto-rows-min items-start gap-0.5 px-(--card-spacing) has-data-[slot=card-description]:grid-rows-[auto_auto]",
        className
      )}
      data-slot="card-header"
      {...props}
    />
  );
}

/* A div, as in the registry: when the title names a section of the screen, the screen gives it the heading role
   and level (`role="heading" aria-level={2}`). */
function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("text-section", className)}
      data-slot="card-title"
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("text-muted-foreground text-support", className)}
      data-slot="card-description"
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("px-(--card-spacing)", className)}
      data-slot="card-content"
      {...props}
    />
  );
}

/*
 * The framed card (Início blocks, from 760 px): a `--muted` frame with the title on it, the panel in `--card` inside
 * with a radius concentric to the frame's, and an optional foot on the frame. Under 760 px the frame is the plain card
 * above and the panel has no box of its own (no padding, fill or ring), so the screen keeps the box it had before.
 * `--card` against `--muted` does not reach 3:1 in either theme, so the panel carries a 1 px `--border` line.
 */
function CardFrame({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "group/card group/frame flex flex-col gap-(--card-spacing) bg-card px-(--card-spacing) py-(--card-spacing) [--card-spacing:--spacing(3)] [--frame-gap:--spacing(1)] md:gap-(--frame-gap) md:bg-muted md:p-(--frame-gap) md:[--card-spacing:--spacing(4)]",
        CARD_SURFACE,
        className
      )}
      data-slot="card-frame"
      {...props}
    />
  );
}

/** The title row of the frame: the title, its (i) and the header action; level with the content of the panel. */
function CardFrameHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 md:min-h-9 md:flex-nowrap md:px-[calc(var(--card-spacing)-var(--frame-gap))]",
        className
      )}
      data-slot="card-frame-header"
      {...props}
    />
  );
}

function CardFramePanel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-(--card-spacing) md:rounded-[calc(var(--radius-xl)-var(--frame-gap))] md:bg-card md:p-(--card-spacing) md:ring-1 md:ring-border",
        className
      )}
      data-slot="card-frame-panel"
      {...props}
    />
  );
}

/** One line on the frame under the panel, with one navigation link to the right; not there under 760 px. */
function CardFrameFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "hidden min-h-9 items-center justify-end px-[calc(var(--card-spacing)-var(--frame-gap))] md:flex",
        className
      )}
      data-slot="card-frame-footer"
      {...props}
    />
  );
}

/** The action of the foot: a text button (ghost, small) with a 16 px arrow, which steps 2 px toward the destination on a mouse (never on touch). */
function CardFrameLink({
  children,
  className,
  ...props
}: React.ComponentProps<"a">) {
  return (
    <a
      className={cn(
        buttonVariants({ size: "sm", variant: "ghost" }),
        "group/link",
        className
      )}
      data-slot="card-frame-link"
      {...props}
    >
      {children}
      <ArrowRightIcon
        aria-hidden="true"
        className="size-4 shrink-0 motion-full:transition-transform motion-full:duration-150 motion-full:group-hover/link:translate-x-0.5"
      />
    </a>
  );
}

export {
  Card,
  CardContent,
  CardDescription,
  CardFrame,
  CardFrameFooter,
  CardFrameHeader,
  CardFrameLink,
  CardFramePanel,
  CardHeader,
  CardTitle,
};
