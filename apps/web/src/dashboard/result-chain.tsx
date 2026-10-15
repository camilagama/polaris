import type { PeriodSummaryReadModel } from "@polaris/contracts";
import { type ChainRow, chainRows } from "./dashboard-model";

function rowClass(row: ChainRow): string {
  const classes = ["dashboard-chain-row", `is-${row.kind}`];
  if (row.negative) {
    classes.push("is-negative");
  }
  return classes.join(" ");
}

/** "Como chegamos a este resultado": from gross sales to the estimated result, line by line. */
export function ResultChain({ summary }: { summary: PeriodSummaryReadModel }) {
  const rows = chainRows(summary.chain, summary.quality);
  return (
    <section
      aria-labelledby="dashboard-chain-heading"
      className="dashboard-panel"
    >
      <div className="dashboard-panel-heading">
        <p className="categories-eyebrow">Passo a passo</p>
        <h2 id="dashboard-chain-heading">Como chegamos a este resultado</h2>
      </div>
      <div className="dashboard-chain-body">
        <table className="dashboard-chain">
          <caption className="visually-hidden">
            Das vendas brutas ao resultado operacional estimado
          </caption>
          <thead>
            <tr>
              <th scope="col">Etapa</th>
              <th scope="col">Valor</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className={rowClass(row)} key={row.id}>
                <th scope="row">
                  {row.label}
                  {row.note ? (
                    <span className="dashboard-chain-note">{row.note}</span>
                  ) : null}
                </th>
                <td>{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="dashboard-chain-footnote">
          Despesas do período são as que não estão ligadas a uma venda, contadas
          pelo mês de competência. O resultado é uma estimativa operacional, não
          lucro líquido nem caixa liquidado.
        </p>
      </div>
    </section>
  );
}
