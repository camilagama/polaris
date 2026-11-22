import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { HelpTip } from "./help-tip";

interface BlockHelp {
  about: string;
  text: string;
}

/**
 * The heading row of a block (a card with a title): the title and its (i) on the left, what the block shows at its
 * side (a total, a legend) and its action on the right, all on one line of at least 36 px. The only place that
 * order is written: the blocks of the Início and of the Resultado differ in what they hold, never in this row.
 */
export function BlockHeader({
  action,
  aside,
  className,
  help,
  id,
  level = 2,
  title,
}: {
  /** The one action of the block, last on the right. */
  action?: ReactNode;
  /** A total or a legend, on the right before the action. */
  aside?: ReactNode;
  className?: string;
  /** The (i): `about` names its button and titles its popup. A second one keeps 16 px from the first so their touch areas do not overlap. */
  help?: BlockHelp | readonly BlockHelp[] | undefined;
  /** The id the region of the block is named by (`aria-labelledby`). */
  id: string;
  level?: 2 | 3;
  title: ReactNode;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  const right = aside || action;
  const tips = help === undefined ? [] : [help].flat();
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1 md:min-h-9",
        className
      )}
      data-slot="block-header"
    >
      <div className="flex min-w-0 items-center gap-1">
        <Heading className="text-section" id={id}>
          {title}
        </Heading>
        {tips.map((tip, index) => (
          <HelpTip
            about={tip.about}
            className={cn("-my-1", index > 0 && "ml-4")}
            key={tip.about}
          >
            {tip.text}
          </HelpTip>
        ))}
      </div>
      {right ? (
        <div className="flex min-w-0 items-center gap-x-3">
          {aside}
          {action}
        </div>
      ) : null}
    </div>
  );
}
