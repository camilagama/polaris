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
