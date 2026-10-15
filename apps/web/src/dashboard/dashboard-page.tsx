import { useMemo, useState } from "react";
import { formatMonthLabel, monthOfDay } from "../expenses/expense-model";
import { useCurrentOrganization } from "../lib/current-organization";
import { calendarDayInTimezone } from "../lib/dates";
import { useRuntimeSnapshot } from "../offline/runtime/runtime-context";
import { waitingOperations } from "../offline/runtime/sync-status";
import { formatUpdatedUntil } from "./dashboard-model";
import { GoalsPanel } from "./goals-panel";
import { MonthSelector } from "./month-selector";
import { OfflineCopyNotice } from "./offline-copy-notice";
import { QualityBanner } from "./quality-banner";
import { ResultCards } from "./result-cards";
import { ResultChain } from "./result-chain";
import {
  type PeriodSummaryState,
  usePeriodSummary,
} from "./use-period-summary";
import "./dashboard-page.css";

function Heading() {
  return (
    <section className="categories-heading">
      <div>
        <p className="categories-eyebrow">Visão do período</p>
        <h1>Resultado</h1>
        <p className="categories-intro-copy">
          O resultado operacional é uma estimativa a partir das vendas
          confirmadas e das despesas do mês. Não é lucro líquido nem dinheiro já
          recebido. Custos e taxas que ainda não são conhecidos ficam de fora
          das contas, e o aviso abaixo diz o quanto.
        </p>
      </div>
    </section>
  );
}

interface ToolbarProps {
  month: string;
  onMonthChange: (month: string) => void;
  onRefresh: () => void;
  state: PeriodSummaryState;
  timezone: string;
}

function Toolbar({
  month,
  onMonthChange,
  onRefresh,
  state,
  timezone,
}: ToolbarProps) {
  const { isLoading, source, summary } = state;
  return (
    <div className="dashboard-toolbar">
      <MonthSelector month={month} onChange={onMonthChange} />
      <div className="dashboard-refresh">
        <p aria-live="polite" className="dashboard-updated">
          {isLoading ? "Atualizando…" : null}
          {!isLoading && summary && source === "server"
            ? formatUpdatedUntil(summary.generatedAt, timezone)
            : null}
        </p>
        <button
          className="quiet-button"
          disabled={isLoading}
          onClick={onRefresh}
          type="button"
        >
          Atualizar
        </button>
      </div>
    </div>
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
      <p className="dashboard-empty-state" role="status">
        Carregando o resultado…
      </p>
    ) : null;
  }
  if (summary.quality.level === "no_data") {
    return (
      <>
        <QualityBanner quality={summary.quality} />
        <p className="dashboard-empty-state">
          Não há vendas nem despesas em {formatMonthLabel(month)}. Escolha outro
          mês ou registre vendas e despesas para ver o resultado.
        </p>
      </>
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
    <div className="dashboard-page">
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
        <p className="categories-message is-error" role="alert">
          {state.error}{" "}
          <button
            className="quiet-button"
            disabled={state.isLoading}
            onClick={refresh}
            type="button"
          >
            Tentar de novo
          </button>
        </p>
      ) : null}
      <div aria-busy={state.isLoading}>
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
