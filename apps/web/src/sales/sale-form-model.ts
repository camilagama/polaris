import type {
  ConfirmedSaleReadModel,
  InventoryBalanceReadModel,
  PaymentProfileReadModel,
  PolarisRpcClient,
  ProductReadModel,
  ProductVariantConfigurationReadModel,
} from "@polaris/contracts";
import {
  MAX_RATE_PERCENTAGE_POINTS,
  Money,
  Percentage,
} from "@polaris/domain/money/money";
import {
  CONFIRM_SALE_COMMAND_VERSION,
  MAX_FUTURE_CLOCK_SKEW_MS,
  normalizeConfirmSaleCommand,
} from "@polaris/domain/sales/confirm-sale";
import {
  type PaymentProfileForSale,
  type SalePaymentFeeSnapshot,
  snapshotPaymentProfileForSale,
} from "@polaris/domain/sales/payment-profile";
import {
  calculateSaleAdjustments,
  InvalidSaleAdjustmentError,
  type NormalizedSaleAdjustment,
  type SaleAdjustmentCalculation,
  SaleAdjustmentLimitError,
  SaleDiscountExceedsSubtotalError,
} from "@polaris/domain/sales/sale-adjustments";
import {
  formatBrlAmount,
  formatBrlCents,
  formatCalendarDate,
  formatInstant,
  formatQuantity,
} from "../lib/format";
import {
  isLegalAcceptanceRefusal,
  isServerFailureCode,
  legalAcceptanceMessage,
  rpcErrorCode,
  rpcErrorReason,
} from "../lib/rpc-error";
import {
  centsOfMoney,
  fieldTextOfCents,
  moneyOfCents,
  type PartMessages,
  partMessages,
  restOfTotal,
  type SecondPartDraft,
  type SplitBalance,
  type SplitDraft,
  splitBalance,
  splitFieldKeys,
  splitTotalChangedNotice,
} from "./sale-split-model";

/* -------------------------------------------------------------------------- */
/* Types and constants                                                        */
/* -------------------------------------------------------------------------- */

export type SaleMethod = ConfirmedSaleReadModel["payment"]["method"];
type InstallmentPlan = "merchant" | "issuer";
export type AdjustmentKind =
  ConfirmedSaleReadModel["adjustments"][number]["kind"];
type AdjustmentValueType = "fixed" | "percentage";
type ConfirmSaleRequest = Parameters<PolarisRpcClient["sale"]["confirm"]>[0];
export type SaleCommandBody = Omit<
  ConfirmSaleRequest,
  "recordedAt" | "commandId" | "occurredAt" | "organizationId"
>;

/** One payment: the whole sale paid in one go, or the method of a part. */
type SalePayment = NonNullable<SaleCommandBody["payment"]>;

export const MAX_SALE_ITEMS = 200;
export const MAX_SALE_ADJUSTMENTS = 20;
const MAX_QUANTITY = 2_147_483_647;
/** Select value meaning "the operator chose to sell without a payment profile". */
export const NO_PROFILE_CHOICE = "none";

export const SALE_METHODS: ReadonlyArray<readonly [SaleMethod, string]> = [
  ["pix", "Pix"],
  ["cash", "Dinheiro"],
  ["credit_card", "Cartão de crédito"],
  ["debit_card", "Cartão de débito"],
  ["bank_transfer", "Transferência bancária"],
  ["other", "Outro"],
];

/** The short names of the choice cards of the sale and of the line of the history; the summary and the receipt keep the full ones of SALE_METHODS. */
export const SALE_METHOD_CARDS: ReadonlyArray<readonly [SaleMethod, string]> = [
  ["pix", "Pix"],
  ["cash", "Dinheiro"],
  ["credit_card", "Crédito"],
  ["debit_card", "Débito"],
  ["bank_transfer", "Transferência"],
  ["other", "Outro"],
];

export const ADJUSTMENT_KINDS: ReadonlyArray<
  readonly [AdjustmentKind, string]
> = [
  ["discount", "Desconto"],
  ["surcharge", "Acréscimo"],
  ["freight", "Frete"],
  ["payment_surcharge", "Sobretaxa de pagamento"],
];

const methodLabels = new Map<string, string>(SALE_METHODS);
/** The receipt and summary phrase of each plan; the form field uses the shorter words of INSTALLMENT_PLAN_* in sale-fields.tsx. */
const planLabels: Readonly<Record<string, string>> = {
  issuer: "Parcelado pelo emissor",
  merchant: "Parcelado pelo lojista",
};
const adjustmentLabels = new Map<string, string>(ADJUSTMENT_KINDS);

export interface ItemDraft {
  chargedUnitPrice: string;
  draftId: string;
  /** Product and variant label captured when the variant was chosen. */
  label: string;
  listedUnitPrice: string;
  productId: string;
  quantity: string;
  variantId: string;
}

export interface AdjustmentDraft {
  draftId: string;
  kind: AdjustmentKind;
  value: string;
  valueType: AdjustmentValueType;
}

export interface PaymentDraft {
  anticipationRequested: boolean;
  installmentPlan: InstallmentPlan | "";
  installments: string;
  method: SaleMethod | "";
}

export interface ProfileSelectionDraft {
  /** "" = not chosen yet, NO_PROFILE_CHOICE = no profile, otherwise a profile id. */
  choice: string;
  /** Set when the loaded profile changed after the operator chose it. */
  reviewNotice: string | null;
  /** Version of the chosen profile the operator last reviewed. */
  seenVersion: number | null;
}

export interface SaleFormState {
  adjustments: AdjustmentDraft[];
  items: ItemDraft[];
  /** `datetime-local` text in the device time zone; empty means now. */
  occurredAtLocal: string;
  payment: PaymentDraft;
  profile: ProfileSelectionDraft;
  /** Part 2 and the amount of part 1; null while the sale is paid in one go (the screen never opens split). */
  split: SplitDraft | null;
}

export type Loadable<T> =
  | { status: "loading" }
  | { message: string; status: "error" }
  | { status: "ready"; value: T };

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

const decimalTextPattern = /^(-?)(\d+)(?:\.(\d+))?$/;
const trailingZerosPattern = /0+$/;

/** Formats a percentage in percentage points: "2.500000" becomes "2,5%". */
export function formatPercentage(value: string): string {
  const match = decimalTextPattern.exec(value.trim());
  if (!match) {
    return `${value}%`;
  }
  const trimmed = (match[3] ?? "").replace(trailingZerosPattern, "");
  const whole = match[2] ?? "0";
  return `${whole}${trimmed ? `,${trimmed}` : ""}%`;
}

function signedBrl(sign: "+" | "-", amount: string): string {
  return `${sign}${formatBrlAmount(amount)}`;
}

/* -------------------------------------------------------------------------- */
/* Input parsing                                                              */
/* -------------------------------------------------------------------------- */

type FieldParse<T> =
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "too_large" }
  | { kind: "ok"; value: T };

const integerPattern = /^\d{1,10}$/;
const moneyPattern = /^(\d+)(?:\.(\d{1,2}))?$/;
const percentagePattern = /^(\d+)(?:\.(\d{1,6}))?$/;
const leadingZerosPattern = /^0+(?=\d)/;
const MAX_MONEY_WHOLE_DIGITS = 18;
const MAX_PERCENTAGE_WHOLE_DIGITS = 12;

/** Accepts a comma or a dot as the decimal separator, like the profile page. */
function normalizeDecimalText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.includes(",") && trimmed.includes(".")) {
    return trimmed;
  }
  return trimmed.replace(",", ".");
}

function parsePositiveInteger(text: string): FieldParse<number> {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { kind: "empty" };
  }
  if (!integerPattern.test(trimmed)) {
    return { kind: "invalid" };
  }
  const value = Number(trimmed);
  if (value < 1) {
    return { kind: "invalid" };
  }
  return value > MAX_QUANTITY ? { kind: "too_large" } : { kind: "ok", value };
}

/** The units a quantity field counts for: the whole number it holds, zero while it is empty or not a valid quantity. */
export function quantityUnits(text: string): number {
  const parse = parsePositiveInteger(text);
  return parse.kind === "ok" ? parse.value : 0;
}

/**
 * The quantity after one tap of the − or + of the stepper, or null when that tap
 * is not possible (below 1, above the maximum, or a text that is not a whole
 * number, which the person fixes by typing). An empty field starts at 1.
 */
export function stepQuantity(text: string, step: 1 | -1): string | null {
  const parse = parsePositiveInteger(text);
  if (parse.kind === "empty") {
    return step === 1 ? "1" : null;
  }
  if (parse.kind !== "ok") {
    return null;
  }
  const next = parse.value + step;
  return next < 1 || next > MAX_QUANTITY ? null : String(next);
}

/** Returns a normalized non-negative BRL string with exactly two decimals. */
export function parseMoneyText(text: string): FieldParse<string> {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { kind: "empty" };
  }
  const match = moneyPattern.exec(normalizeDecimalText(trimmed));
  if (!match) {
    return { kind: "invalid" };
  }
  const whole = (match[1] ?? "0").replace(leadingZerosPattern, "");
  if (whole.length > MAX_MONEY_WHOLE_DIGITS) {
    return { kind: "too_large" };
  }
  return { kind: "ok", value: `${whole}.${(match[2] ?? "").padEnd(2, "0")}` };
}

/** Returns a non-negative percentage in percentage points (up to 6 decimals). */
export function parsePercentageText(text: string): FieldParse<string> {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { kind: "empty" };
  }
  const match = percentagePattern.exec(normalizeDecimalText(trimmed));
  if (!match) {
    return { kind: "invalid" };
  }
  const whole = (match[1] ?? "0").replace(leadingZerosPattern, "");
  if (whole.length > MAX_PERCENTAGE_WHOLE_DIGITS) {
    return { kind: "too_large" };
  }
  return { kind: "ok", value: match[2] ? `${whole}.${match[2]}` : whole };
}

/* -------------------------------------------------------------------------- */
/* Form state transitions                                                     */
/* -------------------------------------------------------------------------- */

function createItemDraft(draftId: string): ItemDraft {
  return {
    chargedUnitPrice: "",
    draftId,
    label: "",
    listedUnitPrice: "",
    productId: "",
    quantity: "1",
    variantId: "",
  };
}

function createAdjustmentDraft(draftId: string): AdjustmentDraft {
  return { draftId, kind: "discount", value: "", valueType: "fixed" };
}

/** A blank sale: nothing is chosen on the operator's behalf. */
export function createBlankSaleForm(createId: () => string): SaleFormState {
  return {
    adjustments: [],
    items: [createItemDraft(createId())],
    occurredAtLocal: "",
    payment: {
      anticipationRequested: false,
      installmentPlan: "",
      installments: "",
      method: "",
    },
    profile: { choice: "", reviewNotice: null, seenVersion: null },
    split: null,
  };
}

/**
 * What the screen fills in on a new sale for the person: the method and profile of the last sale on this device, or
 * "Sem perfil" in a store without an active profile, and a remembered "Sem perfil" holds only there
 * (last-payment-model.ts). Empty fields are no preset.
 */
export interface SalePreset {
  method: SaleMethod | "";
  profileChoice: string;
  /** The version the remembered profile was used with; null with no profile or "Sem perfil". */
  profileVersion: number | null;
}

export const NO_SALE_PRESET: SalePreset = {
  method: "",
  profileChoice: "",
  profileVersion: null,
};

/**
 * Fills in the preset only where the person has not chosen: a method or a profile already on the form, or a profile
 * cleared with a notice to read, stay as they are.
 */
export function applySalePreset(
  form: SaleFormState,
  preset: SalePreset
): SaleFormState {
  const fillMethod = form.payment.method === "" && preset.method !== "";
  const fillProfile =
    form.profile.choice === "" &&
    form.profile.reviewNotice === null &&
    preset.profileChoice !== "";
  if (!(fillMethod || fillProfile)) {
    return form;
  }
  return {
    ...form,
    payment: fillMethod
      ? selectPaymentMethod(form, preset.method).payment
      : form.payment,
    profile: fillProfile
      ? {
          choice: preset.profileChoice,
          reviewNotice: null,
          seenVersion: preset.profileVersion,
        }
      : form.profile,
  };
}

/**
 * Takes back what the previous preset filled in when the new one no longer offers it (a remembered "Sem perfil" in a
 * store that just got an active profile), only while the form is still what that preset made it: anything else the
 * person did stays, and a choice that differs from the preset is theirs.
 */
export function withdrawSalePreset(
  form: SaleFormState,
  previous: SalePreset,
  next: SalePreset
): SaleFormState {
  if (isSaleFormDirty(form, previous)) {
    return form;
  }
  const dropMethod =
    previous.method !== "" &&
    next.method === "" &&
    form.payment.method === previous.method;
  const dropProfile =
    previous.profileChoice !== "" &&
    next.profileChoice === "" &&
    form.profile.choice === previous.profileChoice;
  if (!(dropMethod || dropProfile)) {
    return form;
  }
  return {
    ...form,
    payment: dropMethod ? selectPaymentMethod(form, "").payment : form.payment,
    profile: dropProfile
      ? { choice: "", reviewNotice: null, seenVersion: null }
      : form.profile,
  };
}

/**
 * Whether the person put anything on the sale: a chosen variant, a changed quantity or price, an
 * adjustment, a payment or profile choice, or a date. A blank form, what the screen chose for the person (the
 * preset), and the offline mode's own "dated now", are not work. The cart counts even when it was built only by taps
 * and selections.
 */
