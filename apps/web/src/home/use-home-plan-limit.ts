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
 * The plan's warning for the Início, read once when the page opens and only for the owner with the self-service on:
 * never on focus or on a timer, and not again when the connection comes back. Nothing is kept past the page (the use
 * lives in memory and goes with the store), no read happens without a connection, and a read that fails (a refusal
 * included) adds no line and no error. A number read before the connection went is not shown when it comes back.
 */
export function useHomePlanLimit(): NearLimitView | null {
  const { billingSelfService, organization, organizationId } =
    useCurrentOrganization();
  const online = useConnectionOnline();
  const [read, setRead] = useState<{
    organizationId: string;
    view: NearLimitView | null;
  } | null>(null);
  const asked = useRef<string | null>(null);
  const onlineNow = useRef(online);
  onlineNow.current = online;
  const { role } = organization;
  const canManage = canManageBilling(billingSelfService, role);
  useEffect(() => {
    if (!(online && canManage) || asked.current === organizationId) {
      return;
    }
    asked.current = organizationId;
    orpcClient.billing
      .readPlan({ organizationId })
      .then((plan) => {
        if (asked.current === organizationId && onlineNow.current) {
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
      setRead(null);
    }
  }, [online]);
  return online && canManage && read?.organizationId === organizationId
    ? read.view
    : null;
}
