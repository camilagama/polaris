import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { useOfflineRuntime } from "../offline/runtime/runtime-context";
import {
  type ClosedQueue,
  DISCARD_BACK,
  DISCARD_BUTTON,
  DISCARD_CONFIRM,
  DISCARD_DONE_TEXT,
  DISCARD_SENDING,
  DISCARD_UNREAD_TEXT,
  type DiscardOutcome,
  discardBody,
  discardTitle,
  emptyKinds,
  leftText,
  outcomeOf,
  QUEUE_SECTION_TITLE,
  queueView,
} from "./closed-queue-model";
import type { ClosedStore } from "./closed-store-model";
import { readClosedQueueOnDisk } from "./use-device-queue";

const TITLE_ID = "closed-queue-title";
const OFF = "aria-disabled:pointer-events-none aria-disabled:opacity-50";
const NONE: ClosedQueue = {
  counts: { pending: 0, rejected: 0, sending: 0 },
  kind: "counted",
  kinds: emptyKinds(),
};

/** The queue of this store on this device, read from the disk (no call of its own to the server's data). */
function useClosedQueue(organizationId: string) {
  const runtime = useOfflineRuntime();
  const [queue, setQueue] = useState<ClosedQueue>(
    runtime ? { kind: "unknown" } : NONE
  );
  const [outcome, setOutcome] = useState<DiscardOutcome | null>(null);
  const [pending, setPending] = useState(false);
  const sending = useRef(false);

  const read = useCallback(async (): Promise<ClosedQueue> => {
    if (!runtime) {
      return NONE;
    }
    try {
      return await readClosedQueueOnDisk(
        await runtime.logoutWorkspaces(),
        organizationId
      );
    } catch {
      return { kind: "unreadable" };
    }
  }, [organizationId, runtime]);

  useEffect(() => {
    let current = true;
    read()
      .then((state) => {
        if (current) {
          setQueue(state);
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [read]);

  const discard = useCallback(async () => {
    if (!runtime || sending.current) {
      return;
    }
    sending.current = true;
    setPending(true);
    try {
      await runtime.discardClosedQueue(organizationId);
    } catch {
      // the answer is what the disk says afterwards, not whether the call threw
    }
    const after = await read();
    setQueue(after);
    setOutcome(outcomeOf(after));
    sending.current = false;
    setPending(false);
  }, [organizationId, read, runtime]);

  return { discard, outcome, pending, queue };
}

interface DiscardDialogProps {
  finalFocus: RefObject<HTMLElement | null>;
  onBack: () => void;
  onConfirm: () => void;
  open: boolean;
  pending: boolean;
  queue: Extract<ClosedQueue, { kind: "counted" }>;
  total: number;
}

function DiscardDialog({
  finalFocus,
  onBack,
  onConfirm,
  open,
  pending,
  queue,
  total,
}: DiscardDialogProps) {
  const backRef = useRef<HTMLButtonElement>(null);
  const guarded = useCallback(
    (next: boolean) => {
      if (!(next || pending)) {
        onBack();
      }
    },
    [onBack, pending]
  );
  return (
    <Dialog disablePointerDismissal onOpenChange={guarded} open={open}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
        finalFocus={finalFocus}
        initialFocus={backRef}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>{discardTitle(total)}</DialogTitle>
          <DialogDescription>{discardBody(queue.kinds)}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-3">
          <Button
            aria-disabled={pending || undefined}
            className={OFF}
            onClick={pending ? undefined : onBack}
            ref={backRef}
            type="button"
            variant="outline"
          >
            {DISCARD_BACK}
          </Button>
          <Button
            aria-busy={pending}
            aria-disabled={pending || undefined}
            className={OFF}
            onClick={pending ? undefined : onConfirm}
            type="button"
            variant="destructive"
          >
            {pending ? DISCARD_SENDING : DISCARD_CONFIRM}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OutcomeNotice({ outcome }: { outcome: DiscardOutcome }) {
  if (outcome.kind === "done") {
    return (
      <Alert role="status">
        <AlertDescription className="text-foreground">
          {DISCARD_DONE_TEXT}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert role="alert" variant="destructive">
      <AlertDescription>
        {outcome.kind === "left"
          ? leftText(outcome.remaining)
          : DISCARD_UNREAD_TEXT}
      </AlertDescription>
    </Alert>
  );
}

/**
 * "Neste aparelho": what this device still holds for the closed store. It only offers the discard once the undo is
 * over, never discards by itself, and says "descartadas" only after reading the queue again and finding it empty.
 */
export function ClosedQueueSection({ store }: { store: ClosedStore }) {
  const { discard, outcome, pending, queue } = useClosedQueue(store.id);
  const [dialog, setDialog] = useState(false);
  const titleRef = useRef<HTMLDivElement>(null);
  const view = queueView(queue, store);

  const open = useCallback(() => setDialog(true), []);
  const back = useCallback(() => setDialog(false), []);
  const confirm = useCallback(() => {
    discard()
      .catch(() => undefined)
      .finally(() => setDialog(false));
  }, [discard]);

  useEffect(() => {
    if (outcome) {
      titleRef.current?.focus();
    }
  }, [outcome]);

  if (view.kind === "hidden" && !outcome) {
    return null;
  }
  return (
    <Card aria-labelledby={TITLE_ID} role="region">
      <CardHeader>
        <CardTitle
          aria-level={2}
          className="focus-ring"
          id={TITLE_ID}
          ref={titleRef}
          role="heading"
          tabIndex={-1}
        >
          {QUEUE_SECTION_TITLE}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid justify-items-start gap-3">
        {outcome ? <OutcomeNotice outcome={outcome} /> : null}
        {view.kind === "hidden" ? null : (
          <p
            className={
              view.kind === "reading" || view.kind === "unreadable"
                ? "text-muted-foreground"
                : undefined
            }
            role={view.kind === "reading" ? "status" : undefined}
          >
            {view.text}
          </p>
        )}
        {view.kind === "after" && queue.kind === "counted" ? (
          <>
            <Button className="max-sm:w-full" onClick={open} variant="outline">
              {DISCARD_BUTTON}
            </Button>
            <DiscardDialog
              finalFocus={titleRef}
              onBack={back}
              onConfirm={confirm}
              open={dialog}
              pending={pending}
              queue={queue}
              total={view.total}
            />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
