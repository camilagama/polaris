import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import type { UpdateSnapshot, UpdateStore } from "./update-store";

/**
 * Tells the person a new version is ready and what applying it needs (plan
 * PR61). It never reloads by itself: it offers, explains when the update has to
 * wait for the queue, and applies on a click.
 */
export interface UpdateBannerViewProps {
  onApply: () => void;
  snapshot: UpdateSnapshot;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function UpdateBannerView({ onApply, snapshot }: UpdateBannerViewProps) {
  const { offer } = snapshot;
  if (offer.kind === "none") {
    return null;
  }
  return (
    <Alert
      aria-label="Atualização do aplicativo"
      className="mb-4 font-sans"
      data-notice="update"
      data-ui=""
    >
      <RefreshCwIcon aria-hidden="true" />
      <AlertTitle aria-level={2} role="heading">
        Há uma nova versão do Polaris
      </AlertTitle>
      <AlertDescription className="grid justify-items-start gap-2 [&_p:not(:last-child)]:mb-0">
        {offer.kind === "ready" ? (
          <p>Atualize quando for conveniente: a página será recarregada.</p>
        ) : null}
        {offer.kind === "after_sync" ? (
          <p>
            Há {plural(offer.pending + offer.sending, "operação", "operações")}{" "}
            na fila. Ao atualizar, elas são enviadas primeiro, e a página só é
            recarregada se a fila ficar vazia.
          </p>
        ) : null}
        {offer.kind === "deferred" ? (
          <p>
            O servidor recusou {plural(offer.rejected, "operação", "operações")}
            . A atualização espera até que{" "}
            {offer.rejected === 1 ? "ela seja" : "elas sejam"} resolvida
            {offer.rejected === 1 ? "" : "s"} em “Operações que precisam de
            atenção”. Nada foi perdido.
          </p>
        ) : null}
        {snapshot.message ? (
          <p className="font-medium text-destructive" role="alert">
            {snapshot.message}
          </p>
        ) : null}
        {offer.kind === "deferred" ? null : (
          <Button disabled={snapshot.applying} onClick={onApply} type="button">
            {offer.kind === "after_sync"
              ? "Enviar e atualizar"
              : "Atualizar agora"}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

const POLL_MS = 15_000;

/** Connects the banner to the update store and keeps the queue figures fresh. */
export function UpdateBanner({ store }: { store: UpdateStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const apply = useCallback(() => {
    store.requestUpdate().catch(() => undefined);
  }, [store]);
  useEffect(() => {
    if (!snapshot.waiting) {
      return;
    }
    const timer = setInterval(() => {
      store.refreshWork().catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [snapshot.waiting, store]);
  return <UpdateBannerView onApply={apply} snapshot={snapshot} />;
}
