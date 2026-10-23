import { useCallback, useState } from "react";
import type { AttentionItem, AttentionSummary } from "../offline/attention";
import { AttentionPanel } from "../offline/attention-panel";

/**
 * Pendências in the lab of the screens (`?screen=attention`), for the interface guardrails: the panel of what the
 * server refused, over synthetic data and with no outbox. The wiring with the real outbox and the real runtime is
 * proved by `e2e/offline-attention.e2e.ts`. Only in the lab and browser-check builds.
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
