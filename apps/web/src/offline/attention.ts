import { formatBrlAmount, formatShortInstant } from "../lib/format";
import { SUPPORT_EMAIL } from "../lib/support-contact";
import type { LocalWriter } from "./bootstrap";
import { discardPendingCustomer } from "./customer-create";
import { discardPendingCustomerUpdate } from "./customer-update";
import type { OutboxCommand } from "./outbox/command";
import type { Outbox, OutboxSnapshot } from "./outbox/outbox";
import { discardPendingProduct } from "./product-create";
import {
  discardPendingSale,
  partMethodsOf,
  refusedProfileOfParts,
  refusedSaleFacts,
  resubmitRejectedSale,
} from "./sale-confirm";
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
  | "command_too_old"
  | "entitlement_changed"
  | "id_conflict"
  | "insufficient_stock"
  | "other"
  | "profile_changed"
  | "profile_unavailable"
  | "sale_too_old"
  | "session_changed"
  | "sku_conflict"
  | "unavailable"
  | "version_conflict";

export type AttentionAction =
  | "discard"
  | "redo_sale"
  | "resubmit"
  | "resubmit_without_profile"
  | "retry"
  | "open_subscription"
  | "sign_in_again";

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
  /** True when the sale was redone: a new sale was confirmed or kept, and this refused one can go. */
  redone: boolean;
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
  session_changed: "session_changed",
  wrong_device: "authorization_revoked",
};

