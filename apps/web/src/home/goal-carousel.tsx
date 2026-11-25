import type { GoalReadModel } from "@polaris/contracts";
import ChevronLeftIcon from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRightIcon from "lucide-react/dist/esm/icons/chevron-right";
import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Figure } from "@/ui/figure";
import { goalTitle } from "../dashboard/goal-model";

/** How far a finger must travel sideways to turn the page, and how much more sideways than down it must be. */
const SWIPE_MIN_PX = 48;
const SWIPE_DOMINANCE = 1.5;

export interface GoalPosition {
  /** "Meta 2 de 3: Vendas de novembro" after a step, empty before it (opening the screen announces nothing). */
  announcement: string;
  count: number;
  index: number;
  step: (delta: -1 | 1) => void;
}

/**
 * Which goal of the ordered list is open. The goal is kept by its id, not by its place: a new read that reorders the
 * list keeps the one in view while it exists, and falls back to the first (the rule of the order) when it does not.
 * Nothing is kept between visits: the state is the component's.
 */
export function useGoalPosition(goals: readonly GoalReadModel[]): GoalPosition {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const found = goals.findIndex((goal) => goal.id === selectedId);
  const index = found < 0 ? 0 : found;
  const count = goals.length;
  const step = useCallback(
    (delta: -1 | 1) => {
      const next = index + delta;
      const goal = goals[next];
      if (!goal) {
        return;
      }
      setSelectedId(goal.id);
      setAnnouncement(`Meta ${next + 1} de ${count}: ${goalTitle(goal)}`);
    },
    [count, goals, index]
  );
  return { announcement, count, index, step };
}

/**
 * The previous and next buttons with "1 de 3", for the heading of the block. An arrow with nowhere to go stays and is
 * `aria-disabled` (it keeps the focus and the layout still); the touch area of 44 px is the button's own (`touch-hit`), and
 * the gap keeps the two areas from overlapping.
 */
export function GoalStepper({ count, index, step }: GoalPosition) {
  const previous = useCallback(() => step(-1), [step]);
  const next = useCallback(() => step(1), [step]);
  return (
    <div className="flex items-center gap-3" data-goal-stepper="">
      <span className="text-muted-foreground text-support">
        <Figure>
          {index + 1} de {count}
        </Figure>
      </span>
      <Button
        aria-disabled={index === 0 || undefined}
        aria-label="Meta anterior"
        onClick={previous}
        size="icon-sm"
        type="button"
        variant="outline"
      >
        <ChevronLeftIcon aria-hidden="true" />
      </Button>
      <Button
        aria-disabled={index === count - 1 || undefined}
        aria-label="Próxima meta"
        onClick={next}
        size="icon-sm"
        type="button"
        variant="outline"
      >
        <ChevronRightIcon aria-hidden="true" />
      </Button>
    </div>
  );
}

/**
 * The goals stacked in one cell of a grid, so the tallest sets the height and a swap never moves the page; the ones
 * out of view are `invisible` and `inert` (out of the reading order and the Tab). The swap is a fade under full
 * motion only (`motion-full:`: desktop with no reduced-motion setting); everywhere else it is instant. A finger moving
 * sideways turns the page too (`touch-pan-y` leaves the vertical scroll to the browser, which cancels the pointer
 * when it takes the gesture); the buttons are always there for whoever does not drag.
 */
export function GoalSlides({
  position,
  slides,
}: {
  position: GoalPosition;
  slides: readonly { id: string; node: React.ReactNode }[];
}) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const { announcement, index, step } = position;
  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (!event.isPrimary) {
      return;
    }
    start.current =
      event.pointerType === "touch"
        ? { x: event.clientX, y: event.clientY }
        : null;
  }, []);
  const onPointerCancel = useCallback(() => {
    start.current = null;
  }, []);
  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      const from = start.current;
      start.current = null;
      if (!from) {
        return;
      }
      const dx = event.clientX - from.x;
      const dy = event.clientY - from.y;
      if (
        Math.abs(dx) >= SWIPE_MIN_PX &&
        Math.abs(dx) >= Math.abs(dy) * SWIPE_DOMINANCE
      ) {
        step(dx < 0 ? 1 : -1);
      }
    },
    [step]
  );
  return (
    <div
      className="grid touch-pan-y"
      data-goal-slides=""
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      {slides.map((slide, place) => (
        <div
          className={cn(
            "col-start-1 row-start-1 flex min-w-0 flex-col gap-(--card-spacing) motion-full:transition-[opacity,visibility] motion-full:duration-150",
            place === index ? "opacity-100" : "invisible opacity-0"
          )}
          data-goal-slide={place === index ? "open" : "closed"}
          inert={place !== index}
          key={slide.id}
        >
          {slide.node}
        </div>
      ))}
      <p
        aria-live="polite"
        className="sr-only"
        data-goal-announcement=""
        role="status"
      >
        {announcement}
      </p>
    </div>
  );
}
