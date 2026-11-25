import {
  type InventoryBalanceEntryReadModel,
  type OfflineSalePayload,
  offlineSalePayloadSchema,
} from "@polaris/contracts";
import { calculateSaleAdjustments } from "@polaris/domain/sales/sale-adjustments";
import { variantFullLabel } from "../inventory/stock-target";
import { formatBrlAmount } from "../lib/format";
import { priceFieldText } from "../sales/last-prices-model";
import {
  type AdjustmentDraft,
  type ItemDraft,
  NO_PROFILE_CHOICE,
  type PaymentDraft,
  type ProfileSelectionDraft,
  type SaleFormState,
} from "../sales/sale-form-model";
import type { SplitDraft } from "../sales/sale-split-model";
import { itemChangesForEntry } from "../sales/sale-variant-picker-model";
import type { OutboxCommand } from "./outbox/command";

/**
 * Redoing a sale the server refused for its authorization, or a sale paid in parts refused for the profile of a part:
 * the sale the device still holds becomes the form of Vender again (with its parts, each with the profile and the
 * version it was priced with, so the form asks to review the one that changed), and confirming it makes a NEW sale (a new command ID). The refused command is never sent again and
 * nothing is removed here: the person discards it only once the new sale is recorded or kept.
 *
 * The form is filled only when every line can be sold as it was: a line whose variant left the catalog or whose
 * product was archived, or whose quantity the stock no longer covers, is said and the form is not filled at all, so
 * the person never confirms a sale that is not the one they made.
 */
export type RedoLineProblem =
  | { kind: "archived"; label: string }
  | { available: number; kind: "short"; label: string; requested: number }
  | { kind: "unavailable"; label: string };

export type RedoDraft =
  | { form: SaleFormState; kind: "ready" }
  | { kind: "blocked"; problems: RedoLineProblem[] }
  | { kind: "unreadable" };

function itemLine(
  item: OfflineSalePayload["items"][number],
  position: number
): string {
  return `Item ${position + 1} (${item.quantity} un. a ${formatBrlAmount(item.chargedUnitPrice)})`;
}

function adjustmentDraft(
  adjustment: OfflineSalePayload["adjustments"][number],
  draftId: string
): AdjustmentDraft {
  return adjustment.value.type === "fixed"
    ? {
        draftId,
        kind: adjustment.kind,
        value: priceFieldText(adjustment.value.amount),
        valueType: "fixed",
      }
    : {
        draftId,
        kind: adjustment.kind,
        value: adjustment.value.percentage.replace(".", ","),
        valueType: "percentage",
      };
}

function problemsOf(
  items: OfflineSalePayload["items"],
  entries: ReadonlyMap<string, InventoryBalanceEntryReadModel>
): RedoLineProblem[] {
  const requested = new Map<string, number>();
  for (const item of items) {
    requested.set(
      item.variantId,
      (requested.get(item.variantId) ?? 0) + item.quantity
    );
  }
  const problems: RedoLineProblem[] = [];
  const said = new Set<string>();
  for (const [position, item] of items.entries()) {
    const entry = entries.get(item.variantId);
    if (!entry) {
      problems.push({ kind: "unavailable", label: itemLine(item, position) });
    } else if (entry.productStatus !== "active") {
      if (!said.has(item.variantId)) {
        said.add(item.variantId);
        problems.push({ kind: "archived", label: variantFullLabel(entry) });
      }
    } else if (
      entry.quantity < (requested.get(item.variantId) ?? 0) &&
      !said.has(item.variantId)
    ) {
      said.add(item.variantId);
      problems.push({
        available: entry.quantity,
        kind: "short",
        label: variantFullLabel(entry),
        requested: requested.get(item.variantId) ?? 0,
      });
    }
  }
  return problems;
}

/** The variants a refused sale sold, each once: what is read before the form is filled. */
export function variantIdsOf(command: OutboxCommand): string[] {
  const parsed = offlineSalePayloadSchema.safeParse(command.payload);
  return parsed.success
    ? [...new Set(parsed.data.items.map((item) => item.variantId))]
    : [];
}

type StoredPayment = NonNullable<OfflineSalePayload["payment"]>;

function paymentDraft(payment: StoredPayment): PaymentDraft {
  return {
    anticipationRequested: payment.anticipationRequested,
    installmentPlan: payment.installmentPlan ?? "",
    installments:
      payment.installments === null ? "" : String(payment.installments),
    method: payment.method,
  };
}

/**
 * The profile chosen with the version the device saw: when the profile changed since, the form asks for the review of
 * that part ("Revisei a prévia da parte N"), and when it left the list the form says so in that part.
 */
function profileDraft(
  profile: { expectedVersion: number; id: string } | null | undefined
): ProfileSelectionDraft {
  return profile
    ? {
        choice: profile.id,
        reviewNotice: null,
        seenVersion: profile.expectedVersion,
      }
    : { choice: NO_PROFILE_CHOICE, reviewNotice: null, seenVersion: null };
}

