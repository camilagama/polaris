import type { RefObject } from "react";
import { useEffect, useState } from "react";
import type { LocalWorkspace } from "../offline/runtime/use-local-workspace";
import type { PendingSale } from "../offline/sale-confirm";
import { pendingSales } from "../offline/sale-confirm";
import type { QueuedSaleView } from "./sale-form-model";

const dateTime = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
});

const stateLabels: Record<PendingSale["state"], string> = {
  needs_attention: "Precisa de atenção",
  pending: "Aguardando envio",
  rejected: "Recusada pelo servidor",
  syncing: "Enviando…",
};

/** Said at the top of the sale form while there is no connection. */
export function OfflineSaleNotice() {
  return (
    <p className="sale-message is-warning" role="status">
      Sem conexão. A venda será guardada neste aparelho e confirmada pelo
      servidor quando a conexão voltar. O estoque mostrado é o do aparelho: se
      não bastar quando o servidor conferir, a venda é recusada e fica em{" "}
      <a href="/attention">Pendências</a> para você corrigir. Sem perfil de
      pagamento, taxas e prazo ficam desconhecidos.
    </p>
  );
}

/** After a sale was queued on the device: it is NOT an official sale yet. */
export function QueuedSalePanel({
  panelRef,
  sale,
}: {
  panelRef: RefObject<HTMLElement | null>;
  sale: QueuedSaleView;
}) {
  return (
    <section
      aria-labelledby="sale-queued-title"
      className="sale-confirmed"
      ref={panelRef}
      tabIndex={-1}
    >
      <h2 id="sale-queued-title" role="status">
        Venda guardada neste aparelho
      </h2>
      <p>
        Total devido: <strong>{sale.totalDue}</strong>. Ela só vira uma venda
        confirmada quando o servidor aceitar, assim que houver conexão.
      </p>
      {sale.stockWarnings.length > 0 ? (
        <div className="sale-message is-warning" role="note">
          <p>
            O estoque do aparelho parece não cobrir{" "}
            {sale.stockWarnings.length === 1 ? "este item" : "estes itens"}. A
            venda foi guardada mesmo assim; o servidor confere e pode recusá-la.
          </p>
          <ul>
            {sale.stockWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="sale-hint">
        <a href="/attention">Acompanhar em Pendências</a>
      </p>
      <p className="sale-hint">
        O formulário abaixo foi reiniciado para uma nova venda.
      </p>
    </section>
  );
}

/** The sales this device still holds for the server, with their state. */
export function PendingSalesPanel({
  workspace,
}: {
  workspace: LocalWorkspace;
}) {
  const [sales, setSales] = useState<PendingSale[]>([]);
  const { outbox } = workspace.stores;
  const { dataVersion } = workspace;

  useEffect(() => {
    let current = true;
    // dataVersion re-reads the queue after any sync or change
    pendingSales(outbox)
      .then((found) => {
        if (current && dataVersion >= 0) {
          setSales(found);
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [outbox, dataVersion]);

  if (sales.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="sale-pending-title" className="sale-section">
      <h2 id="sale-pending-title">
        Vendas neste aparelho aguardando o servidor
      </h2>
      <ul>
        {sales.map((sale) => (
          <li key={sale.commandId}>
            {dateTime.format(new Date(sale.occurredAt))} · {sale.itemCount}{" "}
            {sale.itemCount === 1 ? "item" : "itens"} ·{" "}
            <strong>{stateLabels[sale.state]}</strong>
            {sale.state === "rejected" || sale.state === "needs_attention" ? (
              <>
                {" "}
                · <a href="/attention">Resolver em Pendências</a>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
