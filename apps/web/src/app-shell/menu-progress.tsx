import CalendarClockIcon from "lucide-react/dist/esm/icons/calendar-clock";
import SparklesIcon from "lucide-react/dist/esm/icons/sparkles";
import { type MouseEvent, useSyncExternalStore } from "react";
import { dialogEntries } from "@/ui/dialog-history";
import { PlanCard as PlanCardBox } from "@/ui/plan-card";
import { ProgressRing } from "@/ui/progress-ring";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/ui/sidebar";
import { leaveForReturn } from "../lib/kept-for-return";
import { isPlainClick } from "../lib/plain-click";
import { limitUsageText } from "../subscription/limit-help-model";
import type { PlanCardView } from "../subscription/plan-notice";
import { PRO_PITCH } from "../subscription/subscription-model";
import { navigateInApp } from "./address";
import {
  FIRST_STEPS_ANCHOR,
  FIRST_STEPS_TOTAL,
  rememberedFirstSteps,
  subscribeFirstSteps,
} from "./first-steps";
import { tabHref } from "./navigation-model";

const FIRST_STEPS_HREF = `/#${FIRST_STEPS_ANCHOR}`;
const SUBSCRIPTION_HREF = tabHref("settings", "assinatura");

/** The steps done that the Início read in this tab for this store; null for none to show. */
export function useFirstSteps(organizationId: string | null): number | null {
  const done = useSyncExternalStore(
    subscribeFirstSteps,
    () =>
      organizationId === null ? null : rememberedFirstSteps(organizationId),
    () => null
  );
  return organizationId === null ? null : done;
}

/** The trial line has two lines: its icon sits on the first; folded, centered as a destination's. */
const TWO_LINES = "[&>svg]:mt-0.5 group-data-[collapsible=icon]:[&>svg]:mt-0";

/** On the Início itself the link only scrolls: the "Mais" panel of the phone, a modal dialog, closes to show the block. */
function closeSheetOnTheSamePage(event: MouseEvent<HTMLAnchorElement>) {
  if (window.location.pathname === "/") {
    event.currentTarget.closest("dialog")?.close();
  }
}

function FirstStepsItem({ done }: { done: number }) {
  const text = `${done} de ${FIRST_STEPS_TOTAL}`;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-label={`Primeiros passos, ${text} concluídos`}
        data-menu-first-steps=""
        href={FIRST_STEPS_HREF}
        onClick={closeSheetOnTheSamePage}
        tooltip={`Primeiros passos · ${text}`}
      >
        <ProgressRing done={done} total={FIRST_STEPS_TOTAL} />
        <span className="flex min-w-0 flex-1 items-baseline justify-between gap-2 group-data-[collapsible=icon]:sr-only">
          <span className="truncate">Primeiros passos</span>
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
            {text}
          </span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function TrialItem({ chargeDay }: { chargeDay: string }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-label={`Teste grátis, primeira cobrança em ${chargeDay}, abrir Assinatura`}
        className={TWO_LINES}
        size="lg"
        data-menu-trial=""
        href={SUBSCRIPTION_HREF}
        tooltip={`Teste grátis · 1ª cobrança em ${chargeDay}`}
      >
        <CalendarClockIcon aria-hidden />
        <span className="grid min-w-0 flex-1 gap-0.5 group-data-[collapsible=icon]:sr-only">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate">Teste grátis</span>
            {/* drawn as the small button of the design: the whole line is the link */}
            <span className="inline-flex h-6 shrink-0 items-center rounded-md border border-input bg-background px-2 font-medium text-foreground text-xs">
              Assinatura
            </span>
          </span>
          <span className="truncate text-muted-foreground text-xs">
            1ª cobrança em {chargeDay}
          </span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The foot of the menu, above the card of the store (in "Mais" on the phone, before the theme): the first steps of a
 * store that never sold, and the trial of whom manages the billing. Each line only while it exists; nothing at all
 * without either.
 */
export function MenuProgress({
  chargeDay,
  firstSteps,
}: {
  /** "dd/mm" of the first charge of the trial, or null out of a trial or without `billing:manage`. */
  chargeDay: string | null;
  firstSteps: number | null;
}) {
  if (firstSteps === null && chargeDay === null) {
    return null;
  }
  return (
    <SidebarMenu data-menu-progress="">
      {firstSteps === null ? null : <FirstStepsItem done={firstSteps} />}
      {chargeDay === null ? null : <TrialItem chargeDay={chargeDay} />}
    </SidebarMenu>
  );
}

const PLAN_NAME = "Plano Free";
const PRO_LABEL = "Conhecer o Pro";

/**
 * Opens the Assinatura inside the app, so a draft kept for the return stays (as "Conhecer o Pro" of the limit notices
 * does); the "Mais" sheet of the phone closes first, and the step back it leaves in the history is taken before the
 * new address is pushed.
 */
function useOpenSubscription(): (event: MouseEvent<HTMLAnchorElement>) => void {
  const { isMobile, setOpenMobile } = useSidebar();
  return (event) => {
    if (!isPlainClick(event)) {
      return;
    }
    event.preventDefault();
    if (isMobile) {
      setOpenMobile(false);
    }
    window.setTimeout(() => {
      dialogEntries().afterSteps(() => {
        leaveForReturn();
        navigateInApp(SUBSCRIPTION_HREF);
      });
    }, 0);
  };
}

/**
 * The card of the Free plan, below the lines of progress: always, for the owner of a Free store. The card with its
 * strip on the desktop, the compact one (no strip) in the "Mais" sheet, and only an icon with the text in the tooltip
 * when the sidebar is folded (the folded column is 3 rem wide).
 */
export function PlanCard({ view }: { view: PlanCardView }) {
  const { isMobile, state } = useSidebar();
  const open = useOpenSubscription();
  const { usage } = view;
  if (!isMobile && state === "collapsed") {
    const counted =
      usage === null ? "" : `${usage.used} de ${usage.max} variantes`;
    return (
      <SidebarMenu data-plan-card-folded="">
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-label={`${PLAN_NAME}, ${counted ? `${counted}, ` : ""}conhecer o Pro`}
            href={SUBSCRIPTION_HREF}
            onClick={open}
            tooltip={counted ? `${PLAN_NAME} · ${counted}` : PLAN_NAME}
          >
            <SparklesIcon aria-hidden />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }
  return (
    <PlanCardBox
      art={!isMobile}
      buttonLabel={PRO_LABEL}
      href={SUBSCRIPTION_HREF}
      onOpen={open}
      pitch={PRO_PITCH}
      usage={
        usage === null
          ? null
          : {
              share: usage.used / usage.max,
              text: limitUsageText({ ...usage, subject: "variants" }),
            }
      }
    />
  );
}
