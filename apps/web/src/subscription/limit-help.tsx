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
import { useConnectionOnline } from "../lib/browser-connection";
import { leaveForReturn } from "../lib/kept-for-return";
import { useCurrentOrganization } from "../lib/current-organization";
import { orpcClient } from "../lib/orpc";
import {
  LIMIT_ASK_OWNER,
  type LimitHelpView,
  type LimitSubject,
  limitHelpFor,
  limitUsageText,
  nearLimitFor,
  nearLimitProText,
  type NearLimitSubject,
  type NearLimitView,
  nearLimitText,
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
  /** The owner's plan is being read for the help: its place is kept (`LimitHelp`), so the notice does not grow after. */
  pending: boolean;
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
  const [pending, setPending] = useState(false);
  const latest = useRef(0);
  const { role } = organization;
  const show = useCallback(
    (subject: LimitSubject) => {
      latest.current += 1;
      const ask = latest.current;
      setHelp(null);
      const canManage = canManageBilling(billingSelfService, role);
      setPending(canManage);
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
        .catch(() => undefined)
        .finally(() => {
          if (ask === latest.current) {
            setPending(false);
          }
        });
    },
    [billingSelfService, organizationId, role]
  );
  const clear = useCallback(() => {
    latest.current += 1;
    setHelp(null);
    setPending(false);
  }, []);
  return useMemo(
    () => ({ clear, help, pending, show }),
    [clear, help, pending, show]
  );
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
export function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
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
 * The click of "Conhecer o Pro": inside the app, so nothing typed is lost; a dialog closes first and keeps its draft.
 * A second tap while the first one is on its way does not open the Assinatura twice.
 */
function useProLinkClick(): (event: MouseEvent<HTMLAnchorElement>) => void {
  const leave = useContext(LimitLeaveContext);
  const going = useRef<boolean>(false);
  return useCallback(
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
}

/**
 * Under the limit text, only while it shows: "Você usa N de M…" when the plan gave them, then "Conhecer o Pro" (to the
 * Assinatura, inside the app: nothing typed is lost) or the way to the owner. One column at any width.
 */
export function LimitHelp({
  help,
  pending = false,
  shown = true,
}: {
  help: LimitHelpView | null;
  /** The plan is being read: the place of "Conhecer o Pro" is kept, empty, so the notice does not grow when it comes. */
  pending?: boolean;
  /** Whether the limit's text is the one on screen: the help goes only with it. */
  shown?: boolean;
}) {
  const handleClick = useProLinkClick();
  if (help === null && pending && shown) {
    return (
      <span aria-hidden="true" className="mt-1 grid justify-items-start gap-2">
        <span className="h-ctl-sm" />
      </span>
    );
  }
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

/**
 * The plan's warning of a cadastro screen (nearLimitFor): read when the screen opens and again when `version` changes
 * (after the person saved something that changes the use). No read offline, and none is kept: a read that fails, or the
 * connection going, takes the line away instead of leaving an old number. The latest read wins.
 */
export function useNearLimit(
  subject: NearLimitSubject,
  version = 0
): NearLimitView | null {
  const { billingSelfService, organization, organizationId } =
    useCurrentOrganization();
  const online = useConnectionOnline();
  const [read, setRead] = useState<{
    organizationId: string;
    view: NearLimitView | null;
  } | null>(null);
  const { role } = organization;
  useEffect(() => {
    if (!(online && canManageBilling(billingSelfService, role))) {
      setRead(null);
      return;
    }
    let current = true;
    orpcClient.billing
      .readPlan({ organizationId })
      .then((plan) => {
        if (current) {
          setRead({
            organizationId,
            view: nearLimitFor({
              billingSelfService,
              canManageBilling: true,
              plan,
              subject,
            }),
          });
        }
      })
      .catch(() => {
        if (current) {
          setRead(null);
        }
      });
    return () => {
      current = false;
    };
  }, [billingSelfService, online, organizationId, role, subject, version]);
  // a number read for another store is never shown for this one while its own read is on the way
  return online && read?.organizationId === organizationId ? read.view : null;
}

/**
 * The warning line, at the end of a block (never above what the person touches): supporting text, no icon, no
 * background, no alert role, with "Conhecer o Pro" ending the sentence. `hidden` is for when the refusal is on screen:
 * the line and the refusal's help never go together.
 */
export function NearLimitNotice({
  hidden = false,
  view,
}: {
  hidden?: boolean;
  view: NearLimitView | null;
}) {
  const handleClick = useProLinkClick();
  if (view === null || hidden) {
    return null;
  }
  const sentences = [nearLimitText(view), nearLimitProText(view)]
    .filter((sentence) => sentence !== null)
    .join(" ");
  return (
    <p
      className="text-muted-foreground text-support"
      data-near-limit={view.kind}
    >
      {sentences}{" "}
      <a
        className="focus-ring touch-hit rounded-sm text-foreground underline decoration-input underline-offset-4 hover:decoration-foreground"
        href={SUBSCRIPTION_HREF}
        onClick={handleClick}
      >
        Conhecer o Pro
      </a>
    </p>
  );
}
