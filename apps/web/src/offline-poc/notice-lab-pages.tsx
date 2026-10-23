import { useCallback, useState } from "react";
import type { AttentionItem, AttentionSummary } from "../offline/attention";
import { AttentionPanel } from "../offline/attention-panel";
import { OfflineAccessExpiredView } from "../offline/runtime/offline-access-expired";
import type { RuntimeSnapshot } from "../offline/runtime/offline-runtime";

/**
 * Two screens that need no server and no outbox to be drawn, for the interface guardrails (`?screen=attention` and
 * `?screen=access-expired` of the lab of the screens): the panel of what the server refused and the notice of the
 * offline access that expired, over synthetic data. The wiring with the real outbox and the real runtime is proved
 * by `e2e/offline-attention.e2e.ts` and `e2e/offline-runtime-api.e2e.ts`. Only in the lab and browser-check builds.
 */
const param = (name: string) =>
  new URLSearchParams(window.location.search).get(name);

const ITEMS: AttentionItem[] = [
  {
    actions: ["resubmit", "discard"],
    blocksQueue: true,
    cause: "insufficient_stock",
    code: "insufficient_stock",
    commandId: "0199c2d0-0000-7000-8000-000000000101",
    detail:
      "O estoque do servidor não cobre esta venda. Confira o estoque e reenvie, ou descarte e refaça a venda.",
    kind: "sale",
    title: "Venda de 2 itens",
  },
  {
    actions: ["discard"],
    blocksQueue: false,
    cause: "sku_conflict",
    code: "sku_conflict",
    commandId: "0199c2d0-0000-7000-8000-000000000102",
    detail: "Outro produto já usa este SKU. Descarte e cadastre de novo.",
    kind: "product",
    title: "Produto Camiseta Básica de algodão com um nome bem comprido",
  },
  {
    actions: ["review_account"],
    blocksQueue: false,
    cause: "entitlement_changed",
    code: "entitlement_changed",
    commandId: "0199c2d0-0000-7000-8000-000000000103",
    detail:
      "O plano desta organização mudou e não inclui mais esta operação. Revise o acesso e o plano.",
    kind: "stock",
    title: "Entrada de estoque",
  },
];

const noop = () => undefined;

export function AttentionLabPage() {
  const state = param("state");
  const [error, setError] = useState<string | null>(
    state === "error" ? "Não foi possível reenviar. Tente de novo." : null
  );
  const summary: AttentionSummary =
    state === "empty"
      ? { items: [], waitingBehind: 0 }
      : { items: ITEMS, waitingBehind: 2 };
  const handleReview = useCallback(
    () =>
      setError(
        "Abra o menu e use Sair para entrar de novo com uma conta autorizada. O que está na fila fica guardado neste aparelho até lá."
      ),
    []
  );
  return (
    <AttentionPanel
      errorMessage={error}
      onDiscard={noop}
      onResubmit={noop}
      onReviewAccount={handleReview}
      summary={summary}
    />
  );
}

/** `&online=1` is the connection back, still renewing or failing to; `&open=1` is the access ending with the app open. */
export function AccessExpiredLabPage() {
  const online = param("online") === "1";
  const snapshot: RuntimeSnapshot = {
    bootstrapped: false,
    counts: { pending: 2, rejected: 1, sending: 0 },
    dataVersion: 0,
    expiredWhileOpen: param("open") === "1",
    lastSyncAt: null,
    leaseExpiresAt: "2026-10-17T12:00:00.000Z",
    legalAcceptanceRequired: false,
    online,
    phase: "expired",
    reason: "offline_access_expired",
    renewalRefused: false,
    sessionRefused: false,
    syncing: false,
  };
  return (
    <OfflineAccessExpiredView
      onRetry={online ? noop : undefined}
      snapshot={snapshot}
    />
  );
}