const DATA_CAUSES: Readonly<Record<string, AttentionCause>> = {
  category_unavailable: "unavailable",
  command_too_old: "command_too_old",
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

/**
 * A sale paid in parts, as the device keeps it: the ordinals (1, 2) of the parts priced with the profile a refusal is
 * about, when the device can tell (`refusedProfileOfParts`), or null when it cannot. Null for a sale of one payment.
 */
interface SplitSaleFacts {
  refusedParts: number[] | null;
}

function splitSaleFacts(command: OutboxCommand): SplitSaleFacts | null {
  const payments = field(command, "payments");
  // one part is a sale paid in one go for every screen (the form, the redo, the panels)
  if (!Array.isArray(payments) || payments.length < 2) {
    return null;
  }
  const parts = payments.map((part) => {
    const profile = (part as { paymentProfile?: unknown } | null)
      ?.paymentProfile;
    return {
      paymentProfile:
        typeof profile === "object" &&
        profile !== null &&
        typeof (profile as { id?: unknown }).id === "string"
          ? { id: (profile as { id: string }).id }
          : null,
    };
  });
  const refused = refusedProfileOfParts(parts);
  return {
    refusedParts:
      refused === null
        ? null
        : parts.flatMap((part, index) =>
            part.paymentProfile?.id === refused ? [index + 1] : []
          ),
  };
}

const STOCK_LABELS: Readonly<Record<string, string>> = {
  "stock.count": "Contagem de estoque",
  "stock.receive": "Entrada de estoque",
  "stock.write_off": "Baixa de estoque",
};

/**
 * The short names of the methods, as the sale screen writes them (`SALE_METHOD_CARDS`, which a test keeps equal). Not
 * imported from the screen: the PostgreSQL gates import this module and must not reach the sale form.
 */
export const PART_METHOD_LABELS: ReadonlyMap<string, string> = new Map([
  ["pix", "Pix"],
  ["cash", "Dinheiro"],
  ["credit_card", "Crédito"],
  ["debit_card", "Débito"],
  ["bank_transfer", "Transferência"],
  ["other", "Outro"],
]);

/**
 * "Venda de R$ 89,90 · 01/11 14:20": the value and the moment tell two refused sales apart; the count of items when the
 * payload has no total. A sale paid in parts names its parts ("Venda de R$ 300,00 · Pix + Crédito · 01/11 14:20").
 */
function saleTitle(command: OutboxCommand): string {
  const sale = refusedSaleFacts(command);
  const items = field(command, "items");
  const count = Array.isArray(items) ? items.length : 0;
  const what = sale?.totalDue
    ? formatBrlAmount(sale.totalDue)
    : `${count} ${count === 1 ? "item" : "itens"}`;
  const parts = partMethodsOf(command.payload)
    ?.map((method) => PART_METHOD_LABELS.get(method) ?? "Outro")
    .join(" + ");
  return [
    `Venda de ${what}`,
    parts,
    sale ? formatShortInstant(sale.occurredAt) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

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
    return saleTitle(command);
  }
  const quantity =
    field(command, "quantity") ?? field(command, "physicalQuantity");
  const label = STOCK_LABELS[command.type] ?? "Movimento de estoque";
  return typeof quantity === "number" ? `${label}: ${quantity}` : label;
}

const REVOKED_CODE = "authorization_revoked";
const INVALID_PAYLOAD_CODE = "invalid_payload";

function revokedDetail(kind: AttentionItem["kind"]): string {
  if (kind === "sale") {
    return "O servidor recusou esta venda porque a permissão deste aparelho mudou. Ela não é enviada sozinha. Se a venda aconteceu, toque em Refazer esta venda e, depois de confirmar a nova, descarte esta. Se o seu acesso mudou, use Sair e entrar de novo.";
  }
  return "O servidor recusou este registro: a permissão deste aparelho mudou depois que ele foi feito (por exemplo, a loja foi encerrada e reaberta). Ele não é enviado sozinho. Se ainda valer, anote o que ele tinha, descarte este e faça o registro de novo. Se o seu acesso mudou, use Sair e entrar de novo.";
}

const REDONE_DETAIL =
  "Você já refez esta venda: a venda nova foi confirmada ou guardada neste aparelho. Esta, recusada, pode ser descartada sem perder nada.";

const PLAN_DETAIL_WITHOUT_SUBSCRIPTION = `O plano desta loja não permite mais este registro; nada foi perdido. Regularize o plano com o suporte (${SUPPORT_EMAIL}) e toque em Tentar novamente.`;

function partsText(parts: readonly number[]): string {
  return parts.length === 1 ? `da parte ${parts[0]}` : "das duas partes";
}

/**
 * A sale paid in parts refused for a profile: the whole sale was refused. Redo brings both parts back to Vender with
 * the current profiles; sending it again without the profile exists only when the device knows which parts it is.
 */
function splitProfileDetail(
  cause: "profile_changed" | "profile_unavailable",
  split: SplitSaleFacts
): string {
  const what =
    cause === "profile_changed"
      ? "mudou (taxas ou prazo) depois que este aparelho o viu"
      : "foi arquivado ou removido";
  const redo =
    "Toque em Refazer esta venda: as duas partes voltam a Vender com os perfis atuais, para você revisar a prévia de cada uma, e depois de confirmar a nova você descarta esta.";
  if (split.refusedParts === null) {
    return `O perfil de pagamento de uma das partes desta venda ${what}, e a venda inteira foi recusada. ${redo}`;
  }
  const parts = partsText(split.refusedParts);
  const untouched =
    split.refusedParts.length === 1 ? ", e a outra parte não muda" : "";
  return `O perfil de pagamento ${parts} desta venda ${what}, e a venda inteira foi recusada. ${redo} Ou toque em Reenviar sem perfil de pagamento: as taxas e o prazo ${parts} ficam desconhecidos${untouched}.`;
}

const SPLIT_INVALID_PAYLOAD_DETAIL =
  "O servidor recusou esta venda dividida como inválida (acontece quando ele ainda está numa versão sem pagamento em partes); nada foi registrado e as duas partes estão guardadas aqui. Toque em Refazer esta venda: as duas partes voltam a Vender e, depois de confirmar a nova, você descarta esta.";

function splitDetailOf(
  cause: AttentionCause,
  code: string,
  split: SplitSaleFacts
): string | null {
  if (cause === "profile_changed" || cause === "profile_unavailable") {
    return splitProfileDetail(cause, split);
  }
  return cause === "other" && code === INVALID_PAYLOAD_CODE
    ? SPLIT_INVALID_PAYLOAD_DETAIL
    : null;
}

function detailOf(
  cause: AttentionCause,
  kind: AttentionItem["kind"],
  code: string,
  options: {
    redone: boolean;
    split: SplitSaleFacts | null;
    subscriptionAvailable: boolean;
  }
): string {
  const { redone, split, subscriptionAvailable } = options;
  if (redone && kind === "sale" && (code === REVOKED_CODE || split !== null)) {
    return REDONE_DETAIL;
  }
  const splitDetail = split === null ? null : splitDetailOf(cause, code, split);
  if (splitDetail !== null) {
    return splitDetail;
  }
  switch (cause) {
    case "insufficient_stock":
      return kind === "sale"
        ? "O estoque do servidor não cobre esta venda: o saldo mudou enquanto este aparelho estava sem rede. Receba o que falta e toque em Reenviar venda, ou descarte se a venda não aconteceu."
        : "O estoque do servidor é menor do que este aparelho mostrava, então a baixa não foi registrada. Confira o saldo atual, registre de novo se ainda fizer sentido e descarte esta.";
    case "version_conflict":
      return kind === "customer_update"
        ? "Este cliente foi alterado em outro lugar depois que este aparelho o viu; nada foi sobrescrito. Confira o cadastro atual, edite de novo se ainda fizer sentido e descarte esta alteração."
        : "O saldo mudou depois da contagem: outro aparelho moveu o estoque. Conte de novo com o saldo atual e descarte esta contagem.";
    case "sku_conflict":
      return "Outro produto já usa este SKU. Crie o produto de novo com outro SKU e descarte este cadastro.";
    case "id_conflict":
      return "Este registro colidiu com outro que já existe. Cadastre de novo e descarte este.";
    case "unavailable":
      if (kind === "customer_update") {
        return "Este cliente não existe mais nesta loja, então a alteração não vale. Descarte-a.";
      }
      return kind === "sale"
        ? "Um produto desta venda não está mais disponível (arquivado ou removido). Restaure-o e toque em Reenviar venda, ou descarte a venda."
        : "O produto ou a categoria deste registro não está mais disponível. Restaure-o, refaça o registro e descarte este.";
    case "profile_changed":
      return "O perfil de pagamento desta venda mudou (taxas ou prazo) depois que este aparelho o viu. Toque em Reenviar sem perfil de pagamento (taxas e prazo ficam desconhecidos) ou descarte e refaça a venda com o perfil atual.";
    case "profile_unavailable":
      return "O perfil de pagamento desta venda foi arquivado ou removido. Toque em Reenviar sem perfil de pagamento (taxas e prazo ficam desconhecidos) ou descarte e refaça a venda com outro perfil.";
    case "command_too_old":
      return "Este registro tem mais de 90 dias, e o servidor já não reconhece um reenvio. Confira se ele já entrou (vendas, estoque ou cadastro) e só então descarte.";
    case "sale_too_old":
      return "Esta venda é mais antiga que a janela de registros retroativos e não pode ser enviada como está. Registre a venda de outra forma e descarte esta.";
    case "entitlement_changed":
      return subscriptionAvailable
        ? "O plano desta loja não permite mais este registro; nada foi perdido. Regularize o plano em Ver Assinatura e toque em Tentar novamente."
        : PLAN_DETAIL_WITHOUT_SUBSCRIPTION;
    case "session_changed":
      return "Este registro foi feito por outra conta, e o servidor não o recebeu; nada foi perdido. Entre com a conta que o criou e toque em Tentar novamente.";
    case "authorization_revoked":
      if (code === REVOKED_CODE) {
        return revokedDetail(kind);
      }
      return "O acesso deste aparelho ou desta conta mudou: foi removido, revogado ou expirou. Use Sair e entrar de novo com uma conta autorizada; se o acesso não voltar, este registro não poderá ser enviado.";
    default:
      return "O servidor recusou este registro. Refaça a operação com os dados atuais e descarte este.";
  }
}

/**
 * A sale refused for its profile: a single payment is sent again without it; a sale in parts is redone with both
 * parts, and sent again without the profile only when the device knows which parts carry it.
 */
function profileRefusalActions(
  split: SplitSaleFacts | null,
  redone: boolean
): AttentionAction[] {
  if (split === null) {
    return ["resubmit_without_profile", "discard"];
  }
  if (redone) {
    return ["discard"];
  }
  return split.refusedParts === null
    ? ["redo_sale", "discard"]
    : ["redo_sale", "resubmit_without_profile", "discard"];
}

function actionsFor(
  cause: AttentionCause,
  kind: AttentionItem["kind"],
  options: {
    code: string;
    redone: boolean;
    split: SplitSaleFacts | null;
    subscriptionAvailable: boolean;
  }
): AttentionAction[] {
  if (cause === "entitlement_changed") {
    // the refusal is not stored: once the plan allows it, the same command goes through; without the Assinatura tab
    // there is nowhere to send the person
    return options.subscriptionAvailable
      ? ["open_subscription", "retry"]
      : ["retry"];
  }
  if (cause === "session_changed") {
    // the same command goes through once the account that made it signs in
    return ["sign_in_again", "retry"];
  }
  if (cause === "authorization_revoked") {
    if (kind === "sale" && options.code === REVOKED_CODE) {
      return options.redone
        ? ["discard"]
        : ["redo_sale", "sign_in_again", "discard"];
    }
    return ["sign_in_again", "discard"];
  }
  if (
    kind === "sale" &&
    (cause === "profile_changed" || cause === "profile_unavailable")
  ) {
    return profileRefusalActions(options.split, options.redone);
  }
  if (
    kind === "sale" &&
    cause === "other" &&
    options.split !== null &&
    options.code === INVALID_PAYLOAD_CODE
  ) {
    // a Worker without the parts refuses the whole sale this way; either way the parts are still on the device
    return options.redone ? ["discard"] : ["redo_sale", "discard"];
  }
  return kind === "sale" && RESUBMITTABLE.has(cause)
    ? ["resubmit", "discard"]
    : ["discard"];
}

export interface AttentionOptions {
  /**
   * The "Assinatura" tab of Configurações exists for this person (billing self-service on and a role that manages it,
   * ADR 0104). Without it, the plan card does not point there.
   */
  subscriptionAvailable?: boolean;
}

/**
 * Turns the outbox into what the attention panel shows. `redone` holds the refused sales that already have their new
 * sale (the link Vender keeps), so the card offers to discard the refused one instead of redoing it twice.
 */
export function buildAttention(
  snapshot: OutboxSnapshot,
  redone: ReadonlySet<string> = new Set(),
  { subscriptionAvailable = true }: AttentionOptions = {}
): AttentionSummary {
  const items = snapshot.commands.flatMap((command) => {
    const kind = kindOf(command);
    if (command.status !== "rejected" || kind === null) {
      return [];
    }
    const code = command.rejection?.code ?? "rejected";
    const cause = causeOf(code);
    const isRedone = kind === "sale" && redone.has(command.commandId);
    const split = kind === "sale" ? splitSaleFacts(command) : null;
    return [
      {
        actions: actionsFor(cause, kind, {
          code,
          redone: isRedone,
          split,
          subscriptionAvailable,
        }),
        blocksQueue: snapshot.blockedBy?.commandId === command.commandId,
        cause,
        code,
        commandId: command.commandId,
        detail: detailOf(cause, kind, code, {
          redone: isRedone,
          split,
          subscriptionAvailable,
        }),
        kind,
        redone: isRedone,
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
      if (item.redone) {
        return "Esta venda recusada será apagada deste aparelho. A venda refeita já está registrada ou guardada e não muda.";
      }
      return item.code === REVOKED_CODE
        ? "A venda será apagada deste aparelho e não será registrada. Se ela aconteceu, use Refazer esta venda antes: depois do descarte os itens não ficam guardados. Confirme só se ela não aconteceu."
        : "A venda será apagada deste aparelho e não será registrada. Confirme só se ela não aconteceu.";
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