export function isSaleFormDirty(
  form: SaleFormState,
  preset: SalePreset = NO_SALE_PRESET
): boolean {
  const blank = createItemDraft("");
  const itemChanged = (item: ItemDraft) =>
    item.variantId !== "" ||
    item.productId !== "" ||
    item.quantity !== blank.quantity ||
    item.chargedUnitPrice !== blank.chargedUnitPrice ||
    item.listedUnitPrice !== blank.listedUnitPrice;
  return (
    form.items.some(itemChanged) ||
    form.adjustments.length > 0 ||
    form.occurredAtLocal !== "" ||
    form.split !== null ||
    (form.payment.method !== preset.method && form.payment.method !== "") ||
    form.payment.installmentPlan !== "" ||
    form.payment.installments !== "" ||
    form.payment.anticipationRequested ||
    (form.profile.choice !== preset.profileChoice && form.profile.choice !== "")
  );
}

export function editSaleDate(
  form: SaleFormState,
  occurredAtLocal: string
): SaleFormState {
  return { ...form, occurredAtLocal };
}

export function addItem(form: SaleFormState, draftId: string): SaleFormState {
  if (form.items.length >= MAX_SALE_ITEMS) {
    return form;
  }
  return { ...form, items: [...form.items, createItemDraft(draftId)] };
}

export function removeItem(
  form: SaleFormState,
  draftId: string
): SaleFormState {
  if (form.items.length <= 1) {
    return form;
  }
  return {
    ...form,
    items: form.items.filter((item) => item.draftId !== draftId),
  };
}

export function updateItem(
  form: SaleFormState,
  draftId: string,
  changes: Partial<Omit<ItemDraft, "draftId">>
): SaleFormState {
  return {
    ...form,
    items: form.items.map((item) =>
      item.draftId === draftId ? { ...item, ...changes } : item
    ),
  };
}

/** Choosing another product always clears the variant of that line. */
export function selectItemProduct(
  form: SaleFormState,
  draftId: string,
  productId: string
): SaleFormState {
  return updateItem(form, draftId, { label: "", productId, variantId: "" });
}

export function selectItemVariant(
  form: SaleFormState,
  draftId: string,
  variantId: string,
  label: string
): SaleFormState {
  return updateItem(form, draftId, { label, variantId });
}

function allowsPercentage(kind: AdjustmentKind): boolean {
  return kind === "discount" || kind === "surcharge";
}

export function addAdjustment(
  form: SaleFormState,
  draftId: string
): SaleFormState {
  if (form.adjustments.length >= MAX_SALE_ADJUSTMENTS) {
    return form;
  }
  return {
    ...form,
    adjustments: [...form.adjustments, createAdjustmentDraft(draftId)],
  };
}

export function removeAdjustment(
  form: SaleFormState,
  draftId: string
): SaleFormState {
  return {
    ...form,
    adjustments: form.adjustments.filter(
      (adjustment) => adjustment.draftId !== draftId
    ),
  };
}

/** Freight and payment surcharge are fixed amounts only. */
export function updateAdjustment(
  form: SaleFormState,
  draftId: string,
  changes: Partial<Omit<AdjustmentDraft, "draftId">>
): SaleFormState {
  return {
    ...form,
    adjustments: form.adjustments.map((adjustment) => {
      if (adjustment.draftId !== draftId) {
        return adjustment;
      }
      const next = { ...adjustment, ...changes };
      return allowsPercentage(next.kind)
        ? next
        : { ...next, valueType: "fixed" };
    }),
  };
}

function paymentWithMethod(
  payment: PaymentDraft,
  method: SaleMethod | ""
): PaymentDraft {
  if (method === "credit_card") {
    return { ...payment, method };
  }
  return {
    anticipationRequested: false,
    installmentPlan: "",
    installments: "",
    method,
  };
}

/** Switching away from credit card drops every card-only choice. */
export function selectPaymentMethod(
  form: SaleFormState,
  method: SaleMethod | ""
): SaleFormState {
  return { ...form, payment: paymentWithMethod(form.payment, method) };
}

export function updatePayment(
  form: SaleFormState,
  changes: Partial<Omit<PaymentDraft, "method">>
): SaleFormState {
  return { ...form, payment: { ...form.payment, ...changes } };
}

function profileSelectionOf(
  choice: string,
  profiles: readonly PaymentProfileReadModel[]
): ProfileSelectionDraft {
  const profile = profiles.find((candidate) => candidate.id === choice);
  return { choice, reviewNotice: null, seenVersion: profile?.version ?? null };
}

export function selectProfileChoice(
  form: SaleFormState,
  choice: string,
  profiles: readonly PaymentProfileReadModel[]
): SaleFormState {
  return { ...form, profile: profileSelectionOf(choice, profiles) };
}

function reconciledSelection(
  selection: ProfileSelectionDraft,
  profiles: readonly PaymentProfileReadModel[],
  outcomeUnknown: boolean,
  messages: PartMessages
): ProfileSelectionDraft {
  const { choice, seenVersion } = selection;
  if (choice === "" || choice === NO_PROFILE_CHOICE) {
    return selection;
  }
  const profile = profiles.find((candidate) => candidate.id === choice);
  if (!profile) {
    return outcomeUnknown
      ? selection
      : {
          choice: "",
          reviewNotice: messages.profileGone,
          seenVersion: null,
        };
  }
  if (seenVersion === null || profile.version === seenVersion) {
    return selection;
  }
  return {
    choice,
    reviewNotice: messages.profileChanged(profile.name),
    seenVersion,
  };
}

/**
 * Reconciles the chosen profile of each part with a fresh list of active profiles. A profile
 * that changed (or disappeared) forces the operator to review the fee preview
 * again before the sale can be confirmed. With an attempt whose outcome is unknown, a profile that left the list does
 * not clear the choice: the evaluation already refuses it, and clearing it would let the next choice send another body
 * under a new command ID, for a sale the server may have recorded. The parts stay as they were: a part's change never
 * touches the other.
 */
export function reconcileProfileReload(
  form: SaleFormState,
  profiles: readonly PaymentProfileReadModel[],
  outcomeUnknown = false
): SaleFormState {
  const first = reconciledSelection(
    form.profile,
    profiles,
    outcomeUnknown,
    partMessages(form.split === null ? null : 1)
  );
  const second = form.split
    ? reconciledSelection(
        form.split.second.profile,
        profiles,
        outcomeUnknown,
        partMessages(2)
      )
    : null;
  if (
    first === form.profile &&
    second === (form.split?.second.profile ?? null)
  ) {
    return form;
  }
  return {
    ...form,
    profile: first,
    split:
      form.split && second
        ? { ...form.split, second: { ...form.split.second, profile: second } }
        : form.split,
  };
}

function acknowledgedSelection(
  selection: ProfileSelectionDraft,
  profiles: readonly PaymentProfileReadModel[]
): ProfileSelectionDraft {
  const profile = profiles.find(
    (candidate) => candidate.id === selection.choice
  );
  return {
    ...selection,
    reviewNotice: null,
    seenVersion: profile?.version ?? selection.seenVersion,
  };
}

/** Both parts wait on the review of the same profile: the screen shows one warning and one button for the two. */
export function sharedProfileReview(form: SaleFormState): boolean {
  return (
    form.split !== null &&
    form.profile.reviewNotice !== null &&
    form.split.second.profile.reviewNotice !== null &&
    form.profile.choice !== "" &&
    form.profile.choice === form.split.second.profile.choice
  );
}

/** Reviewing the preview of a profile both parts use reviews it for both. */
export function acknowledgeProfileReview(
  form: SaleFormState,
  profiles: readonly PaymentProfileReadModel[]
): SaleFormState {
  const shared = sharedProfileReview(form);
  const reviewed = {
    ...form,
    profile: acknowledgedSelection(form.profile, profiles),
  };
  return shared ? acknowledgeSecondProfileReview(reviewed, profiles) : reviewed;
}

/* -------------------------------------------------------------------------- */
/* Split payment: the second part                                             */
/* -------------------------------------------------------------------------- */

function withSecond(
  form: SaleFormState,
  change: (second: SecondPartDraft) => SecondPartDraft
): SaleFormState {
  return form.split === null
    ? form
    : { ...form, split: { ...form.split, second: change(form.split.second) } };
}

/**
 * Pays the sale in two parts. Part 1 keeps what the form has; part 2 starts with the rest of the total and with neither
 * method nor profile, which the person has to choose. A form already split stays as it is.
 */
export function startSplit(form: SaleFormState): SaleFormState {
  if (form.split !== null) {
    return form;
  }
  return {
    ...form,
    split: {
      firstAmount: "",
      second: {
        amount: null,
        payment: paymentWithMethod(form.payment, ""),
        profile: { choice: "", reviewNotice: null, seenVersion: null },
      },
      totalSeen: null,
    },
  };
}

/** Back to one payment: part 1 is the whole sale again, with the method and the profile it had. */
export function endSplit(form: SaleFormState): SaleFormState {
  return form.split === null ? form : { ...form, split: null };
}

/** `total` is the total due now (`null` when it cannot be computed): what the typed parts are checked against. */
export function setFirstPartAmount(
  form: SaleFormState,
  text: string,
  total: string | null
): SaleFormState {
  return form.split === null
    ? form
    : {
        ...form,
        split: {
          ...form.split,
          firstAmount: text,
          totalSeen: total ?? form.split.totalSeen,
        },
      };
}

/** Typing in the last part ends its following the rest, for good: clearing the field leaves it typed and empty. */
export function setSecondPartAmount(
  form: SaleFormState,
  text: string,
  total: string | null
): SaleFormState {
  return form.split === null
    ? form
    : {
        ...form,
        split: {
          ...form.split,
          second: { ...form.split.second, amount: text },
          totalSeen: total ?? form.split.totalSeen,
        },
      };
}

/** Moves the difference into part 2: "Pôr na parte 2" and "Tirar da parte 2". */
export function applySplitAction(
  form: SaleFormState,
  action: { amount: bigint },
  total: string | null
): SaleFormState {
  return setSecondPartAmount(form, fieldTextOfCents(action.amount), total);
}

export function selectSecondPaymentMethod(
  form: SaleFormState,
  method: SaleMethod | ""
): SaleFormState {
  return withSecond(form, (second) => ({
    ...second,
    payment: paymentWithMethod(second.payment, method),
  }));
}

export function updateSecondPayment(
  form: SaleFormState,
  changes: Partial<Omit<PaymentDraft, "method">>
): SaleFormState {
  return withSecond(form, (second) => ({
    ...second,
    payment: { ...second.payment, ...changes },
  }));
}

export function selectSecondProfileChoice(
  form: SaleFormState,
  choice: string,
  profiles: readonly PaymentProfileReadModel[]
): SaleFormState {
  return withSecond(form, (second) => ({
    ...second,
    profile: profileSelectionOf(choice, profiles),
  }));
}

export function acknowledgeSecondProfileReview(
  form: SaleFormState,
  profiles: readonly PaymentProfileReadModel[]
): SaleFormState {
  if (sharedProfileReview(form)) {
    return acknowledgeProfileReview(form, profiles);
  }
  return withSecond(form, (second) => ({
    ...second,
    profile: acknowledgedSelection(second.profile, profiles),
  }));
}

/* -------------------------------------------------------------------------- */
/* Catalog loading views                                                      */
/* -------------------------------------------------------------------------- */

export interface ChoiceOption {
  id: string;
  label: string;
}

/** A store without a product is taken to the form of a new one (`/products?novo=1`), with this text and this button. */
export const NO_PRODUCT_MESSAGE = "Cadastre um produto para vender.";
export const NEW_PRODUCT_HREF = "/products?novo=1";
export const NEW_PRODUCT_LABEL = "Cadastrar produto";

export type CatalogView =
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string }
  | { href?: string | undefined; kind: "empty"; message: string }
  | { kind: "ready"; options: ChoiceOption[] };

/** Message for a failed read of products, profiles, variants or stock. */
export function loadErrorMessage(error: unknown, subject: string): string {
  const unaccepted = legalAcceptanceMessage(error, subject);
  if (unaccepted !== undefined) {
    return unaccepted;
  }
  const code = rpcErrorCode(error);
  // the session notice says the rest; here only what did not happen
  if (code === "UNAUTHORIZED") {
    return `Não foi possível carregar ${subject}.`;
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso a esta loja ou a esta ação.";
  }
  return `Não foi possível carregar ${subject}. Tente novamente.`;
}

export function productsView(
  load: Loadable<readonly ProductReadModel[]>
): CatalogView {
  if (load.status === "loading") {
    return { kind: "loading", message: "Carregando produtos…" };
  }
  if (load.status === "error") {
    return { kind: "error", message: load.message };
  }
  const options = load.value
    .filter((product) => product.status === "active")
    .map((product) => ({ id: product.id, label: product.name }))
    .sort((left, right) => left.label.localeCompare(right.label, "pt-BR"));
  if (options.length === 0) {
    return {
      href: NEW_PRODUCT_HREF,
      kind: "empty",
      message: NO_PRODUCT_MESSAGE,
    };
  }
  return { kind: "ready", options };
}

export function profilesView(
  load: Loadable<readonly PaymentProfileReadModel[]>
): CatalogView {
  if (load.status === "loading") {
    return { kind: "loading", message: "Carregando perfis de pagamento…" };
  }
  if (load.status === "error") {
    return { kind: "error", message: load.message };
  }
  const options = load.value
    .filter((profile) => profile.status === "active")
    .map((profile) => ({
      id: profile.id,
      label: profile.name,
    }))
    .sort((left, right) => left.label.localeCompare(right.label, "pt-BR"));
  if (options.length === 0) {
    return {
      kind: "empty",
      message:
        "Nenhum perfil de pagamento ativo. Você ainda pode vender escolhendo “Sem perfil”; taxas e prazo ficam desconhecidos.",
    };
  }
  return { kind: "ready", options };
}

