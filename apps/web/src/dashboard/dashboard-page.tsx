import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import { useMemo, useState } from "react";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { LoadError } from "../expenses/expense-fields";
import { formatMonthLabel, monthOfDay } from "../expenses/expense-model";
import { MonthPicker } from "../expenses/month-picker";
import { useCurrentOrganization } from "../lib/current-organization";
import { calendarDayInTimezone } from "../lib/dates";
import { useRuntimeSnapshot } from "../offline/runtime/runtime-context";
import { waitingOperations } from "../offline/runtime/sync-status";
import { formatLastConfirmed, formatUpdatedUntil } from "./dashboard-model";
import { GoalsPanel } from "./goals-panel";
import { OfflineCopyNotice } from "./offline-copy-notice";
import { QualityBanner } from "./quality-banner";
import { ResultCards } from "./result-cards";
import { ResultChain } from "./result-chain";
import {
  type PeriodSummaryState,
  usePeriodSummary,
} from "./use-period-summary";

function Heading() {
  return (
    <header className="grid gap-1">
      <h1 className="text-title">Resultado</h1>
      <p className="text-muted-foreground text-support">
        Estimativa com as vendas confirmadas e as despesas do mês. Não é lucro
        líquido nem dinheiro recebido.
      </p>
    </header>
  );
}

interface ToolbarProps {
  month: string;
  onMonthChange: (month: string) => void;
  onRefresh: () => void;
  state: PeriodSummaryState;
  timezone: string;
}

/** Which read the line beside the month talks about: the server's, or the copy the device kept. */
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
  month,
  onMonthChange,
  onRefresh,
  state,
  timezone,
}: ToolbarProps) {
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-4">
      <MonthPicker
        id="dashboard-month"
        label="Mês"
        month={month}
        onChange={onMonthChange}
      />
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
  );
}

/** A line of text in a card: the read in progress, or a month with nothing in it. */
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
  month: string;
  state: PeriodSummaryState;
}

function Content({ month, state }: ContentProps) {
  const { summary } = state;
  if (summary === null) {
    return state.isLoading ? (
      <CardNote loading>Carregando o resultado…</CardNote>
    ) : null;
  }
  if (summary.quality.level === "no_data") {
    return (
      <CardNote description="Escolha outro mês ou registre vendas e despesas.">
        {`Sem vendas nem despesas em ${formatMonthLabel(month)}`}
      </CardNote>
    );
  }
  return (
    <>
      <QualityBanner quality={summary.quality} />
      <ResultCards summary={summary} />
      <ResultChain summary={summary} />
    </>
  );
}

/**
 * The result of a month. Every figure comes from the server; when it cannot
 * answer, the last confirmed result this device kept is shown as such. Work
 * still waiting on the device is never part of the figures.
 */
export function DashboardPage() {
  const { organization, organizationId } = useCurrentOrganization();
  const today = useMemo(
    () => calendarDayInTimezone(new Date(), organization.timezone),
    [organization.timezone]
  );
  const [month, setMonth] = useState(() => monthOfDay(today));
  const { refresh, state } = usePeriodSummary(organizationId, month);
  const snapshot = useRuntimeSnapshot();

  return (
    <div
      className="grid gap-5 font-sans text-foreground text-sm antialiased"
    >
      <Heading />
      <Toolbar
        month={month}
        onMonthChange={setMonth}
        onRefresh={refresh}
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
        <Content month={month} state={state} />
      </div>
      <GoalsPanel
        month={month}
        organizationId={organizationId}
        timezone={organization.timezone}
        today={today}
      />
    </div>
  );
}
