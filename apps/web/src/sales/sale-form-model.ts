import type {
  ConfirmedSaleReadModel,
  InventoryBalanceReadModel,
  PaymentProfileReadModel,
  PolarisRpcClient,
  ProductReadModel,
  ProductVariantConfigurationReadModel,
} from "@polaris/contracts";
import { Money } from "@polaris/domain/money/money";
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
  formatCalendarDate,
  formatInstant,
} from "../lib/format";
import { rpcErrorCode, rpcErrorReason } from "../lib/rpc-error";

/* -------------------------------------------------------------------------- */
/* Types and constants                                                        */
/* -------------------------------------------------------------------------- */

export type SaleMethod = ConfirmedSaleReadModel["payment"]["method"];
export type InstallmentPlan = "merchant" | "issuer";
export type AdjustmentKind =
  ConfirmedSaleReadModel["adjustments"][number]["kind"];
type AdjustmentValueType = "fixed" | "percentage";
type ConfirmSaleRequest = Parameters<PolarisRpcClient["sale"]["confirm"]>[0];
export type SaleCommandBody = Omit<
  ConfirmSaleRequest,
  "recordedAt" | "commandId" | "occurredAt" | "organizationId"
>;

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

export const INSTALLMENT_PLANS: ReadonlyArray<
  readonly [InstallmentPlan, string]
