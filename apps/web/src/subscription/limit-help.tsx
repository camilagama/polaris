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
import { ARCHIVED_PRODUCTS_HREF } from "../catalog/products-link-model";
import { canManageBilling } from "../lib/billing-access";
import { useConnectionOnline } from "../lib/browser-connection";
import { leaveForReturn } from "../lib/kept-for-return";
import { useCurrentOrganization } from "../lib/current-organization";
import { orpcClient } from "../lib/orpc";
import { planRead } from "../lib/plan-read";
import {
  LIMIT_ASK_OWNER,
  type LimitHelpView,
  type LimitSubject,
  freeableLineText,
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

/**
 * What "Ver arquivados" does where the list of Produtos is already the screen: shows "Arquivados" without leaving the
 * page (the screen is not opened again by an address it already has). Elsewhere the link opens Produtos by its address.
 */
const ViewArchivedContext = createContext<(() => void) | null>(null);
export const ViewArchivedScope = ViewArchivedContext.Provider;

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
 * The click of a link of the warning that leaves the place: inside the app, so nothing typed is lost; a dialog closes
 * first and keeps its draft. A second tap while the first one is on its way does not run it twice.
 */
function useLeavingClick(
  go: () => void
): (event: MouseEvent<HTMLAnchorElement>) => void {
  const leave = useContext(LimitLeaveContext);
  const going = useRef<boolean>(false);
  const latest = useRef(go);
  latest.current = go;
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
          latest.current();
          going.current = false;
        });
      }, 0);
    },
    [leave]
  );
}

const openSubscription = () => {
  leaveForReturn();
  navigateInApp(SUBSCRIPTION_HREF);
};

/** The click of "Conhecer o Pro": the Assinatura, with the draft kept. */
function useProLinkClick(): (event: MouseEvent<HTMLAnchorElement>) => void {
  return useLeavingClick(openSubscription);
}

/** The click of "Ver arquivados": the list of archived products, with the draft kept as the Pro link keeps it. */
function useArchivedLinkClick(): (
  event: MouseEvent<HTMLAnchorElement>
) => void {
  const viewArchived = useContext(ViewArchivedContext);
  const go = useCallback(() => {
    if (viewArchived) {
      viewArchived();
    } else {
      leaveForReturn();
      navigateInApp(ARCHIVED_PRODUCTS_HREF);
    }
  }, [viewArchived]);
  return useLeavingClick(go);
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
 * The plan's warning of a cadastro screen (nearLimitFor): read when the screen opens, from the memory of the plan the
 * screens share for 10 s (`planRead`), and again, fresh, when `version` of this screen changes (after the person saved
 * something that changes the use). No read offline: a read that fails, or the connection going, takes the line away
 * instead of leaving an old number. The latest read wins.
 */
export function useNearLimit(
  subject: NearLimitSubject,
  version = 0
): NearLimitView | null {
  return useNearLimitRead(subject, version).view;
}

/**
 * `useNearLimit` plus whether the read of this store has answered (`settled`): not while offline, nor while the first
 * read is on the way. A screen that keeps the line's space reads it to know when it can let the space go.
 */
export function useNearLimitRead(
  subject: NearLimitSubject,
  version = 0
): { settled: boolean; view: NearLimitView | null } {
  const { billingSelfService, organization, organizationId } =
    useCurrentOrganization();
  const online = useConnectionOnline();
  const [read, setRead] = useState<{
    organizationId: string;
    view: NearLimitView | null;
  } | null>(null);
  const { role } = organization;
  const askedVersion = useRef<number | null>(null);
  useEffect(() => {
    if (!online) {
      planRead.clear();
    }
    if (!(online && canManageBilling(billingSelfService, role))) {
      setRead(null);
      return;
    }
    let current = true;
    const fresh =
      askedVersion.current !== null && askedVersion.current !== version;
    askedVersion.current = version;
    planRead
      .get(organizationId, { fresh })
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
          setRead({ organizationId, view: null });
        }
      });
    return () => {
      current = false;
    };
  }, [billingSelfService, online, organizationId, role, subject, version]);
  // a number read for another store is never shown for this one while its own read is on the way
  const settled = online && read?.organizationId === organizationId;
  return { settled, view: settled ? read.view : null };
}

