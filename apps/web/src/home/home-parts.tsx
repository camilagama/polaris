import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { hasCapabilityForRole } from "@polaris/domain/authorization/capabilities";
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
} from "react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { BlockHeader } from "@/ui/block-header";
import { Button } from "@/ui/button";
import {
  Card,
  CardFrame,
  CardFrameFooter,
  CardFrameHeader,
  CardFrameLink,
  CardFramePanel,
} from "@/ui/card";
import { Skeleton } from "@/ui/skeleton";

/** The role of the person in the store: the foot of a block shows only for who has the capability of its destination. */
const HomeRole = createContext<string | null>(null);
export const HomeRoleProvider = HomeRole.Provider;

/**
 * The foot of a framed block (from 760 px): one link to the screen the block is a summary of. `link` false keeps the
 * foot's line empty (the destination needs the connection and there is none), so the block does not change height.
 */
interface BlockFooter {
  capability: string;
  href: string;
  label: string;
  link?: boolean;
}

/**
 * The pieces every block of the Início shares: the card that is a named region (AC-37: each block is announced as a
 * region with its title), the skeleton that keeps the height while it reads (§ 5.2 (e)) and the error with
 * "Tentar novamente" (§ 5.2).
 */

interface BlockProps {
  /** A link or a control beside the heading. */
  action?: ReactNode;
  /** Attributes of the card the page's rules read (the goal's thin strip). */
  attributes?: Record<`data-${string}`, string>;
  children: ReactNode;
  className?: string;
  /** The foot on the frame, from 760 px. */
  footer?: BlockFooter;
  id: string;
  /** The (i) beside the heading, for a block with a term or an estimate to explain (never a warning). */
  help?: { about: string; text: string };
  /** For the panel: a container the content queries by, which measures what the content has (the frame's padding is outside it). */
  panelClassName?: string;
  /** The simple card at every width: the thin strip of the goal, whose own rules lay out the heading and the content. */
  plain?: boolean;
  /** The heading of the block, a `h2`: also the name of the region. */
  title: ReactNode;
}

export function HomeBlock({
  action,
  attributes,
  children,
  className,
  footer,
  help,
  id,
  panelClassName,
  plain = false,
  title,
}: BlockProps) {
  const role = useContext(HomeRole);
  const foot =
    footer && role !== null && hasCapabilityForRole(role, footer.capability)
      ? footer
      : null;
  const heading = (
    <BlockHeader
      action={action}
      className={plain ? "md:min-h-0" : "md:flex-nowrap"}
      help={help}
      id={id}
      title={title}
    />
  );
  if (plain) {
    return (
      <Card
        aria-labelledby={id}
        className={cn("min-w-0 px-(--card-spacing)", className)}
        role="region"
        {...attributes}
      >
        {heading}
        {children}
      </Card>
    );
  }
  return (
    <CardFrame
      aria-labelledby={id}
      className={cn("min-w-0", className)}
      role="region"
      {...attributes}
    >
      <CardFrameHeader>{heading}</CardFrameHeader>
      <CardFramePanel className={panelClassName}>{children}</CardFramePanel>
      {foot ? (
        <CardFrameFooter>
          {foot.link === false ? null : (
            <CardFrameLink href={foot.href}>{foot.label}</CardFrameLink>
          )}
        </CardFrameFooter>
      ) : null}
    </CardFrame>
  );
}

/**
 * A block that keeps, while `keep`, at least the height it had the last time it was drawn without it: the cards
 * without a connection stay as tall as the cards with figures were, whatever the foot of each one said.
 */
export function KeptHeight({
  children,
  keep,
  measure,
}: {
  children: ReactNode;
  keep: boolean;
  /** The block shows what the kept height is of (the cards with figures): only then its height is taken. */
  measure: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const last = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (measure && !keep && box.current) {
      last.current = box.current.offsetHeight;
    }
  });
  const height = keep ? last.current : null;
  return (
    <div
      className="grid"
      ref={box}
      style={height ? { minHeight: height } : undefined}
    >
      {children}
    </div>
  );
}

/**
 * The block while it reads: its shape in `Skeleton` (the title on the frame, the rest in the panel and, with `foot`,
 * the line of the foot), the sentence only for the screen reader. Under 760 px it is the simple card.
 */
export function BlockSkeleton({
  className,
  foot = false,
  label,
  lines = 2,
}: {
  className?: string;
  foot?: boolean;
  label: string;
  lines?: number;
}) {
  return (
    <CardFrame
      aria-busy="true"
      className={cn("min-w-0", className)}
      role="status"
    >
      <span className="sr-only">{label}</span>
      <CardFrameHeader>
        <Skeleton aria-hidden="true" className="h-4 w-24" />
      </CardFrameHeader>
      <CardFramePanel>
        <Skeleton aria-hidden="true" className="h-8 w-40" />
        {Array.from({ length: lines }, (_, index) => (
          <Skeleton aria-hidden="true" className="h-4 w-full" key={index} />
        ))}
      </CardFramePanel>
      {foot ? (
        <CardFrameFooter>
          <Skeleton aria-hidden="true" className="h-4 w-24" />
        </CardFrameFooter>
      ) : null}
    </CardFrame>
  );
}

/** A read that failed: what did not load and, when trying again can help, the button. */
export function BlockError({
  className,
  message,
  onRetry,
}: {
  className?: string;
  message: string;
  onRetry: (() => void) | null;
}) {
  return (
    <Alert className={className} variant="destructive">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle>{message}</AlertTitle>
      {onRetry ? (
        <AlertDescription>
          <Button
            className="mt-1.5"
            onClick={onRetry}
            size="sm"
            type="button"
            variant="outline"
          >
            <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
            Tentar novamente
          </Button>
        </AlertDescription>
      ) : null}
    </Alert>
  );
}
