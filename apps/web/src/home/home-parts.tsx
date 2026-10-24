import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Skeleton } from "@/ui/skeleton";

/**
 * The pieces every block of the Início shares: the card that is a named region (AC-37: each block is announced as a
 * region with its title), the skeleton that keeps the height while it reads (§ 5.2 (e)) and the error with
 * "Tentar novamente" (§ 5.2).
 */

interface BlockProps {
  /** A link or a control beside the heading. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id: string;
  /** The heading of the block, a `h2`: also the name of the region. */
  title: ReactNode;
}

export function HomeBlock({
  action,
  children,
  className,
  id,
  title,
}: BlockProps) {
  return (
    <Card
      aria-labelledby={id}
      className={cn("min-w-0 px-(--card-spacing)", className)}
      role="region"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 className="text-section" id={id}>
          {title}
        </h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

/** The block while it reads: its shape in `Skeleton`, the sentence only for the screen reader. */
export function BlockSkeleton({
  className,
  label,
  lines = 2,
}: {
  className?: string;
  label: string;
  lines?: number;
}) {
  return (
    <Card
      aria-busy="true"
      className={cn("min-w-0 gap-3 px-(--card-spacing)", className)}
      role="status"
    >
      <span className="sr-only">{label}</span>
      <Skeleton aria-hidden="true" className="h-4 w-24" />
      <Skeleton aria-hidden="true" className="h-8 w-40" />
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          aria-hidden="true"
          className="h-4 w-full"
          key={index}
        />
      ))}
    </Card>
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