const TEXT_LINK =
  "focus-ring touch-hit rounded-sm text-foreground underline decoration-input underline-offset-4 hover:decoration-foreground";

/** How the second line ("N produtos arquivados sem estoque") shows: with its link, without it (already in Arquivados) or not. */
export type FreeableLine = "hidden" | "link" | "plain";

/**
 * Whether the second line has its link where the warning is drawn: the screen that holds the list says it (in
 * "Arquivados" there is no link to what is already on screen); the default is the link.
 */
const FreeableLineContext =
  createContext<Exclude<FreeableLine, "hidden">>("link");
export const FreeableLineScope = FreeableLineContext.Provider;
export const useFreeableLine = () => useContext(FreeableLineContext);

function FreeableNotice({
  line,
  text,
}: {
  line: Exclude<FreeableLine, "hidden">;
  text: string;
}) {
  const handleClick = useArchivedLinkClick();
  return (
    <p
      className="text-muted-foreground text-support"
      data-near-limit-freeable=""
    >
      {text}
      {line === "link" ? (
        <>
          {" "}
          <a
            className={TEXT_LINK}
            href={ARCHIVED_PRODUCTS_HREF}
            onClick={handleClick}
          >
            Ver arquivados
          </a>
        </>
      ) : null}
    </p>
  );
}

/**
 * The warning line, at the end of a block (never above what the person touches): supporting text, no icon, no
 * background, no alert role, with "Conhecer o Pro" ending the sentence. A second paragraph, below, tells how many
 * archived products with no stock deleting would free (`freeable`: where the person can act on it, never the Início).
 * `hidden` is for when the line must not show although there is a view: the refusal's help is on screen (the two never
 * go together), or the screen is still loading what sits above it or has no session. `holdSpace` is for a block that
 * must not change size when the line goes: from 760 px the dialog box is centred, so it would move; below 760 px what
 * sits under the line would move. While it is true and the line is gone (the connection went, or the first read of
 * this store is on the way), the line's space stays, unseen and out of the reading order; the space goes when it turns
 * false with no line, and it is never there for a line that was not shown. The second paragraph is not held: a block
 * that holds space does not ask for it.
 */
export function NearLimitNotice({
  freeable = "hidden",
  hidden = false,
  holdSpace = false,
  view,
}: {
  freeable?: FreeableLine;
  hidden?: boolean;
  holdSpace?: boolean;
  view: NearLimitView | null;
}) {
  const handleClick = useProLinkClick();
  const [lastView, setLastView] = useState<NearLimitView | null>(view);
  if (view !== null && view !== lastView) {
    setLastView(view);
  } else if (view === null && !holdSpace && lastView !== null) {
    setLastView(null);
  }
  const held = holdSpace && view === null && !hidden;
  const shown = held ? lastView : view;
  if (shown === null || hidden) {
    return null;
  }
  const sentences = [nearLimitText(shown), nearLimitProText(shown)]
    .filter((sentence) => sentence !== null)
    .join(" ");
  const freeableText =
    freeable === "hidden" || view === null ? null : freeableLineText(view);
  const proLine = (
    <p
      aria-hidden={held ? true : undefined}
      className={
        held
          ? "invisible text-muted-foreground text-support"
          : "text-muted-foreground text-support"
      }
      data-near-limit={held ? undefined : shown.kind}
    >
      {sentences}{" "}
      <a className={TEXT_LINK} href={SUBSCRIPTION_HREF} onClick={handleClick}>
        Conhecer o Pro
      </a>
    </p>
  );
  if (freeable === "hidden" || freeableText === null) {
    return proLine;
  }
  return (
    <div className="grid gap-3 touch:gap-6">
      {proLine}
      <FreeableNotice line={freeable} text={freeableText} />
    </div>
  );
}
