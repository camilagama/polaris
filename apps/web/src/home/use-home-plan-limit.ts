import { useEffect, useRef, useState } from "react";
import { canManageBilling } from "../lib/billing-access";
import { useConnectionOnline } from "../lib/browser-connection";
import { useCurrentOrganization } from "../lib/current-organization";
import { orpcClient } from "../lib/orpc";
import {
  type NearLimitView,
  nearLimitForHome,
} from "../subscription/limit-help-model";

/**
 * The plan's warning for the Início, read once per store when the page opens and only for the owner with the
 * self-service on: never on focus or on a timer, and not again when the connection comes back. Nothing is kept past the
 * page (the use lives in memory), no read starts without a connection, and a read that fails (a refusal included) adds
 * no line and no error. An answer that comes after the connection dropped is dropped, so a number read before the drop
 * is never shown after it.
 */
export function useHomePlanLimit(): NearLimitView | null {
  const { billingSelfService, organization, organizationId } =
    useCurrentOrganization();
  const online = useConnectionOnline();
  const [read, setRead] = useState<{
    organizationId: string;
    view: NearLimitView | null;
  } | null>(null);
  const asked = useRef<Set<string>>(new Set());
  const drops = useRef(0);
  const { role } = organization;
  const canManage = canManageBilling(billingSelfService, role);
  useEffect(() => {
    if (!(online && canManage) || asked.current.has(organizationId)) {
      return;
    }
    asked.current.add(organizationId);
    const dropsAtAsk = drops.current;
    orpcClient.billing
      .readPlan({ organizationId })
      .then((plan) => {
        if (drops.current === dropsAtAsk) {
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
      drops.current += 1;
      setRead(null);
    }
  }, [online]);
  return online && canManage && read?.organizationId === organizationId
    ? read.view
    : null;
}
