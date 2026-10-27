import {
  createContext,
  type MouseEvent,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buttonVariants } from "@/ui/button";
import { dialogEntries } from "@/ui/dialog-history";
import { navigateInApp } from "../app-shell/address";
import { tabHref } from "../app-shell/navigation-model";
import { canManageBilling } from "../lib/billing-access";
import { leaveForReturn } from "../lib/kept-for-return";
import { useCurrentOrganization } from "../lib/current-organization";
import { orpcClient } from "../lib/orpc";
import {
  LIMIT_ASK_OWNER,
  type LimitHelpView,
  type LimitSubject,
  limitHelpFor,
  limitUsageText,
} from "./limit-help-model";

const SUBSCRIPTION_HREF = tabHref("settings", "assinatura");

/**
 * What the screen does before "Conhecer o Pro" takes the person to the Assinatura: a dialog closes and keeps its draft,
 * as Esc does (corte 1.6, AC-7). Outside a dialog there is nothing to do.
 */
const LimitLeaveContext = createContext<(() => void) | null>(null);
export const LimitLeaveScope = LimitLeaveContext.Provider;

export interface LimitHelpState {
  clear: () => void;
  help: LimitHelpView | null;
  /** A refusal (or a block) by the plan's limit is on screen: works out what goes with it. */
  show: (subject: LimitSubject) => void;
}

/**
 * What goes with a limit of the plan, by the one rule (`limitHelpFor`). The owner's numbers and plan come from
 * `billing.readPlan` (the server's, never the error's); a read that fails adds nothing. The latest call wins over an
 * answer that comes late.
 */
export function useLimitHelp(): LimitHelpState {
  const { billingSelfService, organization, organizationId } =
    useCurrentOrganization();
  const [help, setHelp] = useState<LimitHelpView | null>(null);
  const latest = useRef(0);
  const { role } = organization;
  const show = useCallback(
    (subject: LimitSubject) => {
      latest.current += 1;
      const ask = latest.current;
      setHelp(null);
      const canManage = canManageBilling(billingSelfService, role);
      if (!canManage) {
        setHelp(
          limitHelpFor({
            billingSelfService,
            canManageBilling: false,
            plan: null,
            subject,
          })
        );
        return;
      }
      orpcClient.billing
        .readPlan({ organizationId })
        .then((plan) => {
          if (ask === latest.current) {
            setHelp(
              limitHelpFor({
                billingSelfService,
                canManageBilling: true,
                plan,
                subject,
              })
            );
          }
        })
        .catch(() => undefined);
    },
    [billingSelfService, organizationId, role]
  );
  const clear = useCallback(() => {
    latest.current += 1;
    setHelp(null);
  }, []);
  return useMemo(() => ({ clear, help, show }), [clear, help, show]);
}

/**
 * Takes the focus to a refusal by the plan's limit after the render that ends the command (its button back on): a timer
 * could run before it, and the focus would go to the page.
 */
export function useLimitFocus(
  target: RefObject<HTMLElement | null>
): () => void {
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (asked > 0) {
      target.current?.focus();
    }
  }, [asked, target]);
  return useCallback(() => setAsked((count) => count + 1), []);
}

/** A plain click: a new tab or window asked by a key or the middle button keeps the browser's own way. */
function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return !(
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

/**
 * Under the limit text, only while it shows: "Você usa N de M…" when the plan gave them, then "Conhecer o Pro" (to the
 * Assinatura, inside the app: nothing typed is lost) or the way to the owner. One column at any width.
 */
export function LimitHelp({
  help,
  shown = true,
}: {
  help: LimitHelpView | null;
  /** Whether the limit's text is the one on screen: the help goes only with it. */
  shown?: boolean;
}) {
  const leave = useContext(LimitLeaveContext);
  // a second tap while the first one is on its way does not open the Assinatura twice
  const going = useRef<boolean>(false);
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (!isPlainClick(event)) {
        return;
      }
      event.preventDefault();
      if (going.current) {
        return;
      }
      going.current = true;
      leave?.();
      // after the render that closed the dialog, and after the step back that takes its entry out of the history
      window.setTimeout(() => {
        dialogEntries().afterSteps(() => {
          leaveForReturn();
          navigateInApp(SUBSCRIPTION_HREF);
          going.current = false;
        });
      }, 0);
    },
    [leave]
  );
  if (help === null || !shown) {
    return null;
  }
  return (
    <span className="mt-1 grid justify-items-start gap-2">
      {help.usage ? <span>{limitUsageText(help.usage)}</span> : null}
      {help.action === "upgrade" ? (
        <a
          className={buttonVariants({ size: "sm", variant: "outline" })}
          href={SUBSCRIPTION_HREF}
          onClick={handleClick}
        >
          Conhecer o Pro
        </a>
      ) : (
        <span>{LIMIT_ASK_OWNER}</span>
      )}
    </span>
  );
}
