import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { UpdateSnapshot, UpdateStore } from "./update-store";
import "./update-banner.css";

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
    <section
      aria-label="Atualização do aplicativo"
      className="update-banner"
      role="status"
    >
      <h2>Há uma nova versão do Polaris</h2>
      {offer.kind === "ready" ? (
        <p>Atualize quando for conveniente: a página será recarregada.</p>
      ) : null}
      {offer.kind === "after_sync" ? (
        <p>
          Há {plural(offer.pending + offer.sending, "operação", "operações")} na
          fila. Ao atualizar, elas são enviadas primeiro, e a página só é
          recarregada se a fila ficar vazia.
        </p>
      ) : null}
      {offer.kind === "deferred" ? (
        <p>
          O servidor recusou {plural(offer.rejected, "operação", "operações")}.
          A atualização espera até que{" "}
          {offer.rejected === 1 ? "ela seja" : "elas sejam"} resolvida
          {offer.rejected === 1 ? "" : "s"} em “Pendências”. Nada foi perdido.
        </p>
      ) : null}
      {snapshot.message ? (
        <p className="update-banner-message" role="alert">
          {snapshot.message}
        </p>
      ) : null}
      {offer.kind === "deferred" ? null : (
        <button
          className="primary-button"
          disabled={snapshot.applying}
          onClick={onApply}
          type="button"
        >
          {offer.kind === "after_sync"
            ? "Enviar e atualizar"
            : "Atualizar agora"}
        </button>
      )}
    </section>
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
