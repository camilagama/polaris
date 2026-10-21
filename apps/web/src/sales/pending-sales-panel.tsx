import { useEffect, useState } from "react";
import type { LocalWorkspace } from "../offline/runtime/use-local-workspace";
import type { PendingSale } from "../offline/sale-confirm";
import { pendingSales } from "../offline/sale-confirm";

export const pendingDateTime = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
});

export const pendingStateLabels: Record<PendingSale["state"], string> = {
  needs_attention: "Precisa de atenção",
  pending: "Aguardando envio",
  rejected: "Recusada pelo servidor",
  syncing: "Enviando…",
};

/** The sales this device still holds for the server, read again after any sync or change. */
export function usePendingSales(workspace: LocalWorkspace): PendingSale[] {
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
  return sales;
}

/**
 * The sales this device still holds for the server, with their state, in the look of the old screens (the
 * sales history). The sale screen has its own card (offline-sale-panels.tsx).
 */
export function PendingSalesPanel({
  workspace,
}: {
  workspace: LocalWorkspace;
}) {
  const sales = usePendingSales(workspace);
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
            {pendingDateTime.format(new Date(sale.occurredAt))} ·{" "}
            {sale.itemCount} {sale.itemCount === 1 ? "item" : "itens"} ·{" "}
            <strong>{pendingStateLabels[sale.state]}</strong>
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
