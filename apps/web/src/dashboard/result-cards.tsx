import type { PeriodSummaryReadModel } from "@polaris/contracts";
import type { ReactNode } from "react";
import { formatQuantity } from "../lib/format";
import {
  formatMoneyOrDash,
  formatPercentOrDash,
  isIncompleteEstimate,
} from "./dashboard-model";

interface ResultCardProps {
  children?: ReactNode;
  className?: string;
  hint?: string;
  label: string;
  value: string;
}

function ResultCard({
  children,
  className,
  hint,
  label,
  value,
}: ResultCardProps) {
  return (
    <div
      className={className ? `dashboard-card ${className}` : "dashboard-card"}
    >
      <dt className="dashboard-card-label">
        {label}
        {children}
      </dt>
      <dd className="dashboard-card-value">{value}</dd>
      {hint ? <dd className="dashboard-card-hint">{hint}</dd> : null}
    </div>
  );
}

/** The six figures of the period; a figure that does not exist shows a dash. */
export function ResultCards({ summary }: { summary: PeriodSummaryReadModel }) {
  const { cards, quality } = summary;
  const incomplete = isIncompleteEstimate(quality);
  const negative = cards.operatingResult.trim().startsWith("-");
  const resultClass = negative
    ? "dashboard-card-result is-negative"
    : "dashboard-card-result";
  return (
    <dl className="dashboard-cards">
      <ResultCard
        label="Vendas líquidas"
        value={formatMoneyOrDash(cards.netSales)}
      />
      <ResultCard
        className={resultClass}
        hint="Estimativa: não é lucro líquido nem dinheiro já recebido."
        label="Resultado estimado"
        value={formatMoneyOrDash(cards.operatingResult)}
      >
        {incomplete ? (
          <span className="category-status status-archived dashboard-incomplete-tag">
            estimativa incompleta
          </span>
        ) : null}
      </ResultCard>
      <ResultCard
        hint="Margem de contribuição sobre as vendas líquidas."
        label="Margem"
        value={formatPercentOrDash(cards.marginPercent)}
      >
        {incomplete ? (
          <span className="category-status status-archived dashboard-incomplete-tag">
            estimativa incompleta
          </span>
        ) : null}
      </ResultCard>
      <ResultCard label="Vendas" value={formatQuantity(cards.salesCount)} />
      <ResultCard
        label="Ticket médio"
        value={formatMoneyOrDash(cards.ticket)}
      />
      <ResultCard label="Itens vendidos" value={formatQuantity(cards.items)} />
    </dl>
  );
}
