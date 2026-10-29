import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import { priceFieldText } from "./last-prices-model";
import {
  createBlankSaleForm,
  type ItemDraft,
  type SaleFormState,
} from "./sale-form-model";
import { itemChangesForEntry } from "./sale-variant-picker-model";

export interface RefreshedDraft {
  form: SaleFormState;
  /** Lines whose variant is no longer sellable (gone from the catalog, or its product archived). */
  removed: number;
  /** Lines whose list price changed since the cart was built. */
  repriced: number;
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
): ItemDraft | null {
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
    ...item,
    chargedUnitPrice: followedList ? fresh : item.chargedUnitPrice,
    listedUnitPrice: fresh,
  };
}

/**
 * A cart that came back from the tab is checked against a fresh read of its variants: a line whose variant left the
 * catalog is taken out, and the list price and the label are the current ones. Only the variants that were read are
 * judged: a line picked after the read came from a fresh search already. The total is never kept: it is computed from
 * the lines again.
 */
export function refreshRestoredItems(
  form: SaleFormState,
  readIds: readonly string[],
  entries: readonly InventoryBalanceEntryReadModel[],
  createId: () => string
): RefreshedDraft {
  const read = new Set(readIds);
  const sellable = new Map(
    entries
      .filter((entry) => entry.productStatus === "active")
      .map((entry) => [entry.variantId, entry])
  );
  let removed = 0;
  let repriced = 0;
  const items: ItemDraft[] = [];
  for (const item of form.items) {
    if (!read.has(item.variantId)) {
      items.push(item);
      continue;
    }
    const entry = sellable.get(item.variantId);
    if (!entry) {
      removed += 1;
      continue;
    }
    const current = { ...item, ...itemChangesForEntry(entry) };
    const priced = repricedItem(current, entry.listPrice);
    if (priced) {
      repriced += 1;
    }
    items.push(priced ?? current);
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
  "A venda em andamento era de outro dia e foi descartada.";
export const DRAFT_UNREADABLE_MESSAGE =
  "Não foi possível recuperar a venda em andamento.";

/** What the screen says after the cart was read again, or null when nothing changed. */
export function refreshedDraftMessage({
  removed,
  repriced,
}: RefreshedDraft): string | null {
  const parts: string[] = [];
  if (removed > 0) {
    parts.push(
      removed === 1
        ? "1 item saiu do catálogo e foi tirado da venda."
        : `${removed} itens saíram do catálogo e foram tirados da venda.`
    );
  }
  if (repriced > 0) {
    parts.push(
      repriced === 1
        ? "O preço de tabela de 1 item foi atualizado."
        : `O preço de tabela de ${repriced} itens foi atualizado.`
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/** How many lines of the cart have a variant chosen: what "Limpar venda" takes out. */
export function chosenItemCount(form: SaleFormState): number {
  return form.items.filter((item) => item.variantId !== "").length;
}

/** The consequence said before "Limpar venda" takes the lines out. */
export function clearSaleConsequence(count: number): string {
  return count === 1
    ? "Isso tira o item da venda."
    : `Isso tira os ${count} itens da venda.`;
}
