import type { LocalWriter } from "./bootstrap";
import { discardPendingCustomer } from "./customer-create";
import { discardPendingCustomerUpdate } from "./customer-update";
import type { OutboxCommand } from "./outbox/command";
import type { Outbox, OutboxSnapshot } from "./outbox/outbox";
import { discardPendingProduct } from "./product-create";
import { discardPendingSale, resubmitRejectedSale } from "./sale-confirm";
import { discardPendingStock } from "./stock-commands";

/**
 * The operations that need a person (plan PR58): everything the server refused
 * and the device is still holding. Each item says what happened in the owner's
 * words and offers only the actions that are honest for that cause. There is no
 * generic "force the sync": a refusal is a fact about the server's data, and
 * the only ways out are to fix the cause and resubmit (a sale), to redo the work
 * from fresh data (discard), or to fix the account.
 *
 * The queue is strictly ordered, so a refused command blocks every command
 * behind it; `waitingBehind` tells the person how much is held up.
 */
type AttentionCause =
  | "authorization_revoked"
  | "entitlement_changed"
  | "id_conflict"
  | "insufficient_stock"
  | "other"
  | "profile_changed"
  | "profile_unavailable"
  | "sale_too_old"
  | "sku_conflict"
  | "unavailable"
  | "version_conflict";

export type AttentionAction =
  | "discard"
  | "resubmit"
  | "resubmit_without_profile"
  | "retry"
  | "review_account";

export interface AttentionItem {
  actions: AttentionAction[];
  /** True when the command is the one currently holding the queue. */
  blocksQueue: boolean;
  cause: AttentionCause;
  code: string;
  commandId: string;
  /** What the person can do about it, in plain words. */
  detail: string;
  kind: "customer" | "customer_update" | "product" | "sale" | "stock";
  title: string;
}

export interface AttentionSummary {
  items: AttentionItem[];
  /** Commands queued behind the refused ones, held up until they are resolved. */
  waitingBehind: number;
}

/** Refusals about the account or the device, not about the data. */
const ACCOUNT_CAUSES: Readonly<Record<string, AttentionCause>> = {
  authorization_revoked: "authorization_revoked",
  capability_not_in_lease: "authorization_revoked",
  entitlement_changed: "entitlement_changed",
  invalid_creation_time: "authorization_revoked",
  lease_invalid: "authorization_revoked",
  wrong_device: "authorization_revoked",
};

const DATA_CAUSES: Readonly<Record<string, AttentionCause>> = {
  category_unavailable: "unavailable",
  customer_anonymized: "unavailable",
  customer_id_conflict: "id_conflict",
  customer_not_found: "unavailable",
  customer_version_conflict: "version_conflict",
  insufficient_stock: "insufficient_stock",
  inventory_version_conflict: "version_conflict",
  payment_profile_changed: "profile_changed",
  payment_profile_unavailable: "profile_unavailable",
  product_deleted: "unavailable",
  product_id_conflict: "id_conflict",
  sale_occurred_too_old: "sale_too_old",
  sale_product_unavailable: "unavailable",
  sku_conflict: "sku_conflict",
  variant_not_found: "unavailable",
};

/** The causes a sale can recover from by being sent again once fixed. */
const RESUBMITTABLE: ReadonlySet<AttentionCause> = new Set([
  "insufficient_stock",
  "unavailable",
]);

function causeOf(code: string): AttentionCause {
  return ACCOUNT_CAUSES[code] ?? DATA_CAUSES[code] ?? "other";
}

function kindOf(command: OutboxCommand): AttentionItem["kind"] | null {
  if (command.type === "customer.create") {
    return "customer";
  }
  if (command.type === "customer.update") {
    return "customer_update";
  }
  if (command.type === "product.create") {
    return "product";
  }
  if (command.type === "sale.confirm") {
    return "sale";
  }
  return command.type.startsWith("stock.") ? "stock" : null;
}

function field(command: OutboxCommand, name: string): unknown {
  const { payload } = command;
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)[name]
    : undefined;
}

