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
 * store's day unless the person changed it in the last six hours (a counter that sells past midnight). It holds identifiers, quantities and values only: the form has no customer, and nothing about a
 * person may be added to it.
 *
 * A change to the shape of `SaleFormState` changes the version in the key (`v2`) in the same change: the test of
 * this module pins the shape next to the key. A draft of the previous version (`v1`, no split) is still read back, as a
 * sale of one part, and moved to the current key.
 */
export const SALE_DRAFT_KEY_PREFIX = "polaris.sale.draft.v2:";

const LEGACY_DRAFT_KEY_PREFIX = "polaris.sale.draft.v1:";

/** How long after the person's last change a cart of another store day is still given back. */
const DRAFT_GRACE_MS = 6 * 60 * 60 * 1000;

export interface SaleDraft {
  form: SaleFormState;
  /**
   * When the cart got its first change: the store day it belongs to, and the key the send attempt and the redo of a
   * refused sale match it by. It never changes once written.
   */
  startedAt: string;
  /**
   * When the person last changed the cart. Reading it back again, or the refresh of its prices, does not move it.
   * A draft written before this field existed has none, and only the store day keeps it.
   */
  updatedAt?: string;
}

export type SaleDraftRead =
  | { kind: "none" }
  | { draft: SaleDraft; kind: "restored" }
  /** It was from another day of the store and the person's last change was too long ago, and was dropped. */
  | { kind: "expired" }
  /** It did not have the shape this build writes, and was dropped. */
  | { kind: "unreadable" };

type DraftStorage = PreferenceStorage &
  Partial<Pick<Storage, "key" | "length">>;

function draftKey(organizationId: string): string {
  return `${SALE_DRAFT_KEY_PREFIX}${organizationId}`;
}

function legacyDraftKey(organizationId: string): string {
  return `${LEGACY_DRAFT_KEY_PREFIX}${organizationId}`;
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
  form: [
    "adjustments",
    "items",
    "occurredAtLocal",
    "payment",
    "profile",
    "split",
  ],
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
  second: ["amount", "payment", "profile"],
  split: ["firstAmount", "second", "totalSeen"],
} as const;

const LEGACY_FORM_KEYS = [
  "adjustments",
  "items",
  "occurredAtLocal",
  "payment",
  "profile",
] as const;

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

function isSecondPart(value: unknown): boolean {
  return (
    hasExactKeys(value, SALE_DRAFT_SHAPE.second) &&
    (value.amount === null || isText(value.amount)) &&
    isPayment(value.payment) &&
    isProfile(value.profile)
  );
}

function isSplit(value: unknown): boolean {
  return (
    value === null ||
    (hasExactKeys(value, SALE_DRAFT_SHAPE.split) &&
      isText(value.firstAmount) &&
      (value.totalSeen === null || isText(value.totalSeen)) &&
      isSecondPart(value.second))
  );
}

/** What every version of the form holds: the cart, the date and the first part. */
function isFormBody(value: Shape): boolean {
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
    uniqueDraftIds([...(items as unknown[]), ...(adjustments as unknown[])])
  );
}

/** The validator of what is read back: the exact shape this build writes, nothing more. */
export function isSaleFormState(value: unknown): value is SaleFormState {
  return (
    hasExactKeys(value, SALE_DRAFT_SHAPE.form) &&
    isFormBody(value) &&
    isSplit(value.split)
  );
}

/** A form of the previous version, which had no split: it is a sale of one part. */
function formOfLegacy(value: unknown): SaleFormState | null {
  return hasExactKeys(value, LEGACY_FORM_KEYS) && isFormBody(value)
    ? ({ ...value, split: null } as unknown as SaleFormState)
    : null;
}

const isInstant = (value: unknown): value is string =>
  isText(value) && Number.isFinite(new Date(value).getTime());

/** The draft as stored, whose form `readForm` accepts: this version's shape, or the legacy one converted. */
function draftOf(
  value: unknown,
  readForm: (form: unknown) => SaleFormState | null
): SaleDraft | null {
  const withUpdatedAt = hasExactKeys(value, ["form", "startedAt", "updatedAt"]);
  const withoutUpdatedAt = hasExactKeys(value, ["form", "startedAt"]);
  if (!(withUpdatedAt || withoutUpdatedAt)) {
    return null;
  }
  const { form: stored, startedAt, updatedAt } = value;
  if (!isInstant(startedAt) || (withUpdatedAt && !isInstant(updatedAt))) {
    return null;
  }
  const form = readForm(stored);
  if (form === null) {
    return null;
  }
  return withUpdatedAt
    ? { form, startedAt, updatedAt: updatedAt as string }
    : { form, startedAt };
}

const currentForm = (form: unknown): SaleFormState | null =>
  isSaleFormState(form) ? form : null;

/** Within six hours of the last change; a change in the future of this clock (the clock went back) is not. */
function changedRecently(draft: SaleDraft, now: Date): boolean {
  if (draft.updatedAt === undefined) {
    return false;
  }
  const age = now.getTime() - new Date(draft.updatedAt).getTime();
  return age >= 0 && age <= DRAFT_GRACE_MS;
}

function forget(storage: DraftStorage | null, organizationId: string): void {
  try {
    storage?.removeItem(draftKey(organizationId));
    storage?.removeItem(legacyDraftKey(organizationId));
  } catch {
    // a blocked storage holds nothing to forget
  }
}

/**
 * The draft of this store, if it has the shape this build writes and it is of the store's current day or the person
 * changed it in the last six hours.
 */
export function readSaleDraft(
  storage: DraftStorage | null,
  organizationId: string,
  now: Date,
  timezone: string | null
): SaleDraftRead {
  let text: string | null | undefined;
  let legacy = false;
  try {
    text = storage?.getItem(draftKey(organizationId));
    if (!text) {
      text = storage?.getItem(legacyDraftKey(organizationId));
      legacy = Boolean(text);
    }
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
  const draft = draftOf(parsed, legacy ? formOfLegacy : currentForm);
  if (draft === null) {
    forget(storage, organizationId);
    return { kind: "unreadable" };
  }
  const startedDay = calendarDayInTimezone(new Date(draft.startedAt), timezone);
  if (
    startedDay !== calendarDayInTimezone(now, timezone) &&
    !changedRecently(draft, now)
  ) {
    forget(storage, organizationId);
    return { kind: "expired" };
  }
  if (legacy) {
    writeSaleDraft(storage, organizationId, draft);
  }
  return { draft, kind: "restored" };
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
    storage?.removeItem(legacyDraftKey(organizationId));
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
      keepOrganizationId === null
        ? []
        : [draftKey(keepOrganizationId), legacyDraftKey(keepOrganizationId)];
    const found: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (
        key !== null &&
        (key.startsWith(SALE_DRAFT_KEY_PREFIX) ||
          key.startsWith(LEGACY_DRAFT_KEY_PREFIX)) &&
        !keep.includes(key)
      ) {
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
