import { HideValuesButton } from "@/ui/hidden-values";
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
import { comparisonPeriod } from "./result-kpis";
import { useGoals } from "./use-goals";
import {
  type ComparisonDays,
  type PeriodSummaryState,
  useComparisonDays,
  usePeriodSummary,
} from "./use-period-summary";

const RESULT_TABS = ["resultado", "metas", "despesas"] as const;

/** The expenses, the third tab (map of navigation, § 1; `/expenses` opens it): their own chunk, as their screen was. */
const EXPENSES_PANEL: TabPanel = {
  Screen: lazyScreen(() =>
    import("../expenses/expenses-page").then((module) => ({
      default: module.ExpensesPage,
    }))
  ),
  value: "despesas",
};

function Heading() {
  return (
    <header className="grid gap-1">
      <h1 className="text-title">Resultado</h1>
      <p className="text-muted-foreground text-support">
        Estimativa com as vendas confirmadas e as despesas do período. Não é
        lucro líquido nem dinheiro recebido.
      </p>
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
  timezone: string;
}

/** Which read the line beside the period talks about: the server's, or the copy the device kept. */
function updatedText(
  state: PeriodSummaryState,
  timezone: string
): string | null {
  const { isLoading, source, summary } = state;
  if (isLoading) {
    return "Atualizando…";
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
        <p
          aria-live="polite"
          className="basis-full self-center text-muted-foreground text-support md:basis-auto"
          id="dashboard-updated"
        >
          {updatedText(state, timezone)}
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
  /** The days of the period before the one asked for, for the chips of the cards (null while not read). */
  comparison: ComparisonDays | null;
  /** What the person asked for: the figures on screen may still be those of the period before it (AC-3). */
  period: Period;
  state: PeriodSummaryState;
  thisYear: string;
  timezone: string;
}

function Content({
  comparison,
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
    return (
      <CardNote description="Escolha outro período ou registre vendas e despesas.">
        {`Sem vendas nem despesas em ${shown}`}
      </CardNote>
    );
  }
  return (
    <div
      className={cn(
        "grid gap-5 motion-full:transition-opacity",
        stale && "opacity-60"
      )}
      data-stale={stale ? "" : undefined}
    >
      {behind ? (
        <p
          className="text-muted-foreground text-support"
          role="status"
        >{`Mostrando ${shown} até o novo período carregar.`}</p>
      ) : null}
      <QualityBanner quality={summary.quality} />
      <ResultCards
        comparison={
          // only the comparison of the figures on screen: never the one of a period still loading
          samePeriod(
            comparison?.period ?? null,
            comparisonPeriod(summary.period, today)
          )
            ? comparison
            : null
        }
        summary={summary}
        today={today}
      />
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
  const { refresh, state } = usePeriodSummary(
    organizationId,
    period,
    copyMonth
  );
  // the period before is read only after the server answered for the period asked, with figures to compare
  const answered =
    state.source === "server" &&
    state.summary !== null &&
    samePeriod(state.summary.period, period) &&
    state.summary.quality.level !== "no_data";
  const comparison = useComparisonDays(
    organizationId,
    answered ? comparisonPeriod(period, today) : null
  );
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
  const [tab, handleTab] = useScreenTab("dashboard", RESULT_TABS);
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
              comparison={comparison}
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
