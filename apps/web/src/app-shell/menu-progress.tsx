import CalendarClockIcon from "lucide-react/dist/esm/icons/calendar-clock";
import ListChecksIcon from "lucide-react/dist/esm/icons/list-checks";
import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/ui/sidebar";
import {
  FIRST_STEPS_TOTAL,
  rememberedFirstSteps,
  subscribeFirstSteps,
} from "./first-steps";
import { tabHref } from "./navigation-model";

const FIRST_STEPS_HREF = "/#home-checklist";
const SUBSCRIPTION_HREF = tabHref("settings", "assinatura");

/** The width of the ink in the bar, by the steps done (1 or 2: with the 3 done the store sold and the item is gone). */
const BAR_WIDTH: Readonly<Record<number, string>> = {
  1: "w-1/3",
  2: "w-2/3",
};

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

/** Two lines taller than a destination; folded, the icon of a destination, with the text in its tooltip. */
const ITEM =
  "h-auto touch:h-auto min-h-8 touch:min-h-12 items-start py-2 [&>svg]:mt-0.5 group-data-[collapsible=icon]:min-h-0 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:py-2";

function FirstStepsItem({ done }: { done: number }) {
  const text = `${done} de ${FIRST_STEPS_TOTAL}`;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-label={`Primeiros passos, ${text} concluídos`}
        className={ITEM}
        data-menu-first-steps=""
        href={FIRST_STEPS_HREF}
        tooltip={`Primeiros passos · ${text}`}
      >
        <ListChecksIcon aria-hidden />
        <span className="grid min-w-0 flex-1 gap-1.5 group-data-[collapsible=icon]:sr-only">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate">Primeiros passos</span>
            <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
              {text}
            </span>
          </span>
          <span
            aria-hidden="true"
            className="block h-1 overflow-hidden rounded-full bg-muted"
          >
            <span
              className={cn(
                "block h-full rounded-full bg-primary",
                BAR_WIDTH[done]
              )}
            />
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
        className={ITEM}
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