function variantLabel(variant: {
  isDefault: boolean;
  values: ReadonlyArray<{ optionValueName: string }>;
}): string {
  const values = variant.values.map((value) => value.optionValueName);
  return values.length > 0 ? values.join(" / ") : "Variante padrão";
}

export function variantsView(
  load: Loadable<ProductVariantConfigurationReadModel> | undefined
): CatalogView | null {
  if (load === undefined) {
    return null;
  }
  if (load.status === "loading") {
    return { kind: "loading", message: "Carregando variantes…" };
  }
  if (load.status === "error") {
    return { kind: "error", message: load.message };
  }
  const options = load.value.variants.map((variant) => ({
    id: variant.id,
    label: variantLabel(variant),
  }));
  if (options.length === 0) {
    return {
      kind: "empty",
      message: "Este produto não tem variantes disponíveis para venda.",
    };
  }
  return { kind: "ready", options };
}

/** Full line label stored in the draft: product name plus variant when needed. */
function itemLabel(productName: string, variant: string): string {
  return variant === "" || variant === "Variante padrão"
    ? productName
    : `${productName} — ${variant}`;
}

export type VariantConfigurations = Readonly<
  Record<string, Loadable<ProductVariantConfigurationReadModel>>
>;

function lineLabel(
  productId: string,
  variantId: string,
  configurations: VariantConfigurations,
  productNames: ReadonlyMap<string, string>
): string {
  const load = configurations[productId];
  const variant =
    load?.status === "ready"
      ? load.value.variants.find((candidate) => candidate.id === variantId)
      : undefined;
  return itemLabel(
    productNames.get(productId) ?? "",
    variant ? variantLabel(variant) : ""
  );
}

/** Chooses a variant of the line's product and captures its display label. */
export function chooseItemVariant(
  form: SaleFormState,
  draftId: string,
  variantId: string,
  configurations: VariantConfigurations,
  productNames: ReadonlyMap<string, string>
): SaleFormState {
  const item = form.items.find((candidate) => candidate.draftId === draftId);
  if (!item) {
    return form;
  }
  return selectItemVariant(
    form,
    draftId,
    variantId,
    lineLabel(item.productId, variantId, configurations, productNames)
  );
}

/**
 * A product with a single variant (the default one when unconfigured) needs no
 * choice: select it for every line that picked the product. Returns the same
 * form object when nothing changed.
 */
export function autoSelectOnlyVariants(
  form: SaleFormState,
  configurations: VariantConfigurations,
  productNames: ReadonlyMap<string, string>
): SaleFormState {
  let next = form;
  for (const item of form.items) {
    const load = configurations[item.productId];
    const only =
      item.variantId === "" &&
      load?.status === "ready" &&
      load.value.variants.length === 1
        ? load.value.variants[0]
        : undefined;
    if (only) {
      next = chooseItemVariant(
        next,
        item.draftId,
        only.id,
        configurations,
        productNames
      );
    }
  }
  return next;
}

export interface StockView {
  costText: string | null;
  needsEntry: boolean;
  quantity: number | null;
  text: string;
  tone: "neutral" | "ok" | "warning";
}

const askForEntryText = "Peça a quem cuida do estoque para dar entrada.";

function requestedByVariant(
  items: readonly { quantity: number; variantId: string }[]
): Map<string, number> {
  const requested = new Map<string, number>();
  for (const item of items) {
    requested.set(
      item.variantId,
      (requested.get(item.variantId) ?? 0) + item.quantity
    );
  }
  return requested;
}

/** How many units a variant lacks when the sale asks for `total` of it in all its lines; undefined when the balance covers it. */
function shortBy(total: number, balance: number): number | undefined {
  const missing = total - balance;
  return missing >= 1 ? missing : undefined;
}

/**
 * The quantity of the other lines of the sale that ask for the same variant: what the line's own quantity adds to
 * before it is compared with the balance. Lines whose quantity is not a whole number count as zero.
 */
export function otherLinesQuantity(
  items: readonly ItemDraft[],
  item: ItemDraft
): number {
  if (item.variantId === "") {
    return 0;
  }
  let sum = 0;
  for (const other of items) {
    if (other.draftId === item.draftId || other.variantId !== item.variantId) {
      continue;
    }
    const parsed = parsePositiveInteger(other.quantity);
    sum += parsed.kind === "ok" ? parsed.value : 0;
  }
  return sum;
}

/**
 * The line's quantity plus the other lines of the same variant, minus the balance the screen shows: the same sum the
 * "Acima do saldo" warning compares. Undefined when the quantity is not a whole number or nothing is missing.
 */
export function stockMissing(
  quantityText: string,
  view: StockView | null,
  otherLines = 0
): number | undefined {
  const parsed = parsePositiveInteger(quantityText);
  const balance = view?.quantity;
  if (parsed.kind !== "ok" || balance === null || balance === undefined) {
    return undefined;
  }
  return shortBy(parsed.value + otherLines, balance);
}

/** Current balance and moving average cost for a chosen variant. */
export function stockView(
  load: Loadable<InventoryBalanceReadModel> | undefined,
  canAdjustStock: boolean
): StockView | null {
  if (load === undefined) {
    return null;
  }
  if (load.status === "loading") {
    return {
      costText: null,
      needsEntry: false,
      quantity: null,
      text: "Consultando estoque…",
      tone: "neutral",
    };
  }
  if (load.status === "error") {
    return {
      costText: null,
      needsEntry: false,
      quantity: null,
      text: `${load.message} Você ainda pode vender: o saldo é conferido ao confirmar.`,
      tone: "warning",
    };
  }
  const { movingAverageCost, quantity } = load.value;
  if (quantity === 0) {
    return {
      costText: null,
      needsEntry: true,
      quantity,
      text: `Sem estoque: saldo 0. ${canAdjustStock ? "Para vender, dê entrada no estoque." : askForEntryText}`,
      tone: "warning",
    };
  }
  const costText =
    movingAverageCost === null
      ? "Custo desconhecido. Margem indeterminada."
      : `Custo médio: ${formatBrlCents(movingAverageCost)}.`;
  return {
    costText,
    needsEntry: false,
    quantity,
    text: `Saldo atual: ${quantity} ${quantity === 1 ? "unidade" : "unidades"}.`,
    tone: "ok",
  };
}

/**
 * The balance on the line of the chosen variant, short ("Saldo 6") when it is just a number; a zero balance, a
 * failed read or a read under way keep the whole sentence, which says what to do.
 */
export function stockLineText(view: StockView): string {
  return view.tone === "ok" && view.quantity !== null
    ? `Saldo ${formatQuantity(view.quantity)}`
    : view.text;
}

/* -------------------------------------------------------------------------- */
/* Fee preview                                                                */
/* -------------------------------------------------------------------------- */

type FeeTone = "known" | "not_applicable" | "unknown" | "zero";

export interface FeeLine {
  text: string;
  tone: FeeTone;
}

/** Unknown is never zero: each state has its own text and tone. */
export function describeFee(
  fee: SalePaymentFeeSnapshot,
  base = "do total devido"
): FeeLine {
  if (fee.mode === "not_applicable") {
    return {
      text: "não se aplica",
      tone: "not_applicable",
    };
  }
  if (fee.amount === null) {
    return { text: "desconhecida — não é zero", tone: "unknown" };
  }
  if (fee.mode === "none") {
    return { text: "R$ 0,00 (sem taxa no perfil)", tone: "zero" };
  }
  const parts = [
    fee.fixedAmount === null ? null : formatBrlAmount(fee.fixedAmount),
    fee.percentage === null
      ? null
      : `${formatPercentage(fee.percentage)} ${base}`,
  ].filter((part): part is string => part !== null);
  const amount = formatBrlAmount(fee.amount);
  const text = parts.length > 0 ? `${amount} (${parts.join(" + ")})` : amount;
  return {
    text,
    tone: Money.from(fee.amount).minorUnits === 0n ? "zero" : "known",
  };
}

function describeSettlementDays(days: number | null): string {
  if (days === null) {
    return "prazo desconhecido — não é zero";
  }
  return `${days} ${days === 1 ? "dia" : "dias"} (estimativa, não é a data de liquidação)`;
}

export interface FeePreview {
  anticipation: FeeLine;
  /** Processing plus anticipation, in cents; null when either is unknown (never taken as zero). */
  feeCents: bigint | null;
  processing: FeeLine;
  profileText: string;
  ruleMatched: boolean;
  ruleText: string;
  settlementText: string;
}

function toProfileForSale(
  profile: PaymentProfileReadModel
): PaymentProfileForSale {
  return {
    id: profile.id,
    name: profile.name,
    rules: profile.rules.map((rule) => ({
      anticipationFee: rule.anticipationFee,
      expectedSettlementDays: rule.expectedSettlementDays,
      id: rule.id,
      installmentPlan: rule.installmentPlan,
      installments: rule.installments,
      method: rule.method,
      processingFee: rule.processingFee,
    })),
    version: profile.version,
  };
}

function describeRule(
  method: string,
  installments: number | null,
  plan: string | null
): string {
  const parts = [methodLabels.get(method) ?? method];
  if (installments !== null) {
    parts.push(`${installments}x`);
  }
  if (plan !== null) {
    parts.push(planLabels[plan] ?? plan);
  }
  return parts.join(" · ");
}

type ProfileSelection =
  | { kind: "none" }
  | { kind: "profile"; profile: PaymentProfileReadModel };

function feeCentsOf(fee: SalePaymentFeeSnapshot): bigint | null {
  if (fee.mode === "not_applicable") {
    return 0n;
  }
  return fee.amount === null ? null : Money.from(fee.amount).minorUnits;
}

function sumOfFees(fees: readonly (bigint | null)[]): bigint | null {
  let sum = 0n;
  for (const fee of fees) {
    if (fee === null) {
      return null;
    }
    sum += fee;
  }
  return sum;
}

