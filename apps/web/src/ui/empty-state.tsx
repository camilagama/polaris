import { type ReactNode, useId } from "react";
import { Card, CardContent } from "./card";

export const EMPTY_TITLE_MAX = 60;
export const EMPTY_SUPPORT_MAX = 100;

interface EmptyStateProps {
  /**
   * The empty list appears after a read (the list was loading or the period changed): it is a `role="status"`, so the
   * screen reader says it without the focus moving. Without it, the card is a region named by its sentence.
   */
  afterRead?: boolean;
  /** The action, a button or a link drawn as one; more than one sit side by side and wrap. */
  children?: ReactNode;
  /** One line that keeps what the sentence is too short to hold: at most `EMPTY_SUPPORT_MAX` characters. */
  support?: string;
  /** The sentence of the empty list: at most `EMPTY_TITLE_MAX` characters, what it says and nothing about how to act. */
  title: string;
}

/**
 * The empty state of a list or a period: a sentence, an optional line of support and the action as a button, never as
 * a phrase ("Toque em…"): a phrase that names a button is read and not pressed, and it disagrees with the title bar's
 * own button as soon as that one changes its name.
 */
export function EmptyState({
  afterRead = false,
  children,
  support,
  title,
}: EmptyStateProps) {
  const titleId = useId();
  const region = afterRead
    ? { role: "status" }
    : { "aria-labelledby": titleId, role: "region" };
  return (
    <Card {...region} data-empty-state="">
      <CardContent className="grid justify-items-center gap-3 text-center">
        <div className="grid gap-1">
          <p className="font-medium" data-empty-title="" id={titleId}>
            {title}
          </p>
          {support ? (
            <p className="text-muted-foreground text-support">{support}</p>
          ) : null}
        </div>
        {children ? (
          <div className="flex flex-wrap justify-center gap-2">{children}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}
