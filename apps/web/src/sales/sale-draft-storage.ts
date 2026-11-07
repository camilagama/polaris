import type { PreferenceStorage } from "../lib/current-organization-model";
import { calendarDayInTimezone } from "../lib/dates";
import {
  ADJUSTMENT_KINDS,
  MAX_SALE_ADJUSTMENTS,
  MAX_SALE_ITEMS,
  SALE_METHODS,
  type SaleFormState,
} from "./sale-form-model";

/**
 * The sale being built and not confirmed yet, kept in this tab (`sessionStorage`) so that leaving Vender, a reload
 * and the swap of the build (ADR 0041) give it back. Never `localStorage`: a shared counter device must not hand one
 * person's cart to the next, and a cart of another day has old prices and balances, so it ends at the turn of the
 * store's day. It holds identifiers, quantities and values only: the form has no customer, and nothing about a
 * person may be added to it.
 *
 * A change to the shape of `SaleFormState` changes the version in the key (`v1`) in the same change: the test of
 * this module pins the shape next to the key.
 */
export const SALE_DRAFT_KEY_PREFIX = "polaris.sale.draft.v1:";

export interface SaleDraft {
  form: SaleFormState;
  /** When the cart got its first change: the store day it belongs to. */
  startedAt: string;
}

export type SaleDraftRead =
  | { kind: "none" }
  | { draft: SaleDraft; kind: "restored" }
  /** It was from another day of the store, and was dropped. */
  | { kind: "expired" }
  /** It did not have the shape this build writes, and was dropped. */
  | { kind: "unreadable" };

type DraftStorage = PreferenceStorage &
  Partial<Pick<Storage, "key" | "length">>;

function draftKey(organizationId: string): string {
  return `${SALE_DRAFT_KEY_PREFIX}${organizationId}`;
}

type Shape = Record<string, unknown>;

