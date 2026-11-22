import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { buttonVariants } from "@/ui/button";
import { useConnectionOnline } from "../lib/browser-connection";
import { planRead } from "../lib/plan-read";
import { isSigningOut } from "../lib/sign-out";
import { useNow } from "../lib/use-now";
import { isSessionOver } from "../offline/runtime/session-ended";
import {
  graceNotice,
  noPlanReadBackoff,
  noPlanReadsInFlight,
  PLAN_READ_WAIT_MS,
  type PlanNoticeFacts,
  type PlanReadBackoff,
  type PlanReadsInFlight,
  planNoticeIsOld,
  planReadBackoffFor,
  planReadEnded,
  planReadFailed,
  planReadInFlight,
  planReadStarted,
  planReadSucceeded,
  type RememberedNotice,
  rememberedPlanNotice,
  rememberPlanNotice,
  subscribePlanNotice,
} from "../subscription/plan-notice";
import { tabHref } from "./navigation-model";

const SUBSCRIPTION_HREF = tabHref("settings", "assinatura");

export interface PlanNoticeState {
  facts: PlanNoticeFacts | null;
  /**
   * The shell is reading the plan for whom manages the billing, with a connection and nothing kept in this tab, and the
   * read has neither answered, failed nor waited out its ceiling: what depends on the plan enters once, with it.
   */
  pending: boolean;
}

/**
 * The plan's state for the shell (the notice of grace and the trial at the foot of the menu), read once for both: what this tab read (shown at once, also while it is read again), and a read of the
 * plan (through the memory of 10 s the screens share, `planRead`) when there is none or it is a few minutes old and the
 * tab is online. A failed read shows nothing new and is
 * tried again later, the wait doubling from 1 to 10 min; the notice never guesses.
 */
export function usePlanNoticeFacts(
  organizationId: string,
  enabled: boolean,
  /** The notice reads the plan by itself: not on the Assinatura, which reads it and tells the notice. */
  readsItself: boolean
): PlanNoticeState {
  const online = useConnectionOnline();
  const now = useNow(60_000);
  const text = useSyncExternalStore(
    subscribePlanNotice,
    () => JSON.stringify(rememberedPlanNotice(organizationId)),
    () => "null"
  );
  const remembered = JSON.parse(text) as RememberedNotice | null;
  const old = planNoticeIsOld(remembered, now.getTime());
  // the stores whose wait ended (an answer, a failure, the ceiling or a dropped connection): it never comes back for them
  const [ended, setEnded] = useState<ReadonlySet<string>>(new Set());
  const endWait = useCallback(
    (id: string) =>
      setEnded((all) => (all.has(id) ? all : new Set(all).add(id))),
    []
  );
  const pending =
    enabled &&
    online &&
    readsItself &&
    remembered === null &&
    !ended.has(organizationId);
  useEffect(() => {
    const ceiling = pending
      ? window.setTimeout(() => endWait(organizationId), PLAN_READ_WAIT_MS)
      : undefined;
    return () => window.clearTimeout(ceiling);
  }, [endWait, organizationId, pending]);
  // a connection that drops ends the wait for good: it does not come back with the connection
  useEffect(() => {
    if (!online && organizationId !== "") {
      endWait(organizationId);
    }
  }, [endWait, online, organizationId]);
  // the stores with a read on its way: the answer of one frees only that one
  const reading = useRef<PlanReadsInFlight>(noPlanReadsInFlight);
  // the wait after the reads that failed in a row, of the store it was counted for (never carried to another)
  const failed = useRef<PlanReadBackoff>(noPlanReadBackoff(organizationId));
  useEffect(() => {
    failed.current = planReadBackoffFor(failed.current, organizationId);
    if (
      !(enabled && online && readsItself && old) ||
      planReadInFlight(reading.current, organizationId) ||
      now.getTime() < failed.current.retryAt
    ) {
      return;
    }
    reading.current = planReadStarted(reading.current, organizationId);
    planRead
      .get(organizationId)
      .then((plan) => {
        endWait(organizationId);
        failed.current = planReadSucceeded(failed.current, organizationId);
        // an answer after the sign-out would write back what the sign-out dropped
        if (!(isSessionOver() || isSigningOut())) {
          rememberPlanNotice(organizationId, plan);
        }
      })
      .catch(() => {
        endWait(organizationId);
        failed.current = planReadFailed(
          failed.current,
          organizationId,
          now.getTime()
        );
      })
      .finally(() => {
        reading.current = planReadEnded(reading.current, organizationId);
      });
    // `now` too: an old copy is read again on the next minute, and a failed read once its wait is over
  }, [enabled, endWait, now, old, online, organizationId, readsItself]);
  return { facts: enabled ? remembered : null, pending };
}

/**
 * The persistent notice of a payment not confirmed (AS-35): at the top of every screen of whom manages the billing
 * while the store is in grace, with the end of the Pro and the days left, and the way to the Assinatura (not on it).
 * `facts` is null for whom does not manage the billing, without a store or once the session is over.
 */
export function GraceNoticeSlot({
  facts,
  onSubscription,
}: {
  facts: PlanNoticeFacts | null;
  /** The Assinatura is the screen: no link to itself. */
  onSubscription: boolean;
}) {
  const now = useNow(60_000);
  const online = useConnectionOnline();
  // the Assinatura shows nothing of the plan offline (AS-8): its notice neither
  const notice =
    facts === null || (onSubscription && !online)
      ? null
      : graceNotice(facts, now);
  if (notice === null) {
    return null;
  }
  return (
    <Alert className="mb-4 font-sans" data-grace-notice="" variant="warning">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription className="grid justify-items-start gap-2">
        {notice.description}
        {onSubscription ? null : (
          <a
            className={buttonVariants({ size: "sm", variant: "outline" })}
            href={SUBSCRIPTION_HREF}
          >
            Abrir Assinatura
          </a>
        )}
      </AlertDescription>
    </Alert>
  );
}
