import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import { calendarDayInTimezone } from "../lib/dates";
import { formatBrlAmount } from "../lib/format";
import { priceFieldText } from "./last-prices-model";
import { clearSaleConsequenceText, type SaleCount } from "./sale-count-text";
import {
  createBlankSaleForm,
  type ItemDraft,
  parseMoneyText,
  quantityUnits,
  type SaleFormState,
} from "./sale-form-model";
import { itemChangesForEntry } from "./sale-variant-picker-model";

interface RepricedLine {
  /** The price charged on the line now: the new list price when it followed the list, the negotiated one otherwise. */
  chargedUnitPrice: string;
  followedList: boolean;
  label: string;
  /** The current list price, as the catalog gives it (`38.00`). */
  listPrice: string;
}

export interface RefreshedDraft {
  form: SaleFormState;
  /** The labels of the lines whose variant is no longer sellable (gone from the catalog, or its product archived). */
  removed: string[];
  /** The lines whose list price changed since the cart was built. */
  repriced: RepricedLine[];
}

/** The variants on the cart, each once: what a restored draft reads again. */
export function draftVariantIds(form: SaleFormState): string[] {
  return [
    ...new Set(
      form.items.map((item) => item.variantId).filter((id) => id !== "")
    ),
  ];
}

function repricedItem(
  item: ItemDraft,
  listPrice: string | null
): { followedList: boolean; item: ItemDraft } | null {
  if (listPrice === null) {
    return null;
  }
  const fresh = priceFieldText(listPrice);
  if (item.listedUnitPrice === fresh) {
    return null;
  }
  // a negotiated price is the person's number and stays; one that followed the list follows it again
  const followedList = item.chargedUnitPrice === item.listedUnitPrice;
  return {
    followedList,
    item: {
      ...item,
      chargedUnitPrice: followedList ? fresh : item.chargedUnitPrice,
      listedUnitPrice: fresh,
    },
  };
}

/**
 * A cart that came back from the tab is checked against a fresh read of its variants: a line whose variant left the
 * catalog is taken out, and the list price and the label are the current ones. Only the variants that were read are
 * judged: a line picked after the read came from a fresh search already. The total is never kept: it is computed from
 * the lines again.
 *
 * With an attempt whose outcome is unknown (sent, no answer), the cart is left as it was sent: any change to its body
 * gives the next confirmation a new command ID, and a sale the server already recorded would be recorded again. The
 * server still refuses a variant that left the catalog or whose product was archived.
 */
export function refreshRestoredItems(
  form: SaleFormState,
  readIds: readonly string[],
  entries: readonly InventoryBalanceEntryReadModel[],
  createId: () => string,
  outcomeUnknown: boolean
): RefreshedDraft {
  if (outcomeUnknown) {
    return { form, removed: [], repriced: [] };
  }
  const read = new Set(readIds);
  const sellable = new Map(
    entries
      .filter((entry) => entry.productStatus === "active")
      .map((entry) => [entry.variantId, entry])
  );
  const removed: string[] = [];
  const repriced: RepricedLine[] = [];
  const items: ItemDraft[] = [];
  for (const item of form.items) {
    if (!read.has(item.variantId)) {
      items.push(item);
      continue;
    }
    const entry = sellable.get(item.variantId);
    if (!entry) {
      removed.push(item.label);
      continue;
    }
    const current = { ...item, ...itemChangesForEntry(entry) };
    const priced = repricedItem(current, entry.listPrice);
    if (priced && entry.listPrice !== null) {
      repriced.push({
        chargedUnitPrice: priced.item.chargedUnitPrice,
        followedList: priced.followedList,
        label: priced.item.label,
        listPrice: entry.listPrice,
      });
    }
    items.push(priced?.item ?? current);
  }
  return {
    form: {
      ...form,
      items: items.length > 0 ? items : createBlankSaleForm(createId).items,
    },
    removed,
    repriced,
  };
}

export const DRAFT_EXPIRED_MESSAGE =
  "A venda em andamento ficou parada por muito tempo e foi descartada.";
export const DRAFT_RECORDED_MESSAGE =
  "A venda em andamento já foi confirmada ou guardada neste aparelho.";
export const DRAFT_UNREADABLE_MESSAGE =
  "Não foi possível recuperar a venda em andamento.";

/** "A", "A e B", "A, B e C". */
function listOfNames(names: readonly string[]): string {
  if (names.length <= 1) {
    return names.join("");
  }
  return `${names.slice(0, -1).join(", ")} e ${names.at(-1)}`;
}

function removedText(labels: readonly string[]): string {
  return labels.length === 1
    ? `O item ${labels[0]} saiu do catálogo e foi tirado da venda.`
    : `Os itens ${listOfNames(labels)} saíram do catálogo e foram tirados da venda.`;
}

function repricedText(line: RepricedLine): string {
  const listed = `${line.label}: preço de tabela atualizado para ${formatBrlAmount(line.listPrice)}`;
  if (line.followedList) {
    return `${listed}; o preço cobrado acompanhou.`;
  }
  const charged = parseMoneyText(line.chargedUnitPrice);
  return charged.kind === "ok"
    ? `${listed}; o preço cobrado continua ${formatBrlAmount(charged.value)}.`
    : `${listed}; o preço cobrado não mudou.`;
}

/** What the screen says after the cart was read again, or null when nothing changed. */
export function refreshedDraftMessage({
  removed,
  repriced,
}: RefreshedDraft): string | null {
  const parts = [
    ...(removed.length > 0 ? [removedText(removed)] : []),
    ...repriced.map(repricedText),
  ];
  return parts.length > 0 ? parts.join(" ") : null;
}

/** The lines of the cart with a variant chosen and the units they add up to: what "Limpar venda" takes out. */
export function chosenSaleCount(form: SaleFormState): SaleCount {
  const chosen = form.items.filter((item) => item.variantId !== "");
  return {
    lines: chosen.length,
    units: chosen.reduce((sum, item) => sum + quantityUnits(item.quantity), 0),
  };
}

/** The consequence said before "Limpar venda" takes the lines out. */
export function clearSaleConsequence(count: SaleCount): string {
  return clearSaleConsequenceText(count);
}

const dayBefore = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);

/**
 * Said while a cart that began on another store day is still on the screen with the date empty: the sale is dated at
 * the moment of confirmation, not at the day it began. Derived from the clock and the form, never stored. Offline
 * there is no date field, so the sentence ends at "de hoje".
 */
export function draftNewDayNotice({
  dateEmpty,
  now,
  offline,
  startedAt,
  timezone,
}: {
  dateEmpty: boolean;
  now: Date;
  offline: boolean;
  startedAt: string | null;
  timezone: string | null;
}): string | null {
  if (startedAt === null || !dateEmpty) {
    return null;
  }
  const startedDay = calendarDayInTimezone(new Date(startedAt), timezone);
  const today = calendarDayInTimezone(now, timezone);
  if (startedDay === today) {
    return null;
  }
  const began =
    startedDay === dayBefore(today)
      ? "Esta venda começou ontem."
      : "Esta venda começou em outro dia.";
  return offline
    ? `${began} Ela será registrada com a data de hoje.`
    : `${began} Ela será registrada com a data de hoje, a não ser que você preencha “Data e hora da venda”.`;
}
