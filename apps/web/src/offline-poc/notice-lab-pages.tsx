import type { AttentionItem, AttentionSummary } from "../offline/attention";
import {
  type AttentionError,
  AttentionPanel,
} from "../offline/attention-panel";

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
      "O estoque do servidor não cobre esta venda: outro aparelho mexeu nele enquanto este estava sem rede. Receba o que falta e toque em Reenviar venda, ou descarte se a venda não aconteceu.",
    kind: "sale",
    title: "Venda de R$ 20,00 · 14/10 09:30",
  },
  {
    actions: ["discard"],
    blocksQueue: false,
    cause: "sku_conflict",
    code: "sku_conflict",
    commandId: "0199c2d0-0000-7000-8000-000000000102",
    detail:
      "Outro produto já usa este SKU. Crie o produto de novo com outro SKU e descarte este cadastro.",
    kind: "product",
    title: "Produto Camiseta Básica de algodão com um nome bem comprido",
  },
  {
    actions: ["open_subscription", "retry"],
    blocksQueue: false,
    cause: "entitlement_changed",
    code: "entitlement_changed",
    commandId: "0199c2d0-0000-7000-8000-000000000103",
    detail:
      "O plano desta loja não permite mais este registro; nada foi perdido. Regularize o plano em Ver Assinatura e toque em Tentar novamente.",
    kind: "stock",
    title: "Entrada de estoque",
  },
  {
    actions: ["sign_in_again", "discard"],
    blocksQueue: false,
    cause: "authorization_revoked",
    code: "authorization_revoked",
    commandId: "0199c2d0-0000-7000-8000-000000000104",
    detail:
      "O servidor recusou esta venda: a permissão deste aparelho mudou depois que ela foi registrada (por exemplo, a loja foi encerrada e reaberta). Ela não é enviada sozinha. Se a venda ainda valer, registre a venda de novo e depois descarte esta. Se o seu acesso mudou, use Sair e entrar de novo.",
    kind: "sale",
    title: "Venda de R$ 89,90 · 01/11 14:20",
  },
];

const noop = () => undefined;
const FIRST_ID = "0199c2d0-0000-7000-8000-000000000101";

export function AttentionLabPage() {
  const state = param("state");
  const error: AttentionError | null =
    state === "error"
      ? {
          commandId: FIRST_ID,
          message: "Não foi possível reenviar. Tente de novo.",
        }
      : null;
  const summary: AttentionSummary =
    state === "empty"
      ? { items: [], waitingBehind: 0 }
      : { items: ITEMS, waitingBehind: 2 };
  return (
    <AttentionPanel
      error={error}
      onDiscard={noop}
      onResubmit={noop}
      onSignInAgain={noop}
      summary={summary}
    />
  );
}