/** `base` is what a percentage applies to: the total due, or the amount of a part. */
function buildFeePreview(
  totalDue: string,
  payment: SalePayment,
  selection: ProfileSelection,
  base?: string
): FeePreview | null {
  try {
    const profile =
      selection.kind === "profile" ? toProfileForSale(selection.profile) : null;
    const snapshot = snapshotPaymentProfileForSale(totalDue, payment, profile);
    const ruleMatched = snapshot.paymentProfileRuleId !== null;
    let ruleText = "Sem perfil — nenhuma regra aplicada";
    if (profile) {
      ruleText = ruleMatched
        ? `Regra exata: ${describeRule(payment.method, payment.installments, payment.installmentPlan)}`
        : "Nenhuma regra exata para este método/parcelas";
    }
    return {
      anticipation: describeFee(snapshot.anticipationFee, base),
      feeCents: sumOfFees([
        feeCentsOf(snapshot.processingFee),
        feeCentsOf(snapshot.anticipationFee),
      ]),
      processing: describeFee(snapshot.processingFee, base),
      profileText: profile ? profile.name : "Sem perfil de pagamento",
      ruleMatched,
      ruleText,
      settlementText: describeSettlementDays(snapshot.expectedSettlementDays),
    };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Evaluation: validation, totals, payload                                    */
/* -------------------------------------------------------------------------- */

interface Issue {
  /** True when the field is simply not filled in yet. */
  empty: boolean;
  key: string;
  message: string;
}

export const itemFieldKey = (
  draftId: string,
  field:
    | "chargedUnitPrice"
    | "listedUnitPrice"
    | "product"
    | "quantity"
    | "variant"
) => `item:${draftId}:${field}`;
export const adjustmentFieldKey = (draftId: string) =>
  `adjustment:${draftId}:value`;
export const SALE_DATE_HINT =
  "Vazio é agora. Aceita até 30 dias atrás; nada no futuro.";

/** Said where the date would be, without a connection: the device records the sale at the moment it is kept. */
export const OFFLINE_SALE_DATE_NOTE =
  "Sem internet, a venda fica com a data e a hora de agora: uma data digitada não fica guardada.";

/**
 * The date of the sale is typed in two fields (the day on the DatePicker, the time as text) and kept in the form as
 * one `AAAA-MM-DDTHH:MM` text; a half-typed one keeps the half that exists, which the evaluation refuses.
 */
export function splitSaleDate(local: string): { day: string; time: string } {
  const at = local.indexOf("T");
  return at < 0
    ? { day: local, time: "" }
    : { day: local.slice(0, at), time: local.slice(at + 1) };
}

export function joinSaleDate(day: string, time: string): string {
  const cleanDay = day.trim();
  const cleanTime = time.trim();
  return cleanDay === "" && cleanTime === "" ? "" : `${cleanDay}T${cleanTime}`;
}

/** The time a day starts with when the person picks it before typing one: the device's hour and minute now. */
export function timeOfDay(now: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(now.getHours())}:${two(now.getMinutes())}`;
}

/**
 * The closed line of the date and adjustments: "Agora · Sem ajuste", "02/11/2026 14:30 · 1 ajuste". Without a
 * connection the date is always now (a typed one is not kept).
 */
export function saleExtrasSummary(
  form: SaleFormState,
  offline: boolean
): string {
  const { day, time } = splitSaleDate(form.occurredAtLocal);
  const [year, month, date] = day.split("-");
  const dateText =
    offline || form.occurredAtLocal === ""
      ? "Agora"
      : [
          year && month && date ? `${date}/${month}/${year}` : day,
          saleTimeText(time),
        ]
          .filter((part) => part !== "")
          .join(" ");
  const count = form.adjustments.length;
  const adjustmentsText =
    count === 0
      ? "Sem ajuste"
      : `${count} ${count === 1 ? "ajuste" : "ajustes"}`;
  return `${dateText} · ${adjustmentsText}`;
}

/* The hour may come without the leading zero or the ":" ("9:30", "930", "14h30"): the numeric keypad of the iPhone has
   no ":" key, so the hours and minutes typed as digits are read as such. */
const SALE_TIME_SOURCE = String.raw`(\d{1,2})[:h.]?(\d{2})`;
const localDateTimePattern = new RegExp(
  String.raw`^(\d{4})-(\d{2})-(\d{2})T${SALE_TIME_SOURCE}(?::(\d{2}))?$`
);
const saleTimePattern = new RegExp(`^${SALE_TIME_SOURCE}$`);

/** The typed time as "HH:MM" when it has that shape ("930" is "09:30"); otherwise as typed. */
function saleTimeText(time: string): string {
  const match = saleTimePattern.exec(time.trim());
  return match
    ? `${(match[1] ?? "").padStart(2, "0")}:${match[2] ?? ""}`
    : time;
}

/** Whether the typed time has the shape of an hour and minutes (whether they exist is checked with the date). */
export function saleTimeIsWellFormed(time: string): boolean {
  return saleTimePattern.test(time.trim());
}

type LocalDateTimeParse =
  | { kind: "empty" }
  | { kind: "invalid" }
  | { date: Date; kind: "ok" };

/**
 * Reads the joined day and time (`AAAA-MM-DDTHH:MM`) as a moment in the device time zone. A date
 * that does not exist (`31/02`) is invalid rather than rolled over.
 */
export function parseLocalDateTime(text: string): LocalDateTimeParse {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { kind: "empty" };
  }
  const match = localDateTimePattern.exec(trimmed);
  if (!match) {
    return { kind: "invalid" };
  }
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map((part) => (part === undefined ? 0 : Number(part)));
  const date = new Date(
    year ?? 0,
    (month ?? 1) - 1,
    day ?? 1,
    hour ?? 0,
    minute ?? 0,
    second ?? 0
  );
  const same =
    date.getFullYear() === year &&
    date.getMonth() === (month ?? 1) - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute;
  return same ? { date, kind: "ok" } : { kind: "invalid" };
}

/**
 * The optional commercial date and time: empty means now (chosen when the
 * attempt starts). A value must exist and cannot be more than the server's
 * clock-skew tolerance ahead of this device. The retroactive limit depends on
 * the organization's calendar, so only the server checks it.
 */
export function validateSaleDate(
  text: string,
  now: Date
): { error: string | null; occurredAt: string | null } {
  const parsed = parseLocalDateTime(text);
  if (parsed.kind === "empty") {
    return { error: null, occurredAt: null };
  }
  if (parsed.kind === "invalid") {
    return { error: "Informe uma data e hora válidas.", occurredAt: null };
  }
  if (parsed.date.getTime() > now.getTime() + MAX_FUTURE_CLOCK_SKEW_MS) {
    return {
      error: "A data e hora da venda não podem estar no futuro.",
      occurredAt: null,
    };
  }
  return { error: null, occurredAt: parsed.date.toISOString() };
}

export const formFieldKeys = {
  adjustments: "adjustments",
  installmentPlan: "payment:installmentPlan",
  installments: "payment:installments",
  method: "payment:method",
  occurredAt: "occurredAt",
  profile: "profile",
  totals: "totals",
  ...splitFieldKeys,
} as const;

interface ParsedItem {
  chargedUnitPrice: string;
  draftId: string;
  label: string;
  listedUnitPrice: string;
  quantity: number;
  variantId: string;
}

function pushIssue(
  issues: Issue[],
  key: string,
  message: string,
  empty: boolean
): void {
  issues.push({ empty, key, message });
}

function moneyIssue(
  parse: FieldParse<string>,
  emptyMessage: string
): { empty: boolean; message: string } | null {
  switch (parse.kind) {
    case "ok":
      return null;
    case "empty":
      return { empty: true, message: emptyMessage };
    case "too_large":
      return {
        empty: false,
        message: "O valor excede o limite de 18 dígitos inteiros.",
      };
    default:
      return {
        empty: false,
        message: "Use até 2 casas decimais, com vírgula ou ponto (ex.: 49,90).",
      };
  }
}

function parseQuantityField(item: ItemDraft, issues: Issue[]): number | null {
  const key = itemFieldKey(item.draftId, "quantity");
  const parse = parsePositiveInteger(item.quantity);
  if (parse.kind === "ok") {
    return parse.value;
  }
  if (parse.kind === "empty") {
    pushIssue(issues, key, "Informe a quantidade.", true);
  } else if (parse.kind === "too_large") {
    pushIssue(issues, key, "A quantidade máxima é 2.147.483.647.", false);
  } else {
    pushIssue(issues, key, "Use um número inteiro maior que zero.", false);
  }
  return null;
}

function parsePriceField(
  draftId: string,
  field: "chargedUnitPrice" | "listedUnitPrice",
  text: string,
  issues: Issue[]
): string | null {
  const parse = parseMoneyText(text);
  const issue = moneyIssue(parse, "Informe o preço, por exemplo 49,90.");
  if (issue) {
    pushIssue(issues, itemFieldKey(draftId, field), issue.message, issue.empty);
    return null;
  }
  return parse.kind === "ok" ? parse.value : null;
}

function parseItem(item: ItemDraft, issues: Issue[]): ParsedItem | null {
  if (item.productId === "") {
    pushIssue(
      issues,
      itemFieldKey(item.draftId, "product"),
      "Escolha um produto.",
      true
    );
  } else if (item.variantId === "") {
    pushIssue(
      issues,
      itemFieldKey(item.draftId, "variant"),
      "Escolha a variante.",
      true
    );
  }
  if (item.variantId === "") {
    // quantity and prices are only on screen once the variant is chosen: an error there could not be reached
    return null;
  }
  const quantity = parseQuantityField(item, issues);
  const listed = parsePriceField(
    item.draftId,
    "listedUnitPrice",
    item.listedUnitPrice,
    issues
  );
  const charged = parsePriceField(
    item.draftId,
    "chargedUnitPrice",
    item.chargedUnitPrice,
    issues
  );
  if (
    item.variantId === "" ||
    quantity === null ||
    listed === null ||
    charged === null
  ) {
    return null;
  }
  return {
    chargedUnitPrice: charged,
    draftId: item.draftId,
    label: item.label,
    listedUnitPrice: listed,
    quantity,
    variantId: item.variantId,
  };
}

function parseItems(
  items: readonly ItemDraft[],
  issues: Issue[]
): ParsedItem[] | null {
  const parsed = items.map((item) => parseItem(item, issues));
  const complete = parsed.filter((item): item is ParsedItem => item !== null);
  return complete.length === items.length ? complete : null;
}

function parseAdjustmentValue(
  adjustment: AdjustmentDraft,
  issues: Issue[]
): SaleCommandBody["adjustments"][number] | null {
  const key = adjustmentFieldKey(adjustment.draftId);
  if (adjustment.valueType === "percentage") {
    const parse = parsePercentageText(adjustment.value);
    if (parse.kind === "ok") {
      return {
        kind: adjustment.kind,
        value: { percentage: parse.value, type: "percentage" },
      };
    }
    pushIssue(
      issues,
      key,
      parse.kind === "empty"
        ? "Informe o percentual."
        : "Use até 6 casas decimais, em pontos percentuais (ex.: 2,5 = 2,5%).",
      parse.kind === "empty"
    );
    return null;
  }
  const parse = parseMoneyText(adjustment.value);
  const issue = moneyIssue(parse, "Informe o valor em BRL.");
  if (issue) {
    pushIssue(issues, key, issue.message, issue.empty);
    return null;
  }
  return parse.kind === "ok"
    ? {
        kind: adjustment.kind,
        value: { amount: parse.value, type: "fixed" },
      }
    : null;
}

function parseAdjustments(
  adjustments: readonly AdjustmentDraft[],
  issues: Issue[]
): SaleCommandBody["adjustments"] | null {
  const parsed = adjustments.map((adjustment) =>
    parseAdjustmentValue(adjustment, issues)
  );
  const complete = parsed.filter(
    (adjustment): adjustment is SaleCommandBody["adjustments"][number] =>
      adjustment !== null
  );
  return complete.length === adjustments.length ? complete : null;
}

interface PartKeys {
  amount: string;
  installmentPlan: string;
  installments: string;
  method: string;
  profile: string;
}

const FIRST_PART_KEYS: PartKeys = {
  amount: formFieldKeys.firstAmount,
  installmentPlan: formFieldKeys.installmentPlan,
  installments: formFieldKeys.installments,
  method: formFieldKeys.method,
  profile: formFieldKeys.profile,
};

const SECOND_PART_KEYS: PartKeys = {
  amount: formFieldKeys.secondAmount,
  installmentPlan: formFieldKeys.secondInstallmentPlan,
  installments: formFieldKeys.secondInstallments,
  method: formFieldKeys.secondMethod,
  profile: formFieldKeys.secondProfile,
};

function parsePayment(
  draft: PaymentDraft,
  issues: Issue[],
  keys: PartKeys,
  messages: PartMessages
): SalePayment | null {
  if (draft.method === "") {
    pushIssue(issues, keys.method, messages.methodEmpty, true);
    return null;
  }
  if (draft.method !== "credit_card") {
    return {
      anticipationRequested: false,
      installmentPlan: null,
      installments: null,
      method: draft.method,
    };
  }
  const installments = parsePositiveInteger(draft.installments);
  if (installments.kind !== "ok") {
    pushIssue(
      issues,
      keys.installments,
      installments.kind === "empty"
        ? messages.installmentsEmpty
        : messages.installmentsInvalid,
      installments.kind === "empty"
    );
  }
  if (draft.installmentPlan === "") {
    pushIssue(issues, keys.installmentPlan, messages.planEmpty, true);
  }
  if (installments.kind !== "ok" || draft.installmentPlan === "") {
    return null;
  }
  return {
    anticipationRequested: draft.anticipationRequested,
    installmentPlan: draft.installmentPlan,
    installments: installments.value,
    method: "credit_card",
  };
}

type ProfileResolution =
  | { kind: "blocked" }
  | { kind: "none" }
  | { kind: "profile"; profile: PaymentProfileReadModel };

function resolveProfile(
  selection: ProfileSelectionDraft,
  profiles: readonly PaymentProfileReadModel[],
  issues: Issue[],
  key: string,
  messages: PartMessages
): ProfileResolution {
  if (selection.choice === "") {
    pushIssue(issues, key, messages.profileEmpty, true);
    return { kind: "blocked" };
  }
  if (selection.choice === NO_PROFILE_CHOICE) {
    return { kind: "none" };
  }
  const profile = profiles.find(
    (candidate) => candidate.id === selection.choice
  );
  if (!profile) {
    pushIssue(issues, key, messages.profileInactive, false);
    return { kind: "blocked" };
  }
  if (selection.reviewNotice !== null) {
    pushIssue(issues, key, messages.profileReview, false);
    return { kind: "blocked" };
  }
  return { kind: "profile", profile };
}

const invalidAdjustmentMessage =
  "Revise os ajustes: os valores devem ser positivos e percentual só vale para desconto e acréscimo.";
const percentageCapMessage = `O percentual vai até ${MAX_RATE_PERCENTAGE_POINTS}%.`;

function isAboveRateCap(text: string): boolean {
  try {
    Percentage.fromRate(text);
    return false;
  } catch {
    return isWellFormedPercentage(text);
  }
}

function isWellFormedPercentage(text: string): boolean {
  try {
    Percentage.from(text);
    return true;
  } catch {
    return false;
  }
}

/** True when a percentage adjustment is well formed but above the domain cap on rates. */
function hasPercentageAboveCap(
  adjustments: SaleCommandBody["adjustments"]
): boolean {
  return adjustments.some(
    (adjustment) =>
      adjustment.value.type === "percentage" &&
      isAboveRateCap(adjustment.value.percentage)
  );
}

function calculationIssue(
  error: unknown,
  adjustments: SaleCommandBody["adjustments"]
): Issue {
  if (error instanceof SaleDiscountExceedsSubtotalError) {
    return {
      empty: false,
      key: formFieldKeys.adjustments,
      message: "O total de descontos não pode ser maior que o subtotal.",
    };
  }
  if (error instanceof SaleAdjustmentLimitError) {
    return {
      empty: false,
      key: formFieldKeys.totals,
      message:
        "Algum valor ou o total da venda excede o limite de 18 dígitos inteiros em BRL.",
    };
  }
  if (error instanceof InvalidSaleAdjustmentError) {
    return {
      empty: false,
      key: formFieldKeys.adjustments,
      message: hasPercentageAboveCap(adjustments)
        ? percentageCapMessage
        : invalidAdjustmentMessage,
    };
  }
  return {
    empty: false,
    key: formFieldKeys.totals,
    message: "Não foi possível calcular o total desta venda. Revise os dados.",
  };
}

function calculateTotals(
  items: readonly ParsedItem[],
  adjustments: SaleCommandBody["adjustments"],
  issues: Issue[]
): SaleAdjustmentCalculation | null {
  try {
    return calculateSaleAdjustments({
      adjustments,
      items: items.map((item) => ({
        chargedUnitPrice: item.chargedUnitPrice,
        quantity: item.quantity,
      })),
    });
  } catch (error) {
    issues.push(calculationIssue(error, adjustments));
    return null;
  }
}

interface SummaryRow {
  key: string;
  label: string;
  tone: "discount" | "normal" | "total";
  value: string;
}

interface SummaryLine {
  draftId: string;
  label: string;
  lineTotalText: string;
  negotiationText: string | null;
  priceText: string;
  quantity: number;
}

export interface SaleSummary {
  lines: SummaryLine[];
  rows: SummaryRow[];
  totalDue: string;
}

function adjustmentSummaryLabel(adjustment: NormalizedSaleAdjustment): string {
  const label = adjustmentLabels.get(adjustment.kind) ?? adjustment.kind;
  return adjustment.percentage === null
    ? label
    : `${label} (${formatPercentage(adjustment.percentage)} do subtotal)`;
}

function totalsRows(calculation: SaleAdjustmentCalculation): SummaryRow[] {
  return [
    {
      key: "subtotal",
      label: "Subtotal",
      tone: "normal",
      value: formatBrlAmount(calculation.subtotal),
    },
    ...calculation.adjustments.map((adjustment) => ({
      key: `adjustment-${adjustment.position}`,
      label: adjustmentSummaryLabel(adjustment),
      tone:
        adjustment.kind === "discount"
          ? ("discount" as const)
          : ("normal" as const),
      value: signedBrl(
        adjustment.kind === "discount" ? "-" : "+",
        adjustment.amount
      ),
    })),
    {
      key: "total-due",
      label: "Total devido",
      tone: "total",
      value: formatBrlAmount(calculation.totalDue),
    },
  ];
}

function negotiationText(item: ParsedItem): string | null {
  const difference =
    Money.from(item.chargedUnitPrice).minorUnits -
    Money.from(item.listedUnitPrice).minorUnits;
  if (difference === 0n) {
    return null;
  }
  const amount = Money.fromMinorUnits(
    difference < 0n ? -difference : difference
  ).toString();
  const direction = difference < 0n ? "abaixo" : "acima";
  return `Negociação: ${formatBrlAmount(amount)} ${direction} do preço de tabela por unidade, já considerada no subtotal.`;
}

function buildSummary(
  items: readonly ParsedItem[],
  calculation: SaleAdjustmentCalculation
): SaleSummary {
  return {
    lines: items.map((item) => ({
      draftId: item.draftId,
      label: item.label,
      lineTotalText: formatBrlAmount(
        Money.from(item.chargedUnitPrice)
          .multiplyByQuantity(item.quantity)
          .toString()
      ),
      negotiationText: negotiationText(item),
      priceText: formatBrlAmount(item.chargedUnitPrice),
      quantity: item.quantity,
    })),
    rows: totalsRows(calculation),
    totalDue: calculation.totalDue,
  };
}

function stockWarnings(
  items: readonly ParsedItem[],
  stock: Readonly<Record<string, Loadable<InventoryBalanceReadModel>>>
): Record<string, string> {
  const requested = requestedByVariant(items);
  const warnings: Record<string, string> = {};
  for (const item of items) {
    const balance = stock[item.variantId];
    const total = requested.get(item.variantId) ?? 0;
    if (
      balance?.status === "ready" &&
      balance.value.quantity !== 0 &&
      shortBy(total, balance.value.quantity) !== undefined
    ) {
      warnings[item.draftId] =
        `Acima do saldo (${balance.value.quantity}): a venda é recusada se ele não bastar.`;
    }
  }
  return warnings;
}

export interface EvaluationContext {
  profiles: readonly PaymentProfileReadModel[];
  stock: Readonly<Record<string, Loadable<InventoryBalanceReadModel>>>;
}

interface SplitPartSummary {
  amountText: string | null;
  methodText: string;
}

export interface SplitEvaluation {
  /** The state of the parts against the total; null while the total or an amount cannot be read yet. */
  balance: SplitBalance | null;
  /** The fees of both parts added up; unknown when either part's is, null until both previews exist. */
  feesTotal: FeeLine | null;
  /** The field where the parts not closing the total was reported; null when they close it. */
  mismatchKey: string | null;
  /** The fee preview of each part, by position; null where the part is not complete. */
  partPreviews: readonly [FeePreview | null, FeePreview | null];
  /** What the summary says of each part, by position: the method and the amount (null until it can be read). */
  parts: readonly [SplitPartSummary, SplitPartSummary];
  /** "O total mudou. Confira as partes." while typed parts no longer match the total they were checked against. */
  totalChangedNotice: string | null;
}

export interface SaleEvaluation {
  /** Command body, present only when the whole form is valid. */
  body: SaleCommandBody | null;
  /** Text for the summary: the chosen date, or that it will be now. */
  dateText: string;
  /** Visible field errors keyed by field. Required-but-empty only after submit. */
  errors: Record<string, string>;
  feePreview: FeePreview | null;
  /** The field of the first problem, in the order of the screen; null when the form is valid. */
  firstIssueKey: string | null;
  /** Every problem, including fields that are just not filled in yet. */
  issueCount: number;
  /** Whether a method is chosen: the summary shows only what is. */
  methodChosen: boolean;
  methodText: string;
  /** ISO instant chosen by the operator; null means now at attempt creation. */
  occurredAtOverride: string | null;
  /** Whether a profile (or "Sem perfil") is chosen. */
  profileChosen: boolean;
  profileText: string;
  /** Present only while the sale is paid in two parts. */
  split: SplitEvaluation | null;
  /** The total due as the API writes it (`123.45`); null while items or adjustments cannot be read. */
  totalDue: string | null;
  stockWarnings: Record<string, string>;
  summary: SaleSummary | null;
}

function methodSummary(payment: PaymentDraft): string {
  if (payment.method === "") {
    return "Método de pagamento ainda não escolhido";
  }
  const label = methodLabels.get(payment.method) ?? payment.method;
  if (payment.method !== "credit_card") {
    return label;
  }
  const installments = payment.installments.trim() || "?";
  const plan =
    payment.installmentPlan === ""
      ? "quem parcela não escolhido"
      : (planLabels[payment.installmentPlan] ?? payment.installmentPlan);
  return `${label} · ${installments}x · ${plan}`;
}

function profileSummary(
  selection: ProfileSelectionDraft,
  resolution: ProfileResolution
): string {
  if (selection.choice === "") {
    return "Perfil de pagamento ainda não escolhido";
  }
  if (resolution.kind === "profile") {
    return resolution.profile.name;
  }
  if (selection.choice === NO_PROFILE_CHOICE) {
    return "Sem perfil de pagamento (taxas e prazo desconhecidos)";
  }
  return "Perfil de pagamento a revisar";
}

function visibleErrors(
  issues: readonly Issue[],
  showRequired: boolean
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    if ((showRequired || !issue.empty) && errors[issue.key] === undefined) {
      errors[issue.key] = issue.message;
    }
  }
  return errors;
}

function profileSelectionOfResolution(
  resolution: ProfileResolution
): SalePaymentProfileSelection | null {
  return resolution.kind === "profile"
    ? {
        expectedVersion: resolution.profile.version,
        id: resolution.profile.id,
      }
    : null;
}

type SalePaymentProfileSelection = NonNullable<
  SaleCommandBody["paymentProfile"]
>;

function buildBody(
  items: readonly ParsedItem[],
  adjustments: SaleCommandBody["adjustments"],
  payment: SalePayment,
  resolution: ProfileResolution
): SaleCommandBody | null {
  if (resolution.kind === "blocked") {
    return null;
  }
  return {
    adjustments,
    commandVersion: CONFIRM_SALE_COMMAND_VERSION,
    items: bodyItems(items),
    payment,
    paymentProfile: profileSelectionOfResolution(resolution),
  };
}

function bodyItems(items: readonly ParsedItem[]): SaleCommandBody["items"] {
  return items.map((item) => ({
    chargedUnitPrice: item.chargedUnitPrice,
    listedUnitPrice: item.listedUnitPrice,
    quantity: item.quantity,
    variantId: item.variantId,
  }));
}

interface ResolvedPart {
  amount: string;
  payment: SalePayment;
  resolution: ProfileResolution;
}

/** The body of a sale in two parts: `payments` instead of `payment`, the profile inside each part. */
function buildSplitBody(
  items: readonly ParsedItem[],
  adjustments: SaleCommandBody["adjustments"],
  parts: readonly ResolvedPart[]
): SaleCommandBody {
  return {
    adjustments,
    commandVersion: CONFIRM_SALE_COMMAND_VERSION,
    items: bodyItems(items),
    payments: parts.map(({ amount, payment, resolution }) => ({
      ...payment,
      amount,
      paymentProfile: profileSelectionOfResolution(resolution),
    })),
  };
}

interface EvaluatedPart {
  payment: SalePayment | null;
  resolution: ProfileResolution;
}

/**
 * `readAmount` reads the amount of a part, whose field sits right after the method on the screen: its problems come
 * after the method's and before the credit fields' and the profile's, so the first problem is the first on the screen.
 */
function evaluatePart(
  draft: { payment: PaymentDraft; profile: ProfileSelectionDraft },
  context: EvaluationContext,
  issues: Issue[],
  keys: PartKeys,
  messages: PartMessages,
  readAmount: () => PartAmount = () => ({ kind: "invalid" })
): EvaluatedPart & { amount: PartAmount } {
  const paymentIssues: Issue[] = [];
  const payment = parsePayment(draft.payment, paymentIssues, keys, messages);
  issues.push(...paymentIssues.filter((issue) => issue.key === keys.method));
  const amount = readAmount();
  issues.push(...paymentIssues.filter((issue) => issue.key !== keys.method));
  return {
    amount,
    payment,
    resolution: resolveProfile(
      draft.profile,
      context.profiles,
      issues,
      keys.profile,
      messages
    ),
  };
}

type PartAmount =
  | { kind: "invalid" }
  | { cents: bigint; kind: "ok"; text: string };

function parsePartAmount(
  text: string,
  issues: Issue[],
  key: string,
  messages: PartMessages
): PartAmount {
  const parse = parseMoneyText(text);
  const issue = moneyIssue(parse, messages.amountEmpty);
  if (issue) {
    pushIssue(issues, key, issue.message, issue.empty);
    return { kind: "invalid" };
  }
  if (parse.kind !== "ok") {
    return { kind: "invalid" };
  }
  const cents = centsOfMoney(parse.value);
  if (cents <= 0n) {
    pushIssue(issues, key, messages.amountNotPositive, false);
    return { kind: "invalid" };
  }
  return { cents, kind: "ok", text: parse.value };
}

interface SplitResult {
  body: SaleCommandBody | null;
  evaluation: SplitEvaluation;
  first: EvaluatedPart;
  second: EvaluatedPart;
}

/**
 * The two parts against the total due. Part 2 that nobody typed in takes the rest; any difference after that is
 * "Falta"/"Passou", and the body is not built until the parts close the total to the cent.
 */
function evaluateSplit(
  split: SplitDraft,
  form: SaleFormState,
  context: EvaluationContext,
  parsed: {
    adjustments: SaleCommandBody["adjustments"] | null;
    calculation: SaleAdjustmentCalculation | null;
    items: readonly ParsedItem[] | null;
  },
  issues: Issue[]
): SplitResult {
  const firstMessages = partMessages(1);
  const secondMessages = partMessages(2);
  const total = parsed.calculation?.totalDue ?? null;
  const totalCents = total === null ? null : centsOfMoney(total);
  const first = evaluatePart(
    form,
    context,
    issues,
    FIRST_PART_KEYS,
    firstMessages,
    () =>
      parsePartAmount(
        split.firstAmount,
        issues,
        FIRST_PART_KEYS.amount,
        firstMessages
      )
  );
  const firstAmount = first.amount;
  const secondDraft = split.second;
  const second = evaluatePart(
    secondDraft,
    context,
    issues,
    SECOND_PART_KEYS,
    secondMessages,
    () =>
      secondDraft.amount === null
        ? secondAmountOfRest(firstAmount, totalCents)
        : parsePartAmount(
            secondDraft.amount,
            issues,
            SECOND_PART_KEYS.amount,
            secondMessages
          )
  );
  const secondAmount = second.amount;
  const previews = [
    partPreview(first, firstAmount),
    partPreview(second, secondAmount),
  ] as const;
  const balance =
    totalCents !== null &&
    firstAmount.kind === "ok" &&
    secondAmount.kind === "ok"
      ? splitBalance({
          first: firstAmount.cents,
          methods: [form.payment.method, secondDraft.payment.method],
          second: secondDraft.amount === null ? null : secondAmount.cents,
          total: totalCents,
        })
      : null;
  const totalChangedNotice = splitTotalChangedNotice(split, total);
  let mismatchKey: string | null = null;
  if (balance !== null && balance.kind !== "closed" && total !== null) {
    mismatchKey =
      balance.kind === "over" && secondDraft.amount === null
        ? FIRST_PART_KEYS.amount
        : SECOND_PART_KEYS.amount;
    pushIssue(
      issues,
      mismatchKey,
      splitMismatchMessage(balance, total, totalChangedNotice),
      false
    );
  } else if (
    balance !== null &&
    secondAmount.kind === "ok" &&
    secondAmount.cents <= 0n
  ) {
    pushIssue(
      issues,
      SECOND_PART_KEYS.amount,
      secondMessages.amountNotPositive,
      false
    );
  }
  const body =
    issues.length === 0 &&
    balance?.kind === "closed" &&
    parsed.items &&
    parsed.adjustments &&
    first.payment &&
    second.payment &&
    firstAmount.kind === "ok" &&
    secondAmount.kind === "ok" &&
    first.resolution.kind !== "blocked" &&
    second.resolution.kind !== "blocked"
      ? buildSplitBody(parsed.items, parsed.adjustments, [
          {
            amount: firstAmount.text,
            payment: first.payment,
            resolution: first.resolution,
          },
          {
            amount: secondAmount.text,
            payment: second.payment,
            resolution: second.resolution,
          },
        ])
      : null;
  return {
    body,
    evaluation: {
      balance,
      feesTotal: feesTotalOf(previews),
      mismatchKey,
      partPreviews: previews,
      parts: [
        partSummary(form.payment, firstAmount),
        partSummary(secondDraft.payment, secondAmount),
      ],
      totalChangedNotice,
    },
    first,
    second,
  };
}

function partSummary(
  payment: PaymentDraft,
  amount: PartAmount
): SplitPartSummary {
  return {
    amountText: amount.kind === "ok" ? formatBrlAmount(amount.text) : null,
    methodText: methodSummary(payment),
  };
}

function secondAmountOfRest(
  first: PartAmount,
  total: bigint | null
): PartAmount {
  if (first.kind !== "ok" || total === null) {
    return { kind: "invalid" };
  }
  const rest = restOfTotal(total, first.cents);
  return { cents: rest, kind: "ok", text: moneyOfCents(rest) };
}

/** The error of the amount field when the parts do not close the total: the rule, then how far they are. */
function splitMismatchMessage(
  balance: SplitBalance,
  total: string,
  totalChangedNotice: string | null
): string {
  const message = `A soma das partes precisa ser ${formatBrlAmount(total)}. ${balance.text}.`;
  return totalChangedNotice === null
    ? message
    : `${message} ${totalChangedNotice}`;
}

function feesTotalOf(
  previews: readonly [FeePreview | null, FeePreview | null]
): FeeLine | null {
  const [first, second] = previews;
  if (first === null || second === null) {
    return null;
  }
  const sum = sumOfFees([first.feeCents, second.feeCents]);
  if (sum === null) {
    return { text: "desconhecida — não é zero", tone: "unknown" };
  }
  return {
    text: formatBrlAmount(moneyOfCents(sum)),
    tone: sum === 0n ? "zero" : "known",
  };
}

function partPreview(
  part: EvaluatedPart,
  amount: PartAmount
): FeePreview | null {
  if (
    part.payment === null ||
    part.resolution.kind === "blocked" ||
    amount.kind !== "ok" ||
    amount.cents <= 0n
  ) {
    return null;
  }
  return buildFeePreview(
    amount.text,
    part.payment,
    part.resolution,
    "do valor da parte"
  );
}

/**
 * Validates the whole form, computes the exact totals with the domain
 * calculation, previews the payment fees and builds the command body. Nothing
 * here touches the network. A sale paid in one go builds `payment`, as it
 * always did; one paid in two parts builds `payments`.
 */
export function evaluateSaleForm(
  form: SaleFormState,
  context: EvaluationContext,
  options: { now?: Date | undefined; showRequired: boolean }
): SaleEvaluation {
  const issues: Issue[] = [];
  const date = validateSaleDate(
    form.occurredAtLocal,
    options.now ?? new Date()
  );
  if (date.error) {
    pushIssue(issues, formFieldKeys.occurredAt, date.error, false);
  }
  const items = parseItems(form.items, issues);
  const adjustments = parseAdjustments(form.adjustments, issues);
  const totalsIssues: Issue[] = [];
  const calculation =
    items && adjustments
      ? calculateTotals(items, adjustments, totalsIssues)
      : null;
  const split =
    form.split === null
      ? null
      : evaluateSplit(
          form.split,
          form,
          context,
          { adjustments, calculation, items },
          issues
        );
  const single =
    split === null
      ? evaluatePart(form, context, issues, FIRST_PART_KEYS, partMessages(null))
      : null;
  issues.push(...totalsIssues);
  const first = single ?? (split as SplitResult).first;
  const summary =
    items && calculation ? buildSummary(items, calculation) : null;
  const feePreview =
    calculation && single?.payment && single.resolution.kind !== "blocked"
      ? buildFeePreview(calculation.totalDue, single.payment, single.resolution)
      : null;
  const body =
    split === null
      ? singleBody(items, adjustments, single, issues)
      : split.body;
  return {
    body,
    dateText:
      date.occurredAt === null
        ? "Agora, ao confirmar"
        : formatInstant(date.occurredAt),
    errors: visibleErrors(issues, options.showRequired),
    feePreview,
    firstIssueKey: issues[0]?.key ?? null,
    issueCount: issues.length,
    methodChosen: partsChosen(form, (draft) => draft.payment.method !== ""),
    methodText: joinParts(form, (draft) => methodSummary(draft.payment)),
    occurredAtOverride: date.occurredAt,
    profileChosen: partsChosen(form, (draft) => draft.profile.choice !== ""),
    profileText:
      split === null || form.split === null
        ? profileSummary(form.profile, first.resolution)
        : [
            profileSummary(form.profile, first.resolution),
            profileSummary(form.split.second.profile, split.second.resolution),
          ].join(" + "),
    split: split?.evaluation ?? null,
    stockWarnings: items ? stockWarnings(items, context.stock) : {},
    summary,
    totalDue: calculation?.totalDue ?? null,
  };
}

function singleBody(
  items: readonly ParsedItem[] | null,
  adjustments: SaleCommandBody["adjustments"] | null,
  single: EvaluatedPart | null,
  issues: readonly Issue[]
): SaleCommandBody | null {
  return issues.length === 0 && items && adjustments && single?.payment
    ? buildBody(items, adjustments, single.payment, single.resolution)
    : null;
}

interface PartDraft {
  payment: PaymentDraft;
  profile: ProfileSelectionDraft;
}

function partDrafts(form: SaleFormState): PartDraft[] {
  return form.split === null ? [form] : [form, form.split.second];
}

function partsChosen(
  form: SaleFormState,
  chosen: (draft: PartDraft) => boolean
): boolean {
  return partDrafts(form).every(chosen);
}

function joinParts(
  form: SaleFormState,
  text: (draft: PartDraft) => string
): string {
  return partDrafts(form).map(text).join(" + ");
}

/* -------------------------------------------------------------------------- */
/* Idempotency: one attempt keeps one command ID and one instant              */
/* -------------------------------------------------------------------------- */

export interface SaleAttempt {
  commandId: string;
  occurredAt: string;
  /** The profile and version the body was sent with, for a resend whose first answer was lost. Absent in older attempts. */
  paymentProfile?: SaleCommandBody["paymentProfile"] | undefined;
  /** The same for a sale in two parts: the profile each part was sent with, by position. */
  paymentProfiles?: readonly (SalePaymentProfileSelection | null)[] | undefined;
  /** Device clock when the attempt started; local evidence only. */
  recordedAt: string;
  signature: string;
}

function bodySignature(
  body: SaleCommandBody,
  organizationId: string,
  occurredAtOverride: string | null
): string {
  return JSON.stringify({ body, occurredAtOverride, organizationId });
}

/**
 * The server replays a repeated command ID only for an identical payload, so
 * an identical retry keeps the previous command ID and commercial instant. Any
 * change to the payload (including a new profile version) starts a new attempt,
 * but for the version kept by `bodyOfUnsettledAttempt`.
 */
export function resolveSaleAttempt(
  previous: SaleAttempt | null,
  body: SaleCommandBody,
  organizationId: string,
  createId: () => string,
  now: Date,
  occurredAtOverride: string | null = null
): SaleAttempt {
  const signature = bodySignature(body, organizationId, occurredAtOverride);
  if (previous !== null && previous.signature === signature) {
    return previous;
  }
  return {
    commandId: createId(),
    occurredAt: occurredAtOverride ?? now.toISOString(),
    paymentProfile: body.paymentProfile,
    ...(body.payments
      ? {
          paymentProfiles: body.payments.map((part) => part.paymentProfile),
        }
      : {}),
    recordedAt: now.toISOString(),
    signature,
  };
}

/**
 * An attempt sent with no answer may already be a sale on the server, which replays it before it looks at the profile
 * version. When the only change to the body is the version of the same profile, edited in the meantime, the body goes
 * again with the version it was sent with: the live one would be another payload, a new command ID and the sale twice.
 * If the sale never reached the server, that version is refused as a version conflict, a definite answer.
 */
function bodyOfUnsettledAttempt(
  previous: SaleAttempt | null,
  body: SaleCommandBody,
  organizationId: string,
  occurredAtOverride: string | null
): SaleCommandBody {
  const sentBody =
    body.payments === undefined
      ? withSentProfile(previous, body)
      : withSentProfiles(previous, body, body.payments);
  return sentBody !== body &&
    bodySignature(sentBody, organizationId, occurredAtOverride) ===
      previous?.signature
    ? sentBody
    : body;
}

function withSentProfile(
  previous: SaleAttempt | null,
  body: SaleCommandBody
): SaleCommandBody {
  const sent = previous?.paymentProfile;
  if (
    !sent ||
    body.paymentProfile?.id !== sent.id ||
    body.paymentProfile.expectedVersion === sent.expectedVersion
  ) {
    return body;
  }
  return {
    ...body,
    paymentProfile: {
      ...body.paymentProfile,
      expectedVersion: sent.expectedVersion,
    },
  };
}

function withSentProfiles(
  previous: SaleAttempt | null,
  body: SaleCommandBody,
  parts: NonNullable<SaleCommandBody["payments"]>
): SaleCommandBody {
  const sent = previous?.paymentProfiles;
  if (!sent || sent.length !== parts.length) {
    return body;
  }
  const payments = parts.map((part, index) => {
    const was = sent[index];
    return was &&
      part.paymentProfile?.id === was.id &&
      part.paymentProfile.expectedVersion !== was.expectedVersion
      ? {
          ...part,
          paymentProfile: {
            ...part.paymentProfile,
            expectedVersion: was.expectedVersion,
          },
        }
      : part;
  });
  return { ...body, payments };
}

export type PreparedConfirmation =
  | { attempt: SaleAttempt; ok: true; request: ConfirmSaleRequest }
  | { message: string; ok: false };

/**
 * Builds the single confirm request. The same domain normalization the server
 * runs is applied first, so a form the browser accepts is never rejected for
 * shape or arithmetic reasons.
 */
export function prepareConfirmation(input: {
  /** The previous attempt was sent with no answer: see `bodyOfUnsettledAttempt`. */
  attemptUnsettled?: boolean;
  body: SaleCommandBody;
  createId: () => string;
  now: Date;
  /** The operator's commercial instant; null means now. */
  occurredAtOverride?: string | null;
  organizationId: string;
  previousAttempt: SaleAttempt | null;
}): PreparedConfirmation {
  const override = input.occurredAtOverride ?? null;
  if (
    override !== null &&
    new Date(override).getTime() >
      input.now.getTime() + MAX_FUTURE_CLOCK_SKEW_MS
  ) {
    return {
      message: "A data e hora da venda não podem estar no futuro.",
      ok: false,
    };
  }
  const body = input.attemptUnsettled
    ? bodyOfUnsettledAttempt(
        input.previousAttempt,
        input.body,
        input.organizationId,
        override
      )
    : input.body;
  const attempt = resolveSaleAttempt(
    input.previousAttempt,
    body,
    input.organizationId,
    input.createId,
    input.now,
    override
  );
  const command = {
    ...body,
    commandId: attempt.commandId,
    occurredAt: attempt.occurredAt,
    recordedAt: attempt.recordedAt,
  };
  const request: ConfirmSaleRequest = {
    ...command,
    organizationId: input.organizationId,
  };
  try {
    normalizeConfirmSaleCommand(command, input.now);
  } catch {
    return {
      message:
        "Os dados da venda não passaram na validação final. Revise itens, ajustes e pagamento.",
      ok: false,
    };
  }
  return { attempt, ok: true, request };
}

/* -------------------------------------------------------------------------- */
/* Submission state and server errors                                         */
/* -------------------------------------------------------------------------- */

type SaleFailureKind =
  | "bad_request"
  | "conflict"
  | "forbidden"
  | "network"
  | "not_found"
  | "server"
  | "unauthorized"
  | "unknown";

export interface SaleSubmitFailure {
  /** The attempt cannot be resent as is: the next confirm gets a fresh attempt. */
  discardAttempt: boolean;
  /** The line the refusal points at; `missing` is requested minus the balance the screen held, as the message says. */
  entry: { label: string; missing: number; variantId: string } | null;
  kind: SaleFailureKind;
  message: string;
  /** The position of the payment part the server named (`error.data.part`, from 0), when it named one. */
  part?: number;
  /** Stable domain code from `error.data.reason`, when the server sent one. */
  reason: string | null;
  /** The server rejected the sale on current data: reload catalog and profiles. */
  refreshData: boolean;
  /** Network, 5xx or unknown error: the sale may already be registered. */
  unknownOutcome: boolean;
}

interface ReasonOutcome {
  discardAttempt?: boolean;
  message: string;
  refreshData?: boolean;
}

const variantGoneMessage =
  "Uma das variantes não existe mais nesta loja. Remova a linha, atualize os dados e revise a venda.";

const stockRefusalFallbackMessage =
  "A venda não foi registrada: falta estoque em um ou mais itens. Confira o saldo de cada um.";

const reasonOutcomes = new Map<string, ReasonOutcome>([
  [
    "insufficient_stock",
    {
      discardAttempt: true,
      message: stockRefusalFallbackMessage,
      refreshData: true,
    },
  ],
  [
    "inventory_quantity_limit",
    {
      message:
        "A quantidade informada ultrapassa o limite de estoque permitido. Reduza a quantidade.",
    },
  ],
  [
    "sale_product_unavailable",
    {
      message:
        "Um dos produtos foi arquivado ou removido e não pode mais ser vendido. Remova essa linha e atualize os dados.",
      refreshData: true,
    },
  ],
  [
    "inventory_variant_not_found",
    { message: variantGoneMessage, refreshData: true },
  ],
  [
    "product_variant_not_found",
    { message: variantGoneMessage, refreshData: true },
  ],
  [
    "product_not_found",
    {
      message:
        "Um dos produtos não existe mais nesta loja. Remova a linha, atualize os dados e revise a venda.",
      refreshData: true,
    },
  ],
  [
    "payment_profile_version_conflict",
    {
      message:
        "O perfil de pagamento foi editado depois que você o escolheu. Atualize os perfis e revise a prévia de taxas e prazo antes de confirmar.",
      refreshData: true,
    },
  ],
  [
    "payment_profile_lifecycle_conflict",
    {
      message:
        "O perfil de pagamento escolhido foi arquivado. Atualize os perfis e escolha outro perfil ou “Sem perfil”.",
      refreshData: true,
    },
  ],
  [
    "payment_profile_not_found",
    {
      message:
        "O perfil de pagamento escolhido não existe mais. Atualize os perfis e escolha novamente.",
      refreshData: true,
    },
  ],
  [
    "sale_payment_split_mismatch",
    {
      message:
        "A soma das partes não fecha o total da venda. Confira o valor de cada parte e confirme de novo.",
    },
  ],
  [
    "sale_command_conflict",
    {
      discardAttempt: true,
      message:
        "Esta tentativa já tinha sido usada com outro conteúdo. Uma nova tentativa será criada automaticamente; revise a venda e confirme novamente.",
    },
  ],
  [
    "sale_occurred_in_future",
    {
      discardAttempt: true,
      message:
        "O horário da venda está adiantado em relação ao servidor. Verifique o relógio do dispositivo.",
    },
  ],
  [
    "sale_occurred_too_old",
    {
      discardAttempt: true,
      message:
        "A data da venda é mais antiga que o limite retroativo de 30 dias. Escolha uma data mais recente em “Data e hora da venda” e confirme de novo.",
    },
  ],
  [
    "sale_discount_exceeds_subtotal",
    {
      message:
        "O total de descontos não pode ser maior que o subtotal. Revise os ajustes.",
    },
  ],
  [
    "invalid_sale_payment",
    {
      message:
        "O pagamento informado é inválido. Revise método, parcelas e quem parcela.",
    },
  ],
  [
    "invalid_sale_adjustment",
    {
      message: invalidAdjustmentMessage,
    },
  ],
  [
    "invalid_confirm_sale_command",
    {
      message:
        "Os dados da venda foram recusados na validação. Revise itens, ajustes e pagamento.",
    },
  ],
  [
    "sale_adjustment_limit",
    {
      message:
        "Algum valor ou o total da venda excede o limite de 18 dígitos inteiros em BRL.",
    },
  ],
]);

const lockHint =
  "A venda foi bloqueada para edição. Use “Tentar novamente (seguro)”: o mesmo pedido é reenviado e o servidor não duplica a venda se ela já tiver sido registrada.";

function failure(
  kind: SaleFailureKind,
  message: string,
  options: {
    discardAttempt?: boolean;
    part?: number | null;
    reason?: string | null;
    refreshData?: boolean;
  } = {}
): SaleSubmitFailure {
  return {
    discardAttempt: options.discardAttempt ?? false,
    entry: null,
    kind,
    message,
    ...(options.part === undefined || options.part === null
      ? {}
      : { part: options.part }),
    reason: options.reason ?? null,
    refreshData: options.refreshData ?? false,
    unknownOutcome:
      kind === "network" || kind === "server" || kind === "unknown",
  };
}

/** Failures the server answered definitively, from the oRPC code alone. */
function definiteFailure(code: string | undefined): SaleSubmitFailure | null {
  switch (code) {
    case "UNAUTHORIZED":
      return failure("unauthorized", "A venda não foi registrada.");
    case "FORBIDDEN":
      return failure(
        "forbidden",
        "Sua conta não tem permissão para registrar vendas nesta loja."
      );
    case "BAD_REQUEST":
      return failure(
        "bad_request",
        "O servidor recusou os dados da venda. Revise itens, preços, ajustes e pagamento."
      );
    case "NOT_FOUND":
      return failure(
        "not_found",
        "Um produto, uma variante ou o perfil de pagamento desta venda não existe mais nesta loja. Atualize os dados e revise a venda.",
        { refreshData: true }
      );
    case "CONFLICT":
      return failure(
        "conflict",
        "A venda não foi registrada: algo mudou (estoque, produto ou perfil de pagamento). Atualize os dados e revise a venda.",
        { refreshData: true }
      );
    default:
      return null;
  }
}

/** True when the server answered definitively (4xx); anything else may have taken effect. */
export function isDefiniteRejection(error: unknown): boolean {
  return definiteFailure(rpcErrorCode(error)) !== null;
}

function rpcErrorPart(error: unknown): number | null {
  const data =
    typeof error === "object" && error !== null && "data" in error
      ? (error as { data?: unknown }).data
      : null;
  const part =
    typeof data === "object" && data !== null && "part" in data
      ? (data as { part?: unknown }).part
      : null;
  return typeof part === "number" && Number.isInteger(part) && part >= 0
    ? part
    : null;
}

/** The server does not say why it refused an adjustment: the cap is known from what was sent. */
function refusalMessage(
  reason: string | null,
  message: string,
  sentAdjustments: SaleCommandBody["adjustments"]
): string {
  return reason === "invalid_sale_adjustment" &&
    hasPercentageAboveCap(sentAdjustments)
    ? percentageCapMessage
    : message;
}

/**
 * Maps an oRPC error to a message and to what the page should do next. A known
 * `data.reason` on a 400/404/409 refines the generic per-code message.
 */
export function mapSaleSubmitError(
  error: unknown,
  sentAdjustments: SaleCommandBody["adjustments"]
): SaleSubmitFailure {
  // a definite refusal like any FORBIDDEN, so the items stay on the screen; the shell offers `/aceite`
  if (isLegalAcceptanceRefusal(error)) {
    return failure(
      "forbidden",
      "A venda não foi registrada porque falta aceitar os Termos de Uso e a Política de Privacidade. Os itens continuam aqui."
    );
  }
  const code = rpcErrorCode(error);
  const byCode = definiteFailure(code);
  if (byCode) {
    const reason = rpcErrorReason(error) ?? null;
    const outcome = reason === null ? undefined : reasonOutcomes.get(reason);
    const refinable =
      byCode.kind === "bad_request" ||
      byCode.kind === "not_found" ||
      byCode.kind === "conflict";
    if (!(outcome && refinable)) {
      return { ...byCode, reason: refinable ? reason : null };
    }
    const message = refusalMessage(reason, outcome.message, sentAdjustments);
    return failure(byCode.kind, message, {
      discardAttempt: outcome.discardAttempt ?? false,
      part: rpcErrorPart(error),
      reason,
      refreshData: outcome.refreshData ?? false,
    });
  }
  if (code === undefined && error instanceof TypeError) {
    return failure(
      "network",
      `Sem conexão com o servidor: não sabemos se a venda foi registrada. ${lockHint}`
    );
  }
  if (isServerFailureCode(code)) {
    return failure(
      "server",
      `O servidor não conseguiu concluir a venda agora e não sabemos se ela foi registrada. ${lockHint}`
    );
  }
  return failure(
    "unknown",
    `Não foi possível confirmar se a venda foi registrada. ${lockHint}`
  );
}

interface ConfirmedSaleDetail {
  label: string;
  tone: FeeTone | "plain";
  value: string;
}

interface ConfirmedSaleItemView {
  /** The price charged per unit, with the quantity: "2 × R$ 114,95". */
  chargedText: string;
  costText: string;
  key: string;
  label: string;
  /** The table price, only when it differs from the charged one: "tabela R$ 139,90". */
  listedText: string | null;
  /** The total of the line, the charged price times the quantity. */
  totalText: string;
}

/** The figure beside the total at the top of the receipt, from what the sale already carries. */
interface ConfirmedSaleSummary {
  /** Number of lines of the sale, the same figure the history list shows. */
  itemCount: number;
}

export interface ConfirmedSaleView {
  headline: string;
  items: ConfirmedSaleItemView[];
  note: string;
  /** The part at position 0; a sale with `paymentParts` is drawn from them instead. */
  paymentDetails: ConfirmedSaleDetail[];
  /** Present only for a sale paid in more than one part. */
  paymentParts?: ConfirmedPaymentPartView[];
  replayed: boolean;
  saleDetails: ConfirmedSaleDetail[];
  saleId: string;
  summary: ConfirmedSaleSummary;
  totals: SummaryRow[];
}

function confirmedSummary(sale: ConfirmedSaleReadModel): ConfirmedSaleSummary {
  return {
    itemCount: sale.items.length,
  };
}

function confirmedItems(sale: ConfirmedSaleReadModel): ConfirmedSaleItemView[] {
  return sale.items.map((item) => {
    const charged = formatBrlAmount(item.chargedUnitPrice);
    const listed = formatBrlAmount(item.listedUnitPrice);
    return {
      chargedText: `${item.quantity} × ${charged}`,
      costText:
        item.unitCost === null
          ? "Custo desconhecido. Margem indeterminada."
          : `Custo unitário registrado: ${formatBrlCents(item.unitCost)}.`,
      key: `${item.position}-${item.variantId}`,
      label: item.productLabel,
      listedText: listed === charged ? null : `tabela ${listed}`,
      totalText: formatBrlAmount(
        Money.from(item.chargedUnitPrice)
          .multiplyByQuantity(item.quantity)
          .toString()
      ),
    };
  });
}

function confirmedTotals(sale: ConfirmedSaleReadModel): SummaryRow[] {
  const adjustments: SummaryRow[] = sale.adjustments.map((adjustment) => {
    const label = adjustmentLabels.get(adjustment.kind) ?? adjustment.kind;
    return {
      key: `adjustment-${adjustment.position}`,
      label:
        adjustment.percentage === null
          ? label
          : `${label} (${formatPercentage(adjustment.percentage)} do subtotal)`,
      tone: adjustment.kind === "discount" ? "discount" : "normal",
      value: signedBrl(
        adjustment.kind === "discount" ? "-" : "+",
        adjustment.amount
      ),
    };
  });
  return [
    {
      key: "subtotal",
      label: "Subtotal",
      tone: "normal",
      value: formatBrlAmount(sale.totals.subtotal),
    },
    ...adjustments,
    {
      key: "total-due",
      label: "Total devido",
      tone: "total",
      value: formatBrlAmount(sale.totals.totalDue),
    },
  ];
}

function paymentFeeDetails(
  payment: ConfirmedSaleReadModel["payment"]
): ConfirmedSaleDetail[] {
  const processing = describeFee(payment.processingFee);
  const anticipation = describeFee(payment.anticipationFee);
  const profile =
    payment.paymentProfileName === null
      ? "Sem perfil de pagamento"
      : payment.paymentProfileName;
  const rule =
    payment.paymentProfileRuleId === null
      ? "Nenhuma regra exata aplicada"
      : `Regra exata: ${describeRule(payment.method, payment.installments, payment.installmentPlan)}`;
  return [
    { label: "Perfil de pagamento", tone: "plain", value: profile },
    { label: "Regra", tone: "plain", value: rule },
    {
      label: "Taxa de processamento",
      tone: processing.tone,
      value: processing.text,
    },
    {
      label: "Taxa de antecipação",
      tone: anticipation.tone,
      value: anticipation.text,
    },
    {
      label: "Prazo",
      tone: payment.expectedSettlementDays === null ? "unknown" : "plain",
      value: describeSettlementDays(payment.expectedSettlementDays),
    },
  ];
}

function confirmedPaymentDetails(
  sale: ConfirmedSaleReadModel
): ConfirmedSaleDetail[] {
  const { payment } = sale;
  return [
    {
      label: "Método",
      tone: "plain",
      value: describeRule(
        payment.method,
        payment.installments,
        payment.installmentPlan
      ),
    },
    {
      label: "Valor do pagamento",
      tone: "known",
      value: formatBrlAmount(payment.amount),
    },
    ...paymentFeeDetails(payment),
  ];
}

/**
 * One part of a sale paid in more than one: the method in full and the amount of the part, the installments under
 * them, and the profile, rule, fees and settlement estimate of that part. The installment value is not written: the
 * sale stores the number of installments and the amount, not what each installment is.
 */
interface ConfirmedPaymentPartView {
  amountText: string;
  details: ConfirmedSaleDetail[];
  /** "3x · Parcelado pelo lojista" for a card with installments; null otherwise. */
  installmentText: string | null;
  methodText: string;
  position: number;
}

function installmentTextOf(
  payment: ConfirmedSaleReadModel["payment"]
): string | null {
  const parts = [
    payment.installments === null ? null : `${payment.installments}x`,
    payment.installmentPlan === null
      ? null
      : (planLabels[payment.installmentPlan] ?? payment.installmentPlan),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** One entry per part, in the order the server sends them (by position), only when the sale has more than one: a sale of one part keeps the plain block. */
function paymentPartsField(
  sale: ConfirmedSaleReadModel
): { paymentParts: ConfirmedPaymentPartView[] } | Record<string, never> {
  const parts = sale.payments ?? [];
  if (parts.length < 2) {
    return {};
  }
  const views = parts.map((part) => ({
    amountText: formatBrlAmount(part.amount),
    details: paymentFeeDetails(part),
    installmentText: installmentTextOf(part),
    methodText: methodLabels.get(part.method) ?? part.method,
    position: part.position,
  }));
  return { paymentParts: views };
}

const timeFormatter = new Intl.DateTimeFormat("pt-BR", { timeStyle: "short" });
export function localDay(instant: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The three separate dates of a confirmed sale: the commercial date (the
 * organization's calendar day, plus the local time of the instant), the
 * device's recording evidence, and the server's confirmation, which is the
 * authority. A commercial date before the confirmation day is marked.
 */
export function saleDateDetails(sale: {
  confirmedAt: string;
  occurredAt: string;
  occurredOn: string;
  recordedAt: string | null;
}): ConfirmedSaleDetail[] {
  const time = new Date(sale.occurredAt);
  const timeText = Number.isNaN(time.getTime())
    ? ""
    : ` · ${timeFormatter.format(time)} (horário deste dispositivo)`;
  const rows: ConfirmedSaleDetail[] = [
    {
      label: "Data da venda",
      tone: "plain",
      value: `${formatCalendarDate(sale.occurredOn)}${timeText}`,
    },
  ];
  if (sale.recordedAt !== null) {
    rows.push({
      label: "Registrada no dispositivo",
      tone: "plain",
      value: formatInstant(sale.recordedAt),
    });
  }
  rows.push({
    label: "Confirmada no servidor",
    tone: "plain",
    value: formatInstant(sale.confirmedAt),
  });
  const confirmedDay = localDay(sale.confirmedAt);
  if (confirmedDay !== "" && sale.occurredOn < confirmedDay) {
    rows.push({
      label: "Venda retroativa",
      tone: "plain",
      value: "A data da venda é anterior ao dia da confirmação no servidor.",
    });
  }
  return rows;
}

/** Display model of the confirmed sale exactly as the server returned it. */
export function confirmedSaleView(
  sale: ConfirmedSaleReadModel
): ConfirmedSaleView {
  return {
    headline: sale.replayed
      ? "Esta venda já estava confirmada. Nada foi duplicado."
      : "Venda confirmada.",
    items: confirmedItems(sale),
    note: "O método de pagamento registrado não comprova liquidação, e taxas e prazo são estimativas do perfil escolhido.",
    paymentDetails: confirmedPaymentDetails(sale),
    ...paymentPartsField(sale),
    replayed: sale.replayed,
    saleDetails: [
      { label: "Venda", tone: "plain", value: sale.sale.id },
      ...saleDateDetails(sale.sale),
    ],
    saleId: sale.sale.id,
    summary: confirmedSummary(sale),
    totals: confirmedTotals(sale),
  };
}

export type SubmissionState =
  | { phase: "idle" }
  | { phase: "submitting" }
  /** A definite failure: the server did not register the sale; editing stays allowed. */
  | { failure: SaleSubmitFailure; phase: "failed" }
  /** The outcome is unknown: the form is locked on this attempt. */
  | {
      confirmingDiscard: boolean;
      failure: SaleSubmitFailure;
      phase: "locked";
    }
  | { phase: "confirmed"; sale: ConfirmedSaleView }
  /** Without a connection: the sale is kept on this device until the server confirms it. */
  | { phase: "queued"; sale: QueuedSaleView };

/** What the person sees after a sale was queued on the device. */
export interface QueuedSaleView {
  commandId: string;
  /** Lines the device's copy of the stock does not seem to cover. */
  stockWarnings: string[];
  /** The total the customer owes, in reais, as the server will compute it. */
  totalDue: string;
}

/**
 * A sale whose outcome on the server is unknown can be kept on the device as the
 * SAME sale (same command ID, same payload), which the server then recognizes
 * instead of recording twice, only when the device command can carry exactly
 * what was sent: the offline command carries the payment profile (by id and
 * version) and each part of a split payment, in order, with its amount and
 * profile, but not a typed date, and records one instant for both times. The
 * caller queues the body only if it resolves to the locked attempt itself (its
 * signature covers the parts), so nothing of the sent body is recomputed.
 */
export function canKeepLockedSaleOnDevice(
  state: SubmissionState,
  attempt: SaleAttempt | null,
  evaluation: SaleEvaluation
): boolean {
  return (
    state.phase === "locked" &&
    attempt !== null &&
    evaluation.body !== null &&
    evaluation.occurredAtOverride === null &&
    attempt.occurredAt === attempt.recordedAt
  );
}

/**
 * Whether the sale screen works from the device. It follows the connection, but
 * is FROZEN while a sale is in flight or its outcome is unknown: the connection
 * dropping during the request must not swap the catalog, the profiles or the form
 * under a sale that may already be on the server.
 */
export function saleModeIsOffline(
  previous: boolean,
  connectionIsDown: boolean,
  state: SubmissionState
): boolean {
  return state.phase === "submitting" || state.phase === "locked"
    ? previous
    : connectionIsDown;
}

export function queuedSubmission(sale: QueuedSaleView): SubmissionState {
  return { phase: "queued", sale };
}

/**
 * The form while the sale will be queued on the device: the sale is dated now, so
 * a typed date is dropped. The payment profile stays the person's choice (the
 * profiles of the last connection are offered, ADR 0049). The typed date is part of the body the command ID was made
 * for, so it stays while the outcome of an attempt is unknown.
 */
export function formForOfflineSale(
  form: SaleFormState,
  outcomeUnknown = false
): SaleFormState {
  return outcomeUnknown ? form : { ...form, occurredAtLocal: "" };
}

export const idleSubmission: SubmissionState = { phase: "idle" };

export function isSubmitting(state: SubmissionState): boolean {
  return state.phase === "submitting";
}

/** True while the sale cannot be edited: in flight, or an unknown outcome. */
export function isFormLocked(state: SubmissionState): boolean {
  return state.phase === "submitting" || state.phase === "locked";
}

/** Applies a user edit unless the sale is locked; locked edits are rejected. */
export function editSaleForm(
  state: SubmissionState,
  form: SaleFormState,
  edit: (current: SaleFormState) => SaleFormState
): SaleFormState {
  return isFormLocked(state) ? form : edit(form);
}

/**
 * A sale can start only when the form is valid and no request is in flight. A
 * locked sale can only be resent unchanged, which is exactly what its form is.
 */
export function canStartSubmission(
  state: SubmissionState,
  evaluation: SaleEvaluation
): boolean {
  return !isSubmitting(state) && evaluation.body !== null;
}

export function startSubmission(state: SubmissionState): SubmissionState {
  return isSubmitting(state) ? state : { phase: "submitting" };
}

/** Definite failures unlock editing; an unknown outcome locks the sale. */
export function failSubmission(
  error: unknown,
  sentAdjustments: SaleCommandBody["adjustments"]
): SubmissionState {
  const mapped = mapSaleSubmitError(error, sentAdjustments);
  return mapped.unknownOutcome
    ? { confirmingDiscard: false, failure: mapped, phase: "locked" }
    : { failure: mapped, phase: "failed" };
}

const MAX_LISTED_SHORTAGES = 3;

interface StockShortage {
  balance: number;
  label: string;
  requested: number;
  variantId: string;
}

function stockShortages(
  items: readonly { quantity: number; variantId: string }[],
  labels: ReadonlyMap<string, string>,
  stock: EvaluationContext["stock"]
): StockShortage[] {
  const requested = requestedByVariant(items);
  const shortages: StockShortage[] = [];
  for (const [variantId, total] of requested) {
    const balance = stock[variantId];
    if (balance?.status !== "ready") {
      // a line whose balance the screen never read may be the one refused: no line is named then
      return [];
    }
    if (shortBy(total, balance.value.quantity) !== undefined) {
      shortages.push({
        balance: balance.value.quantity,
        label: labels.get(variantId) ?? "item sem nome",
        requested: total,
        variantId,
      });
    }
  }
  return shortages;
}

function listWithAnd(parts: readonly string[]): string {
  if (parts.length <= 1) {
    return parts.join("");
  }
  return `${parts.slice(0, -1).join(", ")} e ${parts.at(-1)}`;
}

function listShortages(parts: readonly string[]): string {
  return parts.length > MAX_LISTED_SHORTAGES
    ? `${parts.slice(0, MAX_LISTED_SHORTAGES).join(", ")} e mais ${parts.length - MAX_LISTED_SHORTAGES}`
    : listWithAnd(parts);
}

function stockRefusalNotice(
  shortages: readonly StockShortage[],
  canAdjustStock: boolean
): Pick<SaleSubmitFailure, "entry" | "message"> {
  const [first] = shortages;
  if (first === undefined) {
    return { entry: null, message: stockRefusalFallbackMessage };
  }
  const prefix = "A venda não foi registrada:";
  const detailed = shortages.map(
    (shortage) =>
      `${shortage.label} (pediu ${shortage.requested}, saldo ${shortage.balance})`
  );
  const names = shortages.map((shortage) => shortage.label);
  const only = shortages.length === 1;
  let message: string;
  if (canAdjustStock) {
    message = only
      ? `${prefix} falta estoque de ${detailed[0]}.`
      : `${prefix} faltam ${shortages.length} itens no estoque. ${listShortages(detailed)}.`;
  } else {
    message = only
      ? `${prefix} falta estoque de ${first.label}. ${askForEntryText}`
      : `${prefix} faltam ${shortages.length} itens no estoque. ${listShortages(names)}. ${askForEntryText}`;
  }
  return {
    entry: canAdjustStock
      ? {
          label: first.label,
          missing: first.requested - first.balance,
          variantId: first.variantId,
        }
      : null,
    message,
  };
}

interface SentStock {
  canAdjustStock: boolean;
  items: readonly { quantity: number; variantId: string }[];
  labels: ReadonlyMap<string, string>;
  stock: EvaluationContext["stock"];
}

/**
 * The server does not say which line lacks stock: the refusal names the lines whose request is above the balance the
 * screen holds, and says so plainly when none can be pointed at.
 */
export function describeStockRefusal(
  state: SubmissionState,
  sent: SentStock
): SubmissionState {
  if (
    state.phase !== "failed" ||
    state.failure.reason !== "insufficient_stock"
  ) {
    return state;
  }
  const notice = stockRefusalNotice(
    stockShortages(sent.items, sent.labels, sent.stock),
    sent.canAdjustStock
  );
  return { ...state, failure: { ...state.failure, ...notice } };
}

/**
 * A refusal that names a payment part, for a sale sent in parts: the message starts with the part ("Parte 2: …"), so
 * the person knows which profile to review. A sale paid in one go keeps the message of always.
 */
export function describePartRefusal(
  state: SubmissionState,
  partsSent: number
): SubmissionState {
  if (
    state.phase !== "failed" ||
    state.failure.part === undefined ||
    partsSent < 2 ||
    state.failure.part >= partsSent
  ) {
    return state;
  }
  return {
    ...state,
    failure: {
      ...state.failure,
      message: `Parte ${state.failure.part + 1}: ${state.failure.message}`,
    },
  };
}

/** The final domain validation rejected the form before any request. */
export function rejectSubmission(message: string): SubmissionState {
  return {
    failure: {
      discardAttempt: false,
      entry: null,
      kind: "bad_request",
      message,
      reason: null,
      refreshData: false,
      unknownOutcome: false,
    },
    phase: "failed",
  };
}

/** First step of discarding a locked sale: only asks for confirmation. */
export function requestDiscard(state: SubmissionState): SubmissionState {
  return state.phase === "locked"
    ? { ...state, confirmingDiscard: true }
    : state;
}

export function cancelDiscard(state: SubmissionState): SubmissionState {
  return state.phase === "locked"
    ? { ...state, confirmingDiscard: false }
    : state;
}

export interface DiscardedSale {
  /** The attempt (command ID and instant) is forgotten: the next sale gets new ones. */
  attempt: null;
  form: SaleFormState;
  submission: SubmissionState;
}

/**
 * Second step: discards the locked sale and starts a blank one. Returns null
 * unless the operator already saw and accepted the confirmation step.
 */
export function discardLockedSale(
  state: SubmissionState,
  createId: () => string
): DiscardedSale | null {
  if (state.phase !== "locked" || !state.confirmingDiscard) {
    return null;
  }
  return {
    attempt: null,
    form: createBlankSaleForm(createId),
    submission: idleSubmission,
  };
}

/**
 * The attempt to keep after a failure: an attempt the server cannot accept
 * again as is (same ID with other content, or a future instant) is dropped so
 * the next confirm creates a fresh one.
 */
export function attemptAfterFailure(
  state: SubmissionState,
  attempt: SaleAttempt
): SaleAttempt | null {
  const dropped =
    (state.phase === "failed" || state.phase === "locked") &&
    state.failure.discardAttempt;
  return dropped ? null : attempt;
}

export function confirmSubmission(
  sale: ConfirmedSaleReadModel
): SubmissionState {
  return { phase: "confirmed", sale: confirmedSaleView(sale) };
}

export function submitButtonLabel(
  state: SubmissionState,
  offline = false
): string {
  if (isSubmitting(state)) {
    return offline ? "Guardando venda…" : "Confirmando venda…";
  }
  if (offline) {
    return "Guardar venda neste aparelho";
  }
  return state.phase === "locked"
    ? "Tentar novamente (seguro)"
    : "Confirmar venda";
}
