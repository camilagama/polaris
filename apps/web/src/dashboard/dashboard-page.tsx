import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { LoadError } from "../expenses/expense-fields";
import { monthOfDay } from "../expenses/expense-model";
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
import { type ResultTab, readResultTab, writeResultTab } from "./result-tab";
import { useGoals } from "./use-goals";
import {
  type PeriodSummaryState,
  usePeriodSummary,
} from "./use-period-summary";

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
  description?: string;
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
  /** What the person asked for: the figures on screen may still be those of the period before it (AC-3). */
  period: Period;
  state: PeriodSummaryState;
  thisYear: string;
  timezone: string;
}

function Content({ period, state, thisYear, timezone }: ContentProps) {
  const { summary } = state;
  if (summary === null) {
    return state.isLoading ? (
      <CardNote loading>Carregando o resultado…</CardNote>
    ) : null;
  }
  // the label is always the period of the figures, never the one asked for while they are still the older ones
  const shown = periodText(summary.period, thisYear);
  const behind = !samePeriod(summary.period, period);
  const stale = behind && state.isLoading;
  if (summary.quality.level === "no_data") {
    return (
      <CardNote description="Escolha outro período ou registre vendas e despesas.">
        {`Sem vendas nem despesas em ${shown}`}
      </CardNote>
    );
  }
  return (
    <div
      className={cn("grid gap-5 transition-opacity", stale && "opacity-60")}
      data-stale={stale ? "" : undefined}
    >
      {behind ? (
        <p
          className="text-muted-foreground text-support"
          role="status"
        >{`Mostrando ${shown} até o novo período carregar.`}</p>
      ) : null}
      <QualityBanner quality={summary.quality} />
      <ResultCards summary={summary} />
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
  const today = useMemo(
    () => calendarDayInTimezone(new Date(), organization.timezone),
    [organization.timezone]
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
  const snapshot = useRuntimeSnapshot();
  const goals = useGoals(organizationId);
  const [initialTab] = useState(() => readResultTab(window.location.search));
  const [tab, setTab] = useState<ResultTab>(initialTab);
  useEffect(() => {
    // the links of the Início open the Metas tab: the address keeps it from now on
    if (initialTab === "metas") {
      writeResultTab("metas");
    }
  }, [initialTab]);

  const handleTab = useCallback((value: unknown) => {
    const next: ResultTab = value === "metas" ? "metas" : "resultado";
    setTab(next);
    writeResultTab(next);
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
      <Tabs className="gap-5" onValueChange={handleTab} value={tab}>
        <TabsList aria-label="Resultado e metas">
          <TabsTrigger value="resultado">Resultado</TabsTrigger>
          <TabsTrigger value="metas">
            Metas
            {inProgress > 0 ? (
              <Badge variant="secondary">
                {inProgress}
                <span className="sr-only"> em andamento</span>
              </Badge>
            ) : null}
          </TabsTrigger>
        </TabsList>
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
