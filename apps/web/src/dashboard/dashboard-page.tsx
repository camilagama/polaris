import { HelpTip } from "@/ui/help-tip";
import { RefreshButton } from "@/ui/refresh-button";
import { hasCapabilityForRole } from "@polaris/domain/authorization/capabilities";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Card, CardContent } from "@/ui/card";
import { Tabs, TabsContent } from "@/ui/tabs";
import {
  dropNavigationState,
  navigateInApp,
  readNavigationState,
  replaceAddress,
} from "../app-shell/address";
import { addressWithTab, requestedTab } from "../app-shell/navigation-model";
import { SlowReadNote } from "../app-shell/read-wait";
import { TitleLine } from "../app-shell/screen-title";
import {
  ScreenTabList,
  ScreenTabTrigger,
  useScreenTab,
} from "../app-shell/screen-tabs";
import { LoadError } from "../expenses/expense-fields";
import { monthOfDay } from "../expenses/expense-model";
import { useConnectionOnline } from "../lib/browser-connection";
import { useCurrentOrganization } from "../lib/current-organization";
import { calendarDayInTimezone } from "../lib/dates";
import { useRuntimeSnapshot } from "../offline/runtime/runtime-context";
import { waitingOperations } from "../offline/runtime/sync-status";
import { formatLastConfirmed, formatUpdatedAt } from "./dashboard-model";
import { EmptyResult } from "./empty-result";
import { groupGoals } from "./goal-model";
import { GoalsPanel } from "./goals-panel";
import { OfflineCopyNotice } from "./offline-copy-notice";
import { PeriodPicker } from "./period-picker";
import { QualityBanner } from "./quality-banner";
import { ResultCards } from "./result-cards";
import { ResultChain } from "./result-chain";
import { ResultChart } from "./result-chart";
import {
  copyMonthOf,
  HISTORY_PERIOD_STATE,
  type Period,
  type PeriodPreset,
  periodFromState,
  periodText,
  presetOfPeriod,
  presetPeriod,
  RESULT_PERIOD_STATE,
  samePeriod,
} from "./result-period";
import { comparisonPeriod, resultChipPeriod } from "./result-kpis";
import { useGoals } from "./use-goals";
import {
  type ComparisonDays,
  type ComparisonSales,
  type PeriodSummaryState,
  useComparisonDays,
  useComparisonSales,
  usePeriodSummary,
} from "./use-period-summary";

const RESULT_TABS = ["resultado", "metas"] as const;

function Heading() {
  return (
    <header>
      <TitleLine>
        <div className="flex items-center gap-1">
          <h1 className="text-title">Resultado</h1>
          <HelpTip about="Resultado">
            Estimativa com as vendas confirmadas e as despesas do período. Não é
            lucro líquido nem dinheiro recebido.
          </HelpTip>
        </div>
      </TitleLine>
    </header>
  );
}

interface ToolbarProps {
  onCustom: (period: Period) => void;
  onPreset: (preset: PeriodPreset) => void;
  onRefresh: () => void;
  period: Period;
  preset: PeriodPreset;
  state: PeriodSummaryState;
  /** The year of the store's today, for the name of the period ("outubro", not "outubro de 2026"). */
  thisYear: string;
  timezone: string;
  /** The store's day: the shortcuts of the period are counted from it. */
  today: string;
}

interface StatusLine {
  /** False when the line must not take room on screen: it is only for the screen reader. */
  seen: boolean;
  text: string;
}

/**
 * What the line under the controls says, only when there is something to say: the device's copy ("Último resultado
 * confirmado"), or the read in progress. While another period loads, the figures of the one before stay on the
 * screen, dimmed, and this line says which they are. The server's time is not here: it is the text of "Atualizar".
 * Reading the same period again over figures the server gave leaves the line empty on screen: the text would come and
 * go and push the cards down by a line, and the button already says `aria-busy` (its icon turns only under full motion).
 */
