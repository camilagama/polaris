import { useEffect, useRef, useState } from "react";
import { canManageBilling } from "../lib/billing-access";
import { useConnectionOnline } from "../lib/browser-connection";
import { useCurrentOrganization } from "../lib/current-organization";
import { planRead } from "../lib/plan-read";
import {
  type NearLimitView,
  nearLimitForHome,
} from "../subscription/limit-help-model";

/**
 * The plan's warning for the Início, read when the page opens and again when the store in use is not the one last
 * asked for (going back to a store read before reads it again), only for the owner with the self-service on: never on
 * focus or on a timer, and not again when the connection comes back to the same store; stores switched while offline
 * start no read, so coming back to the store last asked for does not read it again. The reading comes from the memory
 * of the plan the screens share for 10 s (`planRead`), which every write that changes the use clears; nothing else is
 * kept past the page, no read starts without a connection, and a read that fails (a refusal included) adds no line
 * and no error. An answer is dropped when the connection dropped after it was asked, or when it was asked for a store
 * other than the last one asked: a number read before the drop, or for another store, is never shown, and a late
 * answer for another store never replaces the reading of the store in use.
 */
export function useHomePlanLimit(): NearLimitView | null {
  const { billingSelfService, organization, organizationId } =
    useCurrentOrganization();
  const online = useConnectionOnline();
  const [read, setRead] = useState<{
    organizationId: string;
    view: NearLimitView | null;
  } | null>(null);
  const askedFor = useRef<string | null>(null);
  const drops = useRef(0);
  const { role } = organization;
  const canManage = canManageBilling(billingSelfService, role);
  useEffect(() => {
    if (!(online && canManage) || askedFor.current === organizationId) {
      return;
    }
    askedFor.current = organizationId;
    const dropsAtAsk = drops.current;
    planRead
      .get(organizationId)
      .then((plan) => {
        if (
          drops.current === dropsAtAsk &&
          askedFor.current === organizationId
        ) {
          setRead({
            organizationId,
            view: nearLimitForHome({
              billingSelfService,
              canManageBilling: true,
              plan,
            }),
          });
        }
      })
      .catch(() => undefined);
  }, [billingSelfService, canManage, online, organizationId]);
  useEffect(() => {
    if (!online) {
      planRead.clear();
      drops.current += 1;
      setRead(null);
    }
  }, [online]);
  return online && canManage && read?.organizationId === organizationId
    ? read.view
    : null;
}