const STOCK_LABELS: Readonly<Record<string, string>> = {
  "stock.count": "Contagem de estoque",
  "stock.receive": "Entrada de estoque",
  "stock.write_off": "Baixa de estoque",
};

function titleOf(command: OutboxCommand, kind: AttentionItem["kind"]): string {
  if (kind === "customer") {
    return `Cliente ${String(field(command, "name") ?? "")}`.trim();
  }
  if (kind === "customer_update") {
    return `Alteração do cliente ${String(field(command, "name") ?? "")}`.trim();
  }
  if (kind === "product") {
    return `Produto ${String(field(command, "name") ?? "")}`.trim();
  }
  if (kind === "sale") {
    const items = field(command, "items");
    const count = Array.isArray(items) ? items.length : 0;
    return `Venda de ${count} ${count === 1 ? "item" : "itens"}`;
  }
  const quantity =
    field(command, "quantity") ?? field(command, "physicalQuantity");
  const label = STOCK_LABELS[command.type] ?? "Movimento de estoque";
  return typeof quantity === "number" ? `${label}: ${quantity}` : label;
}

function detailOf(cause: AttentionCause, kind: AttentionItem["kind"]): string {
  switch (cause) {
    case "insufficient_stock":
      return kind === "sale"
        ? "O estoque do servidor não cobre esta venda: outro aparelho vendeu ou baixou estoque enquanto este estava sem rede. Receba o estoque que falta e reenvie a venda, ou descarte-a se ela não aconteceu."
        : "O estoque do servidor é menor do que este aparelho mostrava. Descarte a baixa, confira o saldo atual e registre de novo se ainda fizer sentido.";
    case "version_conflict":
      return kind === "customer_update"
        ? "Este cliente foi alterado em outro lugar depois que este aparelho o viu, então a sua alteração não foi aplicada e nada foi sobrescrito. Descarte-a, confira o cadastro atual e edite de novo se ainda fizer sentido."
        : "O saldo mudou depois da sua contagem: outro aparelho moveu o estoque. Descarte esta contagem e conte de novo com o saldo atualizado.";
    case "sku_conflict":
      return "Outro produto já usa este SKU. Descarte este cadastro e crie o produto de novo com outro SKU.";
    case "id_conflict":
      return "Este registro colidiu com outro que já existe. Descarte-o e cadastre de novo.";
    case "unavailable":
      if (kind === "customer_update") {
        return "Este cliente não existe mais nesta organização. Descarte a alteração.";
      }
      return kind === "sale"
        ? "Um dos produtos desta venda não está mais disponível (arquivado, removido ou inexistente). Restaure o produto e reenvie a venda, ou descarte-a."
        : "O produto ou a categoria deste registro não está mais disponível. Restaure-o e refaça o registro.";
    case "profile_changed":
      return "O perfil de pagamento usado nesta venda mudou (taxas ou prazo) depois que este aparelho o viu, então o servidor não a registrou com ele. Reenvie a venda sem perfil de pagamento (taxas e prazo ficam desconhecidos) ou descarte-a e refaça a venda com o perfil atual.";
    case "profile_unavailable":
      return "O perfil de pagamento usado nesta venda foi arquivado ou removido. Reenvie a venda sem perfil de pagamento (taxas e prazo ficam desconhecidos) ou descarte-a e refaça a venda com outro perfil.";
    case "sale_too_old":
      return "Esta venda é mais antiga que a janela em que o sistema aceita registros retroativos. Ela não pode ser enviada como está; descarte-a e registre a venda de outra forma.";
    case "entitlement_changed":
      return "O plano desta organização não permite mais estes registros. Regularize o plano e use Tentar de novo: o registro é enviado como está. Nada foi perdido.";
    case "authorization_revoked":
      return "O acesso deste aparelho ou desta conta mudou: foi removido, revogado ou expirou. Entre de novo com uma conta autorizada; se o acesso não voltar, este registro não poderá ser enviado.";
    default:
      return "O servidor recusou este registro. Descarte-o e refaça a operação com os dados atuais.";
  }
}

