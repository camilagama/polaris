import { HelpTip } from "@/ui/help-tip";
import { HideValuesButton } from "@/ui/hidden-values";
import { hasCapabilityForRole } from "@polaris/domain/authorization/capabilities";
import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
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
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { Skeleton } from "@/ui/skeleton";
import { Tabs, TabsContent } from "@/ui/tabs";
import { replaceAddress } from "../app-shell/address";
import { lazyScreen } from "../app-shell/lazy-screen";
import { addressWithTab, requestedTab } from "../app-shell/navigation-model";
import { SlowReadNote } from "../app-shell/read-wait";
import {
  ScreenTabList,
  ScreenTabPanel,
  ScreenTabTrigger,
  type TabPanel,
  useScreenTab,
} from "../app-shell/screen-tabs";
import { LoadError } from "../expenses/expense-fields";
import { monthOfDay } from "../expenses/expense-model";
import { useConnectionOnline } from "../lib/browser-connection";
import { useCurrentOrganization } from "../lib/current-organization";
import { calendarDayInTimezone } from "../lib/dates";
import { useRuntimeSnapshot } from "../offline/runtime/runtime-context";
import { waitingOperations } from "../offline/runtime/sync-status";
import { formatLastConfirmed, formatUpdatedUntil } from "./dashboard-model";
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
  type Period,
  type PeriodPreset,
  periodText,
  presetPeriod,
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

const RESULT_TABS = ["resultado", "metas", "despesas"] as const;

/**
 * The expenses while their chunk loads: the shape of the screen of an empty month (the heading, the parts, the month
 * and the card of the list), so the screen that comes takes the place of the skeleton instead of growing out of a
 * short "Carregando…".
 */
function ExpensesLoading() {
  return (
    <div className="grid gap-4" role="status">
      <span className="sr-only">Carregando as despesas…</span>
      <div aria-hidden="true" className="grid gap-1">
        <div className="flex h-5 items-center">
          <Skeleton className="h-4 w-20" />
        </div>
        <Skeleton className="h-9 w-full max-w-xl md:h-[1.125rem]" />
      </div>
      <Skeleton
        aria-hidden="true"
        className="h-ctl-md w-72 max-w-full rounded-lg"
      />
      <Skeleton
        aria-hidden="true"
        className="h-[6.8125rem] w-full md:h-[3.5625rem]"
      />
      <Skeleton
        aria-hidden="true"
        className="h-[23.9375rem] w-full rounded-xl md:h-[21.3125rem]"
      />
    </div>
  );
}

/** The expenses, the third tab (map of navigation, § 1; `/expenses` opens it): their own chunk, as their screen was. */
const EXPENSES_PANEL: TabPanel = {
  fallback: <ExpensesLoading />,
  Screen: lazyScreen(() =>
    import("../expenses/expenses-page").then((module) => ({
      default: module.ExpensesPage,
    }))
  ),
  value: "despesas",
};

function Heading() {
  return (
    <header className="flex items-center gap-1">
      <h1 className="text-title">Resultado</h1>
      <HelpTip about="Resultado">
        Estimativa com as vendas confirmadas e as despesas do período. Não é
        lucro líquido nem dinheiro recebido.
      </HelpTip>
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
}

/**
 * Which read the line beside the period talks about: the server's, or the copy the device kept. While another period
 * loads, the figures of the one before stay on the screen, dimmed, and this line says which they are: in its own place,
 * so nothing is put above the figures and nothing moves (no line comes and goes over them).
 */
function updatedText(
  state: PeriodSummaryState,
  timezone: string,
  period: Period,
  thisYear: string
): string | null {
  const { isLoading, source, summary } = state;
  if (isLoading) {
    return summary && !samePeriod(summary.period, period)
      ? `Mostrando ${periodText(summary.period, thisYear)} até o novo período carregar.`
      : "Atualizando…";
  }
  if (!summary) {
    return null;
  }
  return source === "server"
    ? formatUpdatedUntil(summary.generatedAt, timezone)
    : formatLastConfirmed(summary.generatedAt, timezone);
}

function Toolbar({
  onCustom,
  onPreset,
  onRefresh,
  period,
  preset,
  state,
  thisYear,
  timezone,
}: ToolbarProps) {
  return (
    <div className="grid gap-4">
      <PeriodPicker
        onCustom={onCustom}
        onPreset={onPreset}
        period={period}
        preset={preset}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-4">
        <Button
          disabled={state.isLoading}
          onClick={onRefresh}
          size="sm"
          type="button"
          variant="outline"
        >
          <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
          Atualizar
        </Button>
        {/* v7 § 6: the same choice as on the Início, kept on the device */}
        <HideValuesButton size="sm" />
        {/* two lines kept on a phone, where "Mostrando … até o novo período carregar." takes two */}
        <p
          aria-live="polite"
          className="min-h-9 basis-full self-center text-muted-foreground text-support md:min-h-0 md:basis-auto"
          id="dashboard-updated"
        >
          {updatedText(state, timezone, period, thisYear)}
        </p>
      </div>
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
      <ResultChain summary={summary} />
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
  const [selection, setSelection] = useState<Selection>({
    custom: null,
    preset: "this-month",
  });
  const period = useMemo(
    () =>
      presetPeriod(selection.preset, today, selection.custom) ??
      (presetPeriod("this-month", today, null) as Period),
    [selection, today]
  );
  const copyMonth = copyMonthOf(selection.preset, period);
  const [tab, handleTab] = useScreenTab("dashboard", RESULT_TABS);
  // an expense written in the Despesas tab makes the read old: the Resultado reads it again when it is back in front
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
      <Tabs className="gap-5" onValueChange={handleTab} value={tab}>
        <ScreenTabList label="Resultado, metas e despesas" value={tab}>
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
          <ScreenTabTrigger value="despesas">Despesas</ScreenTabTrigger>
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
        {/* the expenses, a screen of their own (UI-H changes their inside): loaded when the tab opens */}
        <ScreenTabPanel panel={EXPENSES_PANEL} />
      </Tabs>
    </div>
  );
}
