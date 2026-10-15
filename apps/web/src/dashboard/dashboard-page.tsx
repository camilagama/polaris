import { useMemo, useState } from "react";
import { formatMonthLabel, monthOfDay } from "../expenses/expense-model";
import { useCurrentOrganization } from "../lib/current-organization";
import { calendarDayInTimezone } from "../lib/dates";
import { formatUpdatedAt } from "./dashboard-model";
import { MonthSelector } from "./month-selector";
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
}

function Toolbar({ month, onMonthChange, onRefresh, state }: ToolbarProps) {
  const { isLoading, loadedAt } = state;
  return (
    <div className="dashboard-toolbar">
      <MonthSelector month={month} onChange={onMonthChange} />
      <div className="dashboard-refresh">
        <p aria-live="polite" className="dashboard-updated">
          {isLoading ? "Atualizando…" : null}
          {!isLoading && loadedAt ? formatUpdatedAt(loadedAt) : null}
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

/** The result of a month: online only, every figure comes from the server. */
export function DashboardPage() {
  const { organization, organizationId } = useCurrentOrganization();
  const today = useMemo(
    () => calendarDayInTimezone(new Date(), organization.timezone),
    [organization.timezone]
  );
  const [month, setMonth] = useState(() => monthOfDay(today));
  const { refresh, state } = usePeriodSummary(organizationId, month);

  return (
    <div className="dashboard-page">
      <Heading />
      <Toolbar
        month={month}
        onMonthChange={setMonth}
        onRefresh={refresh}
        state={state}
      />
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
    </div>
  );
}