function statusLine(
  state: PeriodSummaryState,
  timezone: string,
  period: Period,
  thisYear: string
): StatusLine | null {
  const { isLoading, source, summary } = state;
  if (isLoading) {
    if (!summary) {
      return null;
    }
    return samePeriod(summary.period, period)
      ? { seen: source !== "server", text: "Atualizando…" }
      : {
          seen: true,
          text: `Mostrando ${periodText(summary.period, thisYear)} até o novo período carregar.`,
        };
  }
  return summary && source !== "server"
    ? { seen: true, text: formatLastConfirmed(summary.generatedAt, timezone) }
    : null;
}

/**
 * The one line of control: the period on the left and, on the right, the time of the server's read, which is the
 * button that reads again. When the two do not fit, the time goes down before anything is cut. The status line comes
 * under it only when it has something to say (no height kept for it), in the same `aria-live` region that is always in
 * in place; with nothing to say on screen it is `sr-only`: it tells the screen reader that the same period is being
 * read again and, once a read ends, the time, as the button name does not change under a reader that is not looking
 * at it.
 */
function Toolbar({
  onCustom,
  onPreset,
  onRefresh,
  period,
  preset,
  state,
  thisYear,
  timezone,
  today,
}: ToolbarProps) {
  const { source, summary } = state;
  const updated =
    source === "server" && summary
      ? formatUpdatedAt(
          summary.generatedAt,
          timezone,
          calendarDayInTimezone(new Date(), timezone)
        )
      : null;
  const status = statusLine(state, timezone, period, thisYear);
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-3">
        <PeriodPicker
          onCustom={onCustom}
          onPreset={onPreset}
          period={period}
          preset={preset}
          today={today}
        />
        <RefreshButton
          busy={state.isLoading}
          disabled={state.isLoading}
          onClick={onRefresh}
          updated={updated ?? undefined}
        />
      </div>
      <p
        aria-live="polite"
        className={
          status?.seen ? "mt-2 text-muted-foreground text-support" : "sr-only"
        }
        id="dashboard-updated"
      >
        {status?.text ?? (updated ? `Atualizado ${updated}` : null)}
      </p>
    </div>
  );
}

