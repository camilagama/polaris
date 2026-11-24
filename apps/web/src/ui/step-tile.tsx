import CheckIcon from "lucide-react/dist/esm/icons/check";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type StepState = "current" | "done" | "todo";

const STATE: Record<StepState, string> = {
  current: "border-primary bg-primary/10 text-primary",
  done: "border-transparent bg-primary/10 text-primary",
  todo: "text-muted-foreground",
};

/**
 * The 28 px box of a step's icon in a checklist, like `RowTile` a box of icon and nothing else: the same size in the
 * three states, so the state moves nothing. `done` shows a check in place of the icon. The name of the step and its
 * state are written beside it (`aria-current="step"` on the item, "(feito)" for the screen reader).
 */
function StepTile({
  children,
  state,
}: {
  children: ReactNode;
  state: StepState;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-md border [&>svg]:size-4",
        STATE[state]
      )}
      data-step-box={state}
    >
      {state === "done" ? <CheckIcon /> : children}
    </span>
  );
}

export { StepTile };
