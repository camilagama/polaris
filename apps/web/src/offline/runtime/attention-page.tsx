import { useCallback, useEffect, useState } from "react";
import {
  type AttentionItem,
  type AttentionSummary,
  buildAttention,
  discardAttentionItem,
  resubmitAttentionItem,
} from "../attention";
import { AttentionPanel } from "../attention-panel";
import { useOfflineRuntime, useRuntimeSnapshot } from "./runtime-context";

/**
 * The page of operations that need attention (ADR 0038), over the runtime's real
 * outbox. It re-reads the queue whenever the runtime's figures change, so a sync
 * that clears or refuses something is reflected at once.
 */
const EMPTY: AttentionSummary = { items: [], waitingBehind: 0 };

export function AttentionPage() {
  const runtime = useOfflineRuntime();
  const snapshot = useRuntimeSnapshot();
  const [summary, setSummary] = useState<AttentionSummary>(EMPTY);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const counts = snapshot?.counts;
  useEffect(() => {
    const context = runtime?.context();
    if (!context) {
      setSummary(EMPTY);
      return;
    }
    let current = true;
    context.outbox
      .snapshot()
      .then((queue) => {
        if (current) {
          setSummary(buildAttention(queue));
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
    // the figures change whenever the queue does
  }, [runtime, counts]);

  const resolve = useCallback(
    async (item: AttentionItem, work: () => Promise<void>, message: string) => {
      setBusy(item.commandId);
      setError(null);
      try {
        await work();
        await runtime?.refreshCounts();
        runtime?.syncNow().catch(() => undefined);
      } catch {
        setError(message);
      } finally {
        setBusy(null);
      }
    },
    [runtime]
  );

  const handleDiscard = useCallback(
    (item: AttentionItem) => {
      const context = runtime?.context();
      if (context) {
        resolve(
          item,
          () => discardAttentionItem(item, context),
          "Não foi possível descartar. Tente de novo."
        ).catch(() => undefined);
      }
    },
    [resolve, runtime]
  );
  const handleResubmit = useCallback(
    (item: AttentionItem) => {
      const context = runtime?.context();
      if (context) {
        resolve(
          item,
          () => resubmitAttentionItem(item, context),
          "Não foi possível reenviar. Tente de novo."
        ).catch(() => undefined);
      }
    },
    [resolve, runtime]
  );
  const handleReviewAccount = useCallback(
    () =>
      setError(
        "Abra o menu e use Sair para entrar de novo com uma conta autorizada. O que está na fila fica guardado neste aparelho até lá."
      ),
    []
  );

  if (!(runtime && snapshot)) {
    return (
      <section className="attention-panel">
        <h2>Operações que precisam de atenção</h2>
        <p>O modo offline não está ativo neste aparelho.</p>
      </section>
    );
  }
  if (snapshot.phase !== "ready") {
    return (
      <p className="app-status" role="status">
        {snapshot.phase === "unavailable"
          ? "O modo offline não está disponível neste aparelho agora."
          : "Preparando o modo offline…"}
      </p>
    );
  }
  return (
    <AttentionPanel
      busyCommandId={busy}
      errorMessage={error}
      onDiscard={handleDiscard}
      onResubmit={handleResubmit}
      onReviewAccount={handleReviewAccount}
      summary={summary}
    />
  );
}