function totalDueOf(sale: OfflineSalePayload): string | null {
  try {
    return calculateSaleAdjustments({
      adjustments: sale.adjustments,
      items: sale.items,
    }).totalDue;
  } catch {
    return null;
  }
}

/**
 * The payment of the form: a sale of one payment as it always was; a sale paid in parts comes back split, part 1 in the
 * payment of the form and part 2 typed (it does not follow the rest), each with its own profile. Null for a payload
 * that has neither, which the contract does not allow.
 */
function paymentOfForm(
  sale: OfflineSalePayload
): Pick<SaleFormState, "payment" | "profile" | "split"> | null {
  if (sale.payment !== undefined) {
    return {
      payment: paymentDraft(sale.payment),
      profile: profileDraft(sale.paymentProfile),
      split: null,
    };
  }
  const [first, second, ...more] = sale.payments ?? [];
  if (first === undefined || second === undefined || more.length > 0) {
    return null;
  }
  const split: SplitDraft = {
    firstAmount: priceFieldText(first.amount),
    second: {
      amount: priceFieldText(second.amount),
      payment: paymentDraft(second),
      profile: profileDraft(second.paymentProfile),
    },
    totalSeen: totalDueOf(sale),
  };
  return {
    payment: paymentDraft(first),
    profile: profileDraft(first.paymentProfile),
    split,
  };
}

/** The form of Vender for a refused sale, from the catalog and balances the server has now (the refused sale is not in them). */
export function buildRedoDraft(
  command: OutboxCommand,
  entries: readonly InventoryBalanceEntryReadModel[],
  createId: () => string
): RedoDraft {
  const parsed = offlineSalePayloadSchema.safeParse(command.payload);
  if (!parsed.success) {
    return { kind: "unreadable" };
  }
  const sale = parsed.data;
  const payment = paymentOfForm(sale);
  if (payment === null) {
    return { kind: "unreadable" };
  }
  const byVariant = new Map(entries.map((entry) => [entry.variantId, entry]));
  const problems = problemsOf(sale.items, byVariant);
  if (problems.length > 0) {
    return { kind: "blocked", problems };
  }
  const items: ItemDraft[] = sale.items.flatMap((item) => {
    const entry = byVariant.get(item.variantId);
    return entry
      ? [
          {
            ...itemChangesForEntry(entry),
            chargedUnitPrice: priceFieldText(item.chargedUnitPrice),
            draftId: createId(),
            listedUnitPrice: priceFieldText(item.listedUnitPrice),
            quantity: String(item.quantity),
          },
        ]
      : [];
  });
  return {
    form: {
      adjustments: sale.adjustments.map((adjustment) =>
        adjustmentDraft(adjustment, createId())
      ),
      items,
      occurredAtLocal: "",
      ...payment,
    },
    kind: "ready",
  };
}

/** What stopped the form from being filled, one line each, in the owner's words. */
export function redoProblemText(problem: RedoLineProblem): string {
  switch (problem.kind) {
    case "archived":
      return `${problem.label}: o produto foi arquivado e não está mais à venda.`;
    case "short":
      return `${problem.label}: a venda tinha ${problem.requested} un. e o saldo é ${problem.available}.`;
    default:
      return `${problem.label}: não está mais no catálogo.`;
  }
}

export const REDO_BLOCKED_MESSAGE =
  "Não preenchi a venda em Vender porque estes itens não podem ser vendidos como estavam. Resolva (receba o estoque, restaure o produto) e tente de novo, ou registre a venda à mão em Vender. Nada foi apagado.";
export const REDO_UNREADABLE_MESSAGE =
  "Não consegui ler os itens desta venda guardada. Nada foi apagado; registre a venda à mão em Vender antes de descartar esta.";
export const REDO_BUSY_MESSAGE =
  "Há uma venda em andamento em Vender. Termine ou limpe essa venda e volte aqui: assim ela não é trocada sem você querer.";
export const REDO_OPENED_NOTICE =
  "Você está refazendo uma venda recusada. Confira os itens e confirme: entra como uma venda nova, com a data e a hora de agora. Depois de confirmar, descarte a venda recusada em Pendências.";
export const REDO_DONE_NOTICE =
  "Venda refeita. A venda recusada continua em Pendências: descarte-a lá, agora que a nova está registrada.";
export const REDO_ALREADY_MESSAGE =
  "Esta venda já foi refeita (em outra aba ou antes). Nada foi apagado. Feche e abra Pendências para ver o estado atual.";
export const REDO_OFFLINE_MESSAGE =
  "Não consegui conferir agora o catálogo e o saldo dos itens (sem conexão ou o servidor não respondeu). Nada foi apagado. Tente de novo com conexão.";
export const REDO_FAILED_MESSAGE =
  "Não foi possível abrir a venda em Vender. Nada foi apagado. Tente de novo.";