> = [
  ["merchant", "Parcelado pelo lojista"],
  ["issuer", "Parcelado pelo emissor"],
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
const planLabels = new Map<string, string>(INSTALLMENT_PLANS);
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

interface ProfileSelectionDraft {
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
  };
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

/** Switching away from credit card drops every card-only choice. */
export function selectPaymentMethod(
  form: SaleFormState,
  method: SaleMethod | ""
): SaleFormState {
  if (method === "credit_card") {
    return { ...form, payment: { ...form.payment, method } };
  }
  return {
    ...form,
    payment: {
      anticipationRequested: false,
      installmentPlan: "",
      installments: "",
      method,
    },
  };
}

export function updatePayment(
  form: SaleFormState,
  changes: Partial<Omit<PaymentDraft, "method">>
): SaleFormState {
  return { ...form, payment: { ...form.payment, ...changes } };
}

export function selectProfileChoice(
  form: SaleFormState,
  choice: string,
  profiles: readonly PaymentProfileReadModel[]
): SaleFormState {
  const profile = profiles.find((candidate) => candidate.id === choice);
  return {
    ...form,
    profile: {
      choice,
      reviewNotice: null,
      seenVersion: profile?.version ?? null,
    },
  };
}

/**
 * Reconciles the chosen profile with a fresh list of active profiles. A profile
 * that changed (or disappeared) forces the operator to review the fee preview
 * again before the sale can be confirmed.
 */
export function reconcileProfileReload(
  form: SaleFormState,
  profiles: readonly PaymentProfileReadModel[]
): SaleFormState {
  const { choice, seenVersion } = form.profile;
  if (choice === "" || choice === NO_PROFILE_CHOICE) {
    return form;
  }
  const profile = profiles.find((candidate) => candidate.id === choice);
  if (!profile) {
    return {
      ...form,
      profile: {
        choice: "",
        reviewNotice:
          "O perfil de pagamento escolhido não está mais ativo. Escolha outro perfil ou “Sem perfil” para continuar.",
        seenVersion: null,
      },
    };
  }
  if (seenVersion === null || profile.version === seenVersion) {
    return form;
  }
  return {
    ...form,
    profile: {
      choice,
      reviewNotice: `O perfil “${profile.name}” mudou da versão ${seenVersion} para a versão ${profile.version}. Revise a prévia de taxas e prazo abaixo e confirme a revisão para continuar.`,
      seenVersion,
    },
  };
}

export function acknowledgeProfileReview(
  form: SaleFormState,
  profiles: readonly PaymentProfileReadModel[]
): SaleFormState {
  const profile = profiles.find(
    (candidate) => candidate.id === form.profile.choice
  );
  return {
    ...form,
    profile: {
      ...form.profile,
      reviewNotice: null,
      seenVersion: profile?.version ?? form.profile.seenVersion,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Catalog loading views                                                      */
/* -------------------------------------------------------------------------- */

export interface ChoiceOption {
  id: string;
  label: string;
}

export type CatalogView =
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "ready"; options: ChoiceOption[] };

/** Message for a failed read of products, profiles, variants or stock. */
export function loadErrorMessage(error: unknown, subject: string): string {
  const code = rpcErrorCode(error);
  if (code === "UNAUTHORIZED") {
    return "Sua sessão não está ativa. Entre novamente para continuar.";
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso a esta organização ou ação.";
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
      kind: "empty",
      message:
        "Nenhum produto ativo. Cadastre um produto no catálogo e dê entrada no estoque para vender.",
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
      label: `${profile.name} (versão ${profile.version})`,
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
  quantity: number | null;
  text: string;
  tone: "neutral" | "ok" | "warning";
}

/** Current balance and moving average cost for a chosen variant. */
export function stockView(
  load: Loadable<InventoryBalanceReadModel> | undefined
): StockView | null {
  if (load === undefined) {
    return null;
  }
  if (load.status === "loading") {
    return {
      costText: null,
      quantity: null,
      text: "Consultando estoque…",
      tone: "neutral",
    };
  }
  if (load.status === "error") {
    return {
      costText: null,
      quantity: null,
      text: `${load.message} Você ainda pode vender; o servidor confirma o saldo.`,
      tone: "warning",
    };
  }
  const { movingAverageCost, quantity } = load.value;
  const costText =
    movingAverageCost === null
      ? "Custo desconhecido — margem indeterminada."
      : `Custo médio: ${formatBrlAmount(movingAverageCost)}.`;
  if (quantity === 0) {
    return {
      costText,
      quantity,
      text: "Sem estoque: saldo 0. O servidor recusa a venda se o saldo continuar insuficiente.",
      tone: "warning",
    };
  }
  return {
    costText,
    quantity,
    text: `Saldo atual: ${quantity} ${quantity === 1 ? "unidade" : "unidades"}.`,
    tone: "ok",
  };
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
export function describeFee(fee: SalePaymentFeeSnapshot): FeeLine {
  if (fee.mode === "not_applicable") {
    return {
      text: "não aplicável (custo estimado R$ 0,00)",
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
      : `${formatPercentage(fee.percentage)} do total devido`,
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
  return `prazo estimado de ${days} ${days === 1 ? "dia" : "dias"} — estimativa, não data de liquidação`;
}

export interface FeePreview {
  anticipation: FeeLine;
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
    parts.push(planLabels.get(plan) ?? plan);
  }
  return parts.join(" · ");
}

type ProfileSelection =
  | { kind: "none" }
  | { kind: "profile"; profile: PaymentProfileReadModel };

function buildFeePreview(
  totalDue: string,
  payment: SaleCommandBody["payment"],
  selection: ProfileSelection
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
      anticipation: describeFee(snapshot.anticipationFee),
      processing: describeFee(snapshot.processingFee),
      profileText: profile
        ? `${profile.name} (versão ${profile.version})`
        : "Sem perfil de pagamento",
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
  "Deixe vazio para usar agora. Vendas retroativas são aceitas por até 30 dias (data do calendário da organização); datas futuras não são aceitas.";

const localDateTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

type LocalDateTimeParse =
  | { kind: "empty" }
  | { kind: "invalid" }
  | { date: Date; kind: "ok" };

/**
 * Reads a `datetime-local` value as a moment in the device time zone. A date
 * that does not exist (31/02) is invalid rather than rolled over.
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
  const issue = moneyIssue(parse, "Informe o preço em BRL.");
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

function parsePayment(
  draft: PaymentDraft,
  issues: Issue[]
): SaleCommandBody["payment"] | null {
  if (draft.method === "") {
    pushIssue(
      issues,
      formFieldKeys.method,
      "Escolha o método de pagamento.",
      true
    );
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
      formFieldKeys.installments,
      installments.kind === "empty"
        ? "Informe o número de parcelas."
        : "Use um número inteiro de 1 a 2.147.483.647.",
      installments.kind === "empty"
    );
  }
  if (draft.installmentPlan === "") {
    pushIssue(
      issues,
      formFieldKeys.installmentPlan,
      "Escolha a modalidade do parcelamento.",
      true
    );
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
  issues: Issue[]
): ProfileResolution {
  if (selection.choice === "") {
    pushIssue(
      issues,
      formFieldKeys.profile,
      "Escolha um perfil de pagamento ou “Sem perfil”.",
      true
    );
    return { kind: "blocked" };
  }
  if (selection.choice === NO_PROFILE_CHOICE) {
    return { kind: "none" };
  }
  const profile = profiles.find(
    (candidate) => candidate.id === selection.choice
  );
  if (!profile) {
    pushIssue(
      issues,
      formFieldKeys.profile,
      "O perfil escolhido não está na lista de perfis ativos. Escolha novamente.",
      false
    );
    return { kind: "blocked" };
  }
  if (selection.reviewNotice !== null) {
    pushIssue(
      issues,
      formFieldKeys.profile,
      "Confirme a revisão da prévia do perfil atualizado antes de continuar.",
      false
    );
    return { kind: "blocked" };
  }
  return { kind: "profile", profile };
}

function calculationIssue(error: unknown): Issue {
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
      message:
        "Revise os ajustes: os valores devem ser positivos e percentual só vale para desconto e acréscimo.",
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
    issues.push(calculationIssue(error));
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
  const requested = new Map<string, number>();
  for (const item of items) {
    requested.set(
      item.variantId,
      (requested.get(item.variantId) ?? 0) + item.quantity
    );
  }
  const warnings: Record<string, string> = {};
  for (const item of items) {
    const balance = stock[item.variantId];
    const total = requested.get(item.variantId) ?? 0;
    if (balance?.status === "ready" && total > balance.value.quantity) {
      warnings[item.draftId] =
        `Quantidade acima do saldo exibido (${balance.value.quantity}). Você pode continuar; o servidor confirma o estoque e recusa a venda se for insuficiente.`;
    }
  }
  return warnings;
}

export interface EvaluationContext {
  profiles: readonly PaymentProfileReadModel[];
  stock: Readonly<Record<string, Loadable<InventoryBalanceReadModel>>>;
}

export interface SaleEvaluation {
  /** Command body, present only when the whole form is valid. */
  body: SaleCommandBody | null;
  /** Text for the summary: the chosen date, or that it will be now. */
  dateText: string;
  /** Visible field errors keyed by field. Required-but-empty only after submit. */
  errors: Record<string, string>;
  feePreview: FeePreview | null;
  /** Every problem, including fields that are just not filled in yet. */
  issueCount: number;
  methodText: string;
  /** ISO instant chosen by the operator; null means now at attempt creation. */
  occurredAtOverride: string | null;
  profileText: string;
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
      ? "modalidade não escolhida"
      : (planLabels.get(payment.installmentPlan) ?? payment.installmentPlan);
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
    return `${resolution.profile.name} (versão ${resolution.profile.version})`;
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

function buildBody(
  items: readonly ParsedItem[],
  adjustments: SaleCommandBody["adjustments"],
  payment: SaleCommandBody["payment"],
  resolution: ProfileResolution
): SaleCommandBody | null {
  if (resolution.kind === "blocked") {
    return null;
  }
  return {
    adjustments,
    commandVersion: CONFIRM_SALE_COMMAND_VERSION,
    items: items.map((item) => ({
      chargedUnitPrice: item.chargedUnitPrice,
      listedUnitPrice: item.listedUnitPrice,
      quantity: item.quantity,
      variantId: item.variantId,
    })),
    payment,
    paymentProfile:
      resolution.kind === "profile"
        ? {
            expectedVersion: resolution.profile.version,
            id: resolution.profile.id,
          }
        : null,
  };
}

/**
 * Validates the whole form, computes the exact totals with the domain
 * calculation, previews the payment fees and builds the command body. Nothing
 * here touches the network.
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
  const payment = parsePayment(form.payment, issues);
  const resolution = resolveProfile(form.profile, context.profiles, issues);
  const calculation =
    items && adjustments ? calculateTotals(items, adjustments, issues) : null;
  const summary =
    items && calculation ? buildSummary(items, calculation) : null;
  const feePreview =
    calculation && payment && resolution.kind !== "blocked"
      ? buildFeePreview(calculation.totalDue, payment, resolution)
      : null;
  const body =
    issues.length === 0 && items && adjustments && payment
      ? buildBody(items, adjustments, payment, resolution)
      : null;
  return {
    body,
    dateText:
      date.occurredAt === null
        ? "Agora, ao confirmar"
        : formatInstant(date.occurredAt),
    errors: visibleErrors(issues, options.showRequired),
    feePreview,
    issueCount: issues.length,
    methodText: methodSummary(form.payment),
    occurredAtOverride: date.occurredAt,
    profileText: profileSummary(form.profile, resolution),
    stockWarnings: items ? stockWarnings(items, context.stock) : {},
    summary,
  };
}

/* -------------------------------------------------------------------------- */
/* Idempotency: one attempt keeps one command ID and one instant              */
/* -------------------------------------------------------------------------- */

export interface SaleAttempt {
  commandId: string;
  occurredAt: string;
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
 * change to the payload (including a new profile version) starts a new attempt.
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
    recordedAt: now.toISOString(),
    signature,
  };
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
  const attempt = resolveSaleAttempt(
    input.previousAttempt,
    input.body,
    input.organizationId,
    input.createId,
    input.now,
    override
  );
  const command = {
    ...input.body,
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
  kind: SaleFailureKind;
  message: string;
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
  "Uma das variantes não existe mais nesta organização. Remova a linha, atualize os dados e revise a venda.";

const reasonOutcomes = new Map<string, ReasonOutcome>([
  [
    "insufficient_stock",
    {
      message:
        "Estoque insuficiente para uma ou mais linhas. Atualize o saldo e ajuste as quantidades.",
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
        "Um dos produtos não existe mais nesta organização. Remova a linha, atualize os dados e revise a venda.",
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
        "O pagamento informado é inválido. Revise método, parcelas e modalidade do parcelamento.",
    },
  ],
  [
    "invalid_sale_adjustment",
    {
      message:
        "Revise os ajustes: os valores devem ser positivos e percentual só vale para desconto e acréscimo.",
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

const serverErrorCodes = new Set([
  "BAD_GATEWAY",
  "GATEWAY_TIMEOUT",
  "INTERNAL_SERVER_ERROR",
  "SERVICE_UNAVAILABLE",
  "TIMEOUT",
]);

const lockHint =
  "A venda foi bloqueada para edição. Use “Tentar novamente (seguro)”: o mesmo pedido é reenviado e o servidor não duplica a venda se ela já tiver sido registrada.";

function failure(
  kind: SaleFailureKind,
  message: string,
  options: {
    discardAttempt?: boolean;
    reason?: string | null;
    refreshData?: boolean;
  } = {}
): SaleSubmitFailure {
  return {
    discardAttempt: options.discardAttempt ?? false,
    kind,
    message,
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
      return failure(
        "unauthorized",
        "Sua sessão não está ativa. Entre novamente e confirme a venda; os dados continuam no formulário."
      );
    case "FORBIDDEN":
      return failure(
        "forbidden",
        "Sua conta não tem permissão para registrar vendas nesta organização."
      );
    case "BAD_REQUEST":
      return failure(
        "bad_request",
        "O servidor recusou os dados da venda. Revise itens, preços, ajustes e pagamento."
      );
    case "NOT_FOUND":
      return failure(
        "not_found",
        "Um produto, uma variante ou o perfil de pagamento desta venda não existe mais nesta organização. Atualize os dados e revise a venda.",
        { refreshData: true }
      );
    case "CONFLICT":
      return failure(
        "conflict",
        "Estoque insuficiente, produto indisponível ou o perfil de pagamento foi alterado. Atualize os dados e revise a venda.",
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

/**
 * Maps an oRPC error to a message and to what the page should do next. A known
 * `data.reason` on a 400/404/409 refines the generic per-code message.
 */
export function mapSaleSubmitError(error: unknown): SaleSubmitFailure {
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
    return failure(byCode.kind, outcome.message, {
      discardAttempt: outcome.discardAttempt ?? false,
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
  if (code !== undefined && serverErrorCodes.has(code)) {
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
  costText: string;
  detail: string;
  key: string;
  label: string;
}

export interface ConfirmedSaleView {
  headline: string;
  items: ConfirmedSaleItemView[];
  note: string;
  paymentDetails: ConfirmedSaleDetail[];
  replayed: boolean;
  saleDetails: ConfirmedSaleDetail[];
  saleId: string;
  totals: SummaryRow[];
}

function confirmedItems(sale: ConfirmedSaleReadModel): ConfirmedSaleItemView[] {
  return sale.items.map((item) => ({
    costText:
      item.unitCost === null
        ? "Custo desconhecido — margem indeterminada."
        : `Custo unitário registrado: ${formatBrlAmount(item.unitCost)}.`,
    detail: `${item.quantity} × ${formatBrlAmount(item.chargedUnitPrice)} (tabela ${formatBrlAmount(item.listedUnitPrice)}) = ${formatBrlAmount(
      Money.from(item.chargedUnitPrice)
        .multiplyByQuantity(item.quantity)
        .toString()
    )}`,
    key: `${item.position}-${item.variantId}`,
    label: item.productLabel,
  }));
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

function confirmedPaymentDetails(
  sale: ConfirmedSaleReadModel
): ConfirmedSaleDetail[] {
  const { payment } = sale;
  const processing = describeFee(payment.processingFee);
  const anticipation = describeFee(payment.anticipationFee);
  const profile =
    payment.paymentProfileName === null
      ? "Sem perfil de pagamento"
      : `${payment.paymentProfileName} (versão ${payment.paymentProfileVersion ?? "?"})`;
  const rule =
    payment.paymentProfileRuleId === null
      ? "Nenhuma regra exata aplicada"
      : `Regra exata: ${describeRule(payment.method, payment.installments, payment.installmentPlan)}`;
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
      tone: "plain",
      value: formatBrlAmount(payment.amount),
    },
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
    replayed: sale.replayed,
    saleDetails: [
      { label: "Venda", tone: "plain", value: sale.sale.id },
      ...saleDateDetails(sale.sale),
    ],
    saleId: sale.sale.id,
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

export function queuedSubmission(sale: QueuedSaleView): SubmissionState {
  return { phase: "queued", sale };
}

/**
 * The form while the sale will be queued on the device: no payment profile
 * exists offline (the server resolves fees and term when it confirms), and the
 * sale is dated now, so a typed date is dropped.
 */
export function formForOfflineSale(form: SaleFormState): SaleFormState {
  return {
    ...form,
    occurredAtLocal: "",
    profile: {
      choice: NO_PROFILE_CHOICE,
      reviewNotice: null,
      seenVersion: null,
    },
  };
}

/** Back online: the "no profile" choice the offline form made for the person is undone. */
export function formForOnlineSale(form: SaleFormState): SaleFormState {
  return form.profile.choice === NO_PROFILE_CHOICE
    ? {
        ...form,
        profile: { choice: "", reviewNotice: null, seenVersion: null },
      }
    : form;
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
export function failSubmission(error: unknown): SubmissionState {
  const mapped = mapSaleSubmitError(error);
  return mapped.unknownOutcome
    ? { confirmingDiscard: false, failure: mapped, phase: "locked" }
    : { failure: mapped, phase: "failed" };
}

/** The final domain validation rejected the form before any request. */
export function rejectSubmission(message: string): SubmissionState {
  return {
    failure: {
      discardAttempt: false,
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
