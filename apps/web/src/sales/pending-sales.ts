import { useEffect, useState } from "react";
import type { LocalWorkspace } from "../offline/runtime/use-local-workspace";
import type { PendingSale } from "../offline/sale-confirm";
import { pendingSales } from "../offline/sale-confirm";

export const pendingDateTime = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
});

/** Where a sale kept on the device stands, in words: the phase of its line. `sent` is a sale the server took while the card was open. */
export type SalePhase = PendingSale["state"] | "sent";

export const salePhaseLabels: Record<SalePhase, string> = {
  needs_attention: "Precisa de atenção",
  pending: "Guardada",
  rejected: "Precisa de atenção",
  sent: "Enviada",
  syncing: "Enviando",
};

/** The sales this device still holds for the server, read again after any sync or change. */
export function usePendingSales(
  workspace: LocalWorkspace | null
): PendingSale[] {
  const [sales, setSales] = useState<PendingSale[]>([]);
  const outbox = workspace?.stores.outbox;
  const dataVersion = workspace?.dataVersion ?? 0;

  useEffect(() => {
    if (!outbox) {
      setSales([]);
      return;
    }
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
