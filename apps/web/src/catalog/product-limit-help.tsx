import { useCallback, useRef } from "react";
import { buttonVariants } from "@/ui/button";
import { canManageBilling } from "../lib/billing-access";
import { orpcClient } from "../lib/orpc";
import {
  isProductLimitReached,
  PRODUCT_LIMIT_ASK_OWNER,
  PRODUCT_LIMIT_REACHED,
  type ProductLimitHelp,
  productLimitHelp,
} from "./product-errors";
import { tabHref } from "../app-shell/navigation-model";

const SUBSCRIPTION_HREF = tabHref("settings", "assinatura");

/**
 * Works out what goes with the plan's limit refusal (stage 2 of the corte 61b, AC-10). Whom may manage the billing
 * gets the plan's state from `billing.readPlan` (the numbers and the plan are the server's, not the error's); a read
 * that fails adds nothing. The latest refusal wins over an answer that comes late.
 */
export function useLimitHelp(
  setHelp: (help: ProductLimitHelp) => void,
  context: { billingSelfService: boolean; organizationId: string; role: string }
): (cause: unknown, action: string) => void {
  const latest = useRef(0);
  const { billingSelfService, organizationId, role } = context;
  return useCallback(
    (cause: unknown, action: string) => {
      if (!(action === "create" && isProductLimitReached(cause))) {
        return;
      }
      latest.current += 1;
      const ask = latest.current;
      setHelp(null);
      const canManage = canManageBilling(billingSelfService, role);
      if (!canManage) {
        setHelp(
          productLimitHelp({
            billingSelfService,
            canManageBilling: canManage,
            planState: null,
          })
        );
        return;
      }
      orpcClient.billing
        .readPlan({ organizationId })
        .then((plan) => {
          if (ask === latest.current) {
            setHelp(
              productLimitHelp({
                billingSelfService,
                canManageBilling: true,
                planState: plan.state,
              })
            );
          }
        })
        .catch(() => undefined);
    },
    [billingSelfService, organizationId, role, setHelp]
  );
}

/** Under the limit text, only while it shows: "Conhecer o Pro" to the Assinatura, or the way to the owner. */
export function LimitHelp({
  error,
  help,
}: {
  error: string | null;
  help: ProductLimitHelp;
}) {
  if (error !== PRODUCT_LIMIT_REACHED) {
    return null;
  }
  if (help === "upgrade") {
    return (
      <span className="mt-2 flex">
        <a
          className={buttonVariants({ size: "sm", variant: "outline" })}
          href={SUBSCRIPTION_HREF}
        >
          Conhecer o Pro
        </a>
      </span>
    );
  }
  return help === "ask_owner" ? (
    <span className="mt-1 block">{PRODUCT_LIMIT_ASK_OWNER}</span>
  ) : null;
}