function actionsFor(
  cause: AttentionCause,
  kind: AttentionItem["kind"]
): AttentionAction[] {
  if (cause === "entitlement_changed") {
    // the refusal is not stored: once the plan allows it, the same command goes through
    return ["review_account", "retry"];
  }
  if (cause === "authorization_revoked") {
    return ["review_account", "discard"];
  }
  if (
    kind === "sale" &&
    (cause === "profile_changed" || cause === "profile_unavailable")
  ) {
    return ["resubmit_without_profile", "discard"];
  }
  return kind === "sale" && RESUBMITTABLE.has(cause)
    ? ["resubmit", "discard"]
    : ["discard"];
}

/** Turns the outbox into what the attention panel shows. */
export function buildAttention(snapshot: OutboxSnapshot): AttentionSummary {
  const items = snapshot.commands.flatMap((command) => {
    const kind = kindOf(command);
    if (command.status !== "rejected" || kind === null) {
      return [];
    }
    const code = command.rejection?.code ?? "rejected";
    const cause = causeOf(code);
    return [
      {
        actions: actionsFor(cause, kind),
        blocksQueue: snapshot.blockedBy?.commandId === command.commandId,
        cause,
        code,
        commandId: command.commandId,
        detail: detailOf(cause, kind),
        kind,
        title: titleOf(command, kind),
      },
    ];
  });
  const refused = new Set(items.map((item) => item.commandId));
  return {
    items,
    // Pending commands only wait on something when something was refused.
    waitingBehind:
      items.length === 0
        ? 0
        : snapshot.commands.filter(
            (command) =>
              command.status === "pending" && !refused.has(command.commandId)
          ).length,
  };
}

/** What discarding an item removes, said before the person confirms. */
export function discardWarning(item: AttentionItem): string {
  switch (item.kind) {
    case "sale":
      return "A venda será apagada deste aparelho e não será registrada. Confirme só se ela não aconteceu.";
    case "product":
      return "O produto e o estoque de abertura digitados serão apagados deste aparelho.";
    case "customer":
      return "O cliente será apagado deste aparelho.";
    case "customer_update":
      return "A alteração será apagada deste aparelho. O cadastro continua como está no servidor.";
    default:
      return "Este movimento de estoque será apagado deste aparelho e não será registrado.";
  }
}

export interface AttentionDependencies {
  outbox: Outbox;
  writer: LocalWriter;
}

/** The explicit "discard" action, routed to the module that owns the command. */
export async function discardAttentionItem(
  item: AttentionItem,
  { outbox, writer }: AttentionDependencies
): Promise<void> {
  if (!item.actions.includes("discard")) {
    throw new Error("action_not_available");
  }
  switch (item.kind) {
    case "customer":
      await discardPendingCustomer(outbox, writer, item.commandId);
      return;
    case "customer_update":
      await discardPendingCustomerUpdate(outbox, item.commandId);
      return;
    case "product":
      await discardPendingProduct(outbox, writer, item.commandId);
      return;
    case "sale":
      await discardPendingSale(outbox, item.commandId);
      return;
    default:
      await discardPendingStock(outbox, item.commandId);
  }
}

/**
 * The "send it again" action: a sale whose cause can have been fixed, or any
 * command the server refused only because of the plan (it sends the very same
 * command again).
 */
export async function resubmitAttentionItem(
  item: AttentionItem,
  { lease, outbox }: { lease: string; outbox: Outbox }
): Promise<void> {
  if (item.actions.includes("retry")) {
    await outbox.retry(item.commandId);
    return;
  }
  const withoutProfile = item.actions.includes("resubmit_without_profile");
  if (
    !(
      item.kind === "sale" &&
      (withoutProfile || item.actions.includes("resubmit"))
    )
  ) {
    throw new Error("action_not_available");
  }
  await resubmitRejectedSale(outbox, {
    commandId: item.commandId,
    lease,
    withoutProfile,
  });
}