function hasExactKeys(value: unknown, keys: readonly string[]): value is Shape {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const own = Object.keys(value);
  return (
    own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

/** No field the screen writes comes near this; a longer text was not written by this build. */
const MAX_TEXT_LENGTH = 2000;

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_TEXT_LENGTH;

export const SALE_DRAFT_SHAPE = {
  adjustment: ["draftId", "kind", "value", "valueType"],
  form: ["adjustments", "items", "occurredAtLocal", "payment", "profile"],
  item: [
    "chargedUnitPrice",
    "draftId",
    "label",
    "listedUnitPrice",
    "productId",
    "quantity",
    "variantId",
  ],
  payment: [
    "anticipationRequested",
    "installmentPlan",
    "installments",
    "method",
  ],
  profile: ["choice", "reviewNotice", "seenVersion"],
} as const;

const methods = new Set<string>([
  "",
  ...SALE_METHODS.map(([method]) => method),
]);
const adjustmentKinds = new Set<string>(ADJUSTMENT_KINDS.map(([kind]) => kind));

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Empty on a line with nothing chosen yet; otherwise an id the catalog gave. */
const isCatalogId = (value: unknown): boolean =>
  value === "" || (typeof value === "string" && uuidPattern.test(value));

function isItem(value: unknown): boolean {
  return (
    hasExactKeys(value, SALE_DRAFT_SHAPE.item) &&
    SALE_DRAFT_SHAPE.item.every((key) => isText(value[key])) &&
    value.draftId !== "" &&
    isCatalogId(value.productId) &&
    isCatalogId(value.variantId)
  );
}

function isAdjustment(value: unknown): boolean {
  return (
    hasExactKeys(value, SALE_DRAFT_SHAPE.adjustment) &&
    isText(value.draftId) &&
    value.draftId !== "" &&
    adjustmentKinds.has(String(value.kind)) &&
    isText(value.value) &&
    (value.valueType === "fixed" || value.valueType === "percentage")
  );
}

function isPayment(value: unknown): boolean {
  return (
    hasExactKeys(value, SALE_DRAFT_SHAPE.payment) &&
    typeof value.anticipationRequested === "boolean" &&
    ["", "issuer", "merchant"].includes(String(value.installmentPlan)) &&
    isText(value.installments) &&
    isText(value.method) &&
    methods.has(value.method)
  );
}

function isProfile(value: unknown): boolean {
  return (
    hasExactKeys(value, SALE_DRAFT_SHAPE.profile) &&
    isText(value.choice) &&
    (value.reviewNotice === null || isText(value.reviewNotice)) &&
    (value.seenVersion === null || Number.isInteger(value.seenVersion))
  );
}

/** Each line and adjustment is a key of the screen's list: two with one id would be one row. */
function uniqueDraftIds(rows: readonly unknown[]): boolean {
  const ids = rows.map((row) => (row as { draftId: string }).draftId);
  return new Set(ids).size === ids.length;
}

/** The validator of what is read back: the exact shape this build writes, nothing more. */
export function isSaleFormState(value: unknown): value is SaleFormState {
  if (!hasExactKeys(value, SALE_DRAFT_SHAPE.form)) {
    return false;
  }
  const { adjustments, items, occurredAtLocal, payment, profile } = value;
  return (
    Array.isArray(items) &&
    items.length >= 1 &&
    items.length <= MAX_SALE_ITEMS &&
    items.every(isItem) &&
    Array.isArray(adjustments) &&
    adjustments.length <= MAX_SALE_ADJUSTMENTS &&
    adjustments.every(isAdjustment) &&
    isText(occurredAtLocal) &&
    isPayment(payment) &&
    isProfile(profile) &&
    uniqueDraftIds([...items, ...adjustments])
  );
}

function isDraft(value: unknown): value is SaleDraft {
  return (
    hasExactKeys(value, ["form", "startedAt"]) &&
    isText(value.startedAt) &&
    Number.isFinite(new Date(value.startedAt).getTime()) &&
    isSaleFormState(value.form)
  );
}

function forget(storage: DraftStorage | null, organizationId: string): void {
  try {
    storage?.removeItem(draftKey(organizationId));
  } catch {
    // a blocked storage holds nothing to forget
  }
}

/** The draft of this store, if it is of the store's current day and has the shape this build writes. */
export function readSaleDraft(
  storage: DraftStorage | null,
  organizationId: string,
  now: Date,
  timezone: string | null
): SaleDraftRead {
  let text: string | null | undefined;
  try {
    text = storage?.getItem(draftKey(organizationId));
  } catch {
    return { kind: "none" };
  }
  if (!text) {
    return { kind: "none" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!isDraft(parsed)) {
    forget(storage, organizationId);
    return { kind: "unreadable" };
  }
  const startedDay = calendarDayInTimezone(
    new Date(parsed.startedAt),
    timezone
  );
  if (startedDay !== calendarDayInTimezone(now, timezone)) {
    forget(storage, organizationId);
    return { kind: "expired" };
  }
  return { draft: parsed, kind: "restored" };
}

/** Stores the draft, or forgets it when null. A failure only loses the copy: the cart on the screen stays. */
export function writeSaleDraft(
  storage: DraftStorage | null,
  organizationId: string,
  draft: SaleDraft | null
): void {
  if (draft === null) {
    forget(storage, organizationId);
    return;
  }
  try {
    storage?.setItem(draftKey(organizationId), JSON.stringify(draft));
  } catch {
    // full or blocked: the cart on the screen still works
  }
}

/** Forgets the drafts of every store of this tab, but the one kept (the store just chosen). */
export function clearSaleDrafts(
  storage: DraftStorage | null,
  keepOrganizationId: string | null = null
): void {
  try {
    if (!storage?.key || storage.length === undefined) {
      return;
    }
    const keep =
      keepOrganizationId === null ? null : draftKey(keepOrganizationId);
    const found: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(SALE_DRAFT_KEY_PREFIX) && key !== keep) {
        found.push(key);
      }
    }
    for (const key of found) {
      storage.removeItem(key);
    }
  } catch {
    // a blocked storage holds no draft
  }
}

type SettledListener = (organizationId: string, commandId: string) => void;
const settledListeners = new Set<SettledListener>();

/**
 * A sale was recorded (or kept on the device). Said to the other Vender of the page: one that mounted while the sale
 * was on its way gave the same cart back from the tab, and it must not stay on the screen as a draft.
 */
export function announceSaleSettled(
  organizationId: string,
  commandId: string
): void {
  for (const listener of settledListeners) {
    listener(organizationId, commandId);
  }
}

export function subscribeSaleSettled(listener: SettledListener): () => void {
  settledListeners.add(listener);
  return () => {
    settledListeners.delete(listener);
  };
}
