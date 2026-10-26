import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { type ReactNode, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { SLOW_READ_TEXT, STALE_COPY_TITLE } from "../lib/read-wait-text";

/** After this, a read still going is said on the screen (the tries of a read may take ~6 s more). */
const SLOW_READ_MS = 3000;

/**
 * "Demorando mais que o normal…" with the skeleton of a read that takes long, rendered while the skeleton is (a span,
 * so it fits in a line of text that is already there): empty
 * for the first ~3 s, then the line. A status (the region is there from the start, so the line is announced) with no
 * button: the tries go on by themselves.
 */
export function SlowReadNote({ className }: { className?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_READ_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <span className={className} role="status">
      {slow ? SLOW_READ_TEXT : null}
    </span>
  );
}

/**
 * Every try of a read failed with a connection, and the screen has a copy of it: the copy stays, with what it shows
 * (`shown`) and "Tentar novamente". `children`: what else the screen says about the copy (work still on the device).
 */
export function StaleCopyNotice({
  children,
  onRetry,
  shown,
}: {
  children?: ReactNode;
  onRetry: () => void;
  shown: string;
}) {
  return (
    <Alert variant="warning">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle>{STALE_COPY_TITLE}</AlertTitle>
      <AlertDescription>
        <p>{shown}</p>
        {children}
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
    </Alert>
  );
}