/** A line of text in a card: the read in progress, or a period with nothing in it. */
function CardNote({
  children,
  description,
  loading,
}: {
  children: string;
  description?: ReactNode;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardContent
        className="grid gap-1 text-center"
        role={loading ? "status" : undefined}
      >
        <p className={loading ? "text-muted-foreground" : "font-medium"}>
          {children}
        </p>
        {description ? (
          <p className="text-muted-foreground text-support">{description}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface ContentProps {
  /** `expense:create`: the empty period offers the way to a new expense only to who can register one. */
  canCreateExpense: boolean;
  /** The days of the period before the one asked for, for the chips of the cards (null while not read, or when the result's chip cannot exist: `resultChipPeriod`). */
  comparison: ComparisonDays | null;
  /** The same days as `dailySales` read them, for the chips of sales and ticket (null while not read). */
  salesComparison: ComparisonSales | null;
  /** Opens the Histórico on a period; null when the sales cannot be listed to match the card (no connection, or figures from the device's copy). */
  onOpenSales: ((period: Period) => void) | null;
  /** What the person asked for: the figures on screen may still be those of the period before it (AC-3). */
  period: Period;
  state: PeriodSummaryState;
  thisYear: string;
  timezone: string;
}

/** Only the comparison of the figures on screen: never the one of a period still loading. */
function onScreen<T extends { period: Period }>(
  comparison: T | null,
  shown: Period,
  today: string
): T | null {
  return samePeriod(comparison?.period ?? null, comparisonPeriod(shown, today))
    ? comparison
    : null;
}

function Content({
  canCreateExpense,
  comparison,
  onOpenSales,
  salesComparison,
  period,
  state,
  thisYear,
  timezone,
}: ContentProps) {
  const { summary } = state;
  if (summary === null) {
    return state.isLoading ? (
      <CardNote
        description={
          <SlowReadNote
            className="block min-h-5"
            key={`${period.from}/${period.to}`}
          />
        }
        loading
      >
        Carregando o resultado…
      </CardNote>
    ) : null;
  }
  // the label is always the period of the figures, never the one asked for while they are still the older ones
  const shown = periodText(summary.period, thisYear);
  const behind = !samePeriod(summary.period, period);
  const stale = behind && state.isLoading;
  // the store's today on the server's clock of the figures, the same that cuts the chart (AC-6)
  const today = calendarDayInTimezone(new Date(summary.generatedAt), timezone);
  if (summary.quality.level === "no_data") {
    return <EmptyResult canCreateExpense={canCreateExpense} period={shown} />;
  }
  return (
    <div
      className={cn(
        "grid gap-5 motion-full:transition-opacity",
        stale && "opacity-60"
      )}
      data-stale={stale ? "" : undefined}
    >
      <ResultCards
        comparison={onScreen(comparison, summary.period, today)}
        onOpenSales={stale ? null : onOpenSales}
        salesComparison={onScreen(salesComparison, summary.period, today)}
        summary={summary}
        today={today}
      />
      <QualityBanner quality={summary.quality} />
      <ResultChart
        source={state.source}
        summary={summary}
        timezone={timezone}
      />
      <ResultChain canCreateExpense={canCreateExpense} summary={summary} />
    </div>
  );
}

interface Selection {
  /** The range of "Período", once the person gave a valid one. */
  custom: Period | null;
  preset: PeriodPreset;
}

/**
 * The result of a period, and the goals as a second tab (corte resultado-v2). Every figure comes from the server; when it
 * cannot answer, the last confirmed result this device kept for the month is shown as such. Work still waiting on
 * the device is never part of the figures. The two tabs read apart: the goals with their own period, the result with
 * the one chosen here, and each keeps its read when the other is in front (AC-15).
 */
export function DashboardPage() {
  const { organization, organizationId } = useCurrentOrganization();
  const canCreateExpense = hasCapabilityForRole(
    organization.role,
    "expense:create"
  );
  // the first read has only the device's clock to name "hoje"; the server's answer corrects it (below)
  const [today, setToday] = useState(() =>
    calendarDayInTimezone(new Date(), organization.timezone)
  );
  const [selection, setSelection] = useState<Selection>(() => {
    const requested = periodFromState(readNavigationState(RESULT_PERIOD_STATE));
    if (requested === null) {
      return { custom: null, preset: "this-month" };
    }
    const preset = presetOfPeriod(requested, today);
    return { custom: preset === "custom" ? requested : null, preset };
  });
  useEffect(() => dropNavigationState(RESULT_PERIOD_STATE), []);
  const period = useMemo(
    () =>
      presetPeriod(selection.preset, today, selection.custom) ??
      (presetPeriod("this-month", today, null) as Period),
    [selection, today]
  );
  const copyMonth = copyMonthOf(selection.preset, period);
  const [tab, handleTab] = useScreenTab("dashboard", RESULT_TABS);
  // an expense written in Despesas makes the read old: the Resultado reads it again when it is back in front
  const { refresh, state } = usePeriodSummary(
    organizationId,
    period,
    copyMonth,
    tab === "resultado"
  );
  // the period before is read only after the server answered for the period asked, with figures to compare
  const answered =
    state.source === "server" &&
    state.summary !== null &&
    samePeriod(state.summary.period, period) &&
    state.summary.quality.level !== "no_data";
  const compared = answered ? comparisonPeriod(period, today) : null;
  // the engine reads the period before only for a chip the result can have: known days and some known cost
  const answeredSummary = answered ? state.summary : null;
  const comparedResult = answeredSummary
    ? resultChipPeriod(answeredSummary, today)
    : null;
  const comparison = useComparisonDays(organizationId, comparedResult);
  const salesComparison = useComparisonSales(organizationId, compared);
  // "hoje" is the store's day on the server's clock, the same that cuts the series (AC-1, AC-10): when the device
  // disagrees, the periods are computed again once, from the server's day, and read again
  const serverToday =
    state.source === "server" && state.summary
      ? calendarDayInTimezone(
          new Date(state.summary.generatedAt),
          organization.timezone
        )
      : null;
  useEffect(() => {
    if (serverToday !== null && serverToday !== today) {
      setToday(serverToday);
    }
  }, [serverToday, today]);
  const snapshot = useRuntimeSnapshot();
  const online = useConnectionOnline();
  const goals = useGoals(organizationId);
  const [initialTab] = useState(
    () => requestedTab("dashboard", window.location.search).value
  );
  // before the effects of the form dialog `?meta=nova` opens: on a phone it pushes its entry over this address
  useLayoutEffect(() => {
    // the links of the Início open the Metas tab: the address keeps it from now on
    if (initialTab === "metas") {
      replaceAddress(
        addressWithTab(window.location.href, "dashboard", "metas")
      );
    }
  }, [initialTab]);
  const handleOpenSales = useCallback((sales: Period) => {
    navigateInApp("/sales/history", { [HISTORY_PERIOD_STATE]: sales });
  }, []);
  const handlePreset = useCallback((preset: PeriodPreset) => {
    setSelection({ custom: null, preset });
  }, []);
  const handleCustom = useCallback((custom: Period) => {
    setSelection({ custom, preset: "custom" });
  }, []);

  const inProgress =
    goals.state.isLoading || goals.state.error !== null
      ? 0
      : groupGoals(goals.state.goals).active.length;

  return (
    <div className="grid gap-5 font-sans text-foreground text-sm antialiased">
      <Heading />
      <Tabs className="min-w-0 gap-5" onValueChange={handleTab} value={tab}>
        <ScreenTabList label="Resultado e metas" value={tab}>
          <ScreenTabTrigger value="resultado">Resultado</ScreenTabTrigger>
          <ScreenTabTrigger value="metas">
            Metas
            {inProgress > 0 ? (
              <Badge variant="secondary">
                {inProgress}
                <span className="sr-only"> em andamento</span>
              </Badge>
            ) : null}
          </ScreenTabTrigger>
        </ScreenTabList>
        <TabsContent className="grid gap-5" value="resultado">
          <Toolbar
            onCustom={handleCustom}
            onPreset={handlePreset}
            onRefresh={refresh}
            period={period}
            preset={selection.preset}
            state={state}
            thisYear={today.slice(0, 4)}
            today={today}
            timezone={organization.timezone}
          />
          {state.summary && state.source === "cache" ? (
            <OfflineCopyNotice
              generatedAt={state.summary.generatedAt}
              online={
                online && state.serverFailed ? { onRetry: refresh } : undefined
              }
              timezone={organization.timezone}
              waitingOperations={snapshot ? waitingOperations(snapshot) : 0}
            />
          ) : null}
          {state.error ? (
            <LoadError
              busy={state.isLoading}
              message={state.error}
              onRetry={refresh}
            />
          ) : null}
          <div aria-busy={state.isLoading} className="grid gap-5">
            <Content
              canCreateExpense={canCreateExpense}
              comparison={comparison}
              salesComparison={salesComparison}
              onOpenSales={
                online && state.source === "server" ? handleOpenSales : null
              }
              period={period}
              state={state}
              thisYear={today.slice(0, 4)}
              timezone={organization.timezone}
            />
          </div>
        </TabsContent>
        {/* kept mounted: a goal being typed is still there when the person comes back from the other tab */}
        <TabsContent keepMounted value="metas">
          <GoalsPanel
            goals={goals}
            month={monthOfDay(today)}
            organizationId={organizationId}
            timezone={organization.timezone}
            today={today}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
