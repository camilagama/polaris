import { type ComponentType, type ReactNode, useId } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "./card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./empty";
import { SkeletonArt, type SkeletonArtKind } from "./skeleton-art";

type EmptyIcon = ComponentType<{ "aria-hidden"?: "true" }>;

export const EMPTY_TITLE_MAX = 60;
export const EMPTY_SUPPORT_MAX = 100;

interface EmptyStateProps {
  art?: SkeletonArtKind | undefined;
  /**
   * The empty list appears after a read (the list was loading or the period changed): it is a `role="status"`, so the
   * screen reader says it without the focus moving. Without it, the card is a region named by its sentence.
   */
  afterRead?: boolean;
  /** Without the card, for a place that is already a card or a box of its own (the plot of a chart). */
  bare?: boolean;
  /** The action, a button or a link drawn as one; more than one sit side by side and wrap. */
  children?: ReactNode;
  /** Decoration, out of the accessible name; the empty inside a chart's box (`bare`) has none, so its box keeps its height. */
  icon?: EmptyIcon | readonly EmptyIcon[];
  /** One line for when the sentence alone does not say what to do (the period, the next step): at most `EMPTY_SUPPORT_MAX` characters. */
  support?: string;
  /** The sentence of the empty list: at most `EMPTY_TITLE_MAX` characters, what it says and nothing about how to act. */
  title: string;
}

/**
 * The empty state of a list or a period: a sentence, an optional line of support and, where the screen has no create
 * button on its title line, the action as a button, never as a phrase ("Toque em…"): a phrase that names a button is
 * read and not pressed, and it disagrees with the title bar's own button as soon as that one changes its name. A
 * screen whose title line always holds the button leaves the action out, so the button that appears with the empty
 * list does not move the page.
 */
export function EmptyState({
  afterRead = false,
  art,
  bare = false,
  children,
  icon,
  support,
  title,
}: EmptyStateProps) {
  const titleId = useId();
  const region = afterRead
    ? { role: "status" }
    : { "aria-labelledby": titleId, role: "region" };
  const icons = icon === undefined ? [] : [icon].flat();
  const content = (
    <>
      {art ? <SkeletonArt className="hidden w-44 md:block" kind={art} /> : null}
      {icons.length > 0 ? (
        <div className={cn("flex gap-2", art && "md:hidden")}>
          {icons.map((Icon) => (
            <EmptyMedia key={Icon.displayName ?? Icon.name} variant="icon">
              <Icon aria-hidden="true" />
            </EmptyMedia>
          ))}
        </div>
      ) : null}
      <EmptyHeader>
        <EmptyTitle data-empty-title="" id={titleId}>
          {title}
        </EmptyTitle>
        {support ? <EmptyDescription>{support}</EmptyDescription> : null}
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </>
  );
  return bare ? (
    <Empty {...region} data-empty-state="">
      {content}
    </Empty>
  ) : (
    <Card {...region} data-empty-state="">
      <CardContent>
        <Empty>{content}</Empty>
      </CardContent>
    </Card>
  );
}
