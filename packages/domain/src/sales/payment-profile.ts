import { DecimalAmount, Money, Percentage } from "../money/money";

export const PAYMENT_FEE_MODES = [
  "unknown",
  "none",
  "fixed",
  "percentage",
  "fixed_and_percentage",
] as const;

export type PaymentFeeMode = (typeof PAYMENT_FEE_MODES)[number];

export type CardInstallmentPlan = "merchant" | "issuer";

export interface PaymentFeeConfigurationInput {
  fixedAmount?: string | null;
  mode: PaymentFeeMode;
  percentage?: string | null;
}

export interface NormalizedPaymentFeeConfiguration {
  fixedAmount: string | null;
  mode: PaymentFeeMode;
  percentage: string | null;
}

export interface PaymentProfileRuleInput {
  anticipationFee: PaymentFeeConfigurationInput;
  expectedSettlementDays?: number | null;
  installmentPlan?: CardInstallmentPlan | null;
  installments?: number | null;
  method: string;
  processingFee: PaymentFeeConfigurationInput;
}

export interface NormalizedPaymentProfileRule {
  anticipationFee: NormalizedPaymentFeeConfiguration;
  expectedSettlementDays: number | null;
  installmentPlan: CardInstallmentPlan | null;
  installments: number | null;
  method: string;
  processingFee: NormalizedPaymentFeeConfiguration;
}

export interface PaymentProfileInput {
  name: string;
  rules: readonly PaymentProfileRuleInput[];
}

export interface NormalizedPaymentProfile {
  name: string;
  rules: NormalizedPaymentProfileRule[];
}

export interface PaymentFeeCalculation {
  amount: string | null;
  configuration: NormalizedPaymentFeeConfiguration;
}

export type SalePaymentFeeMode = PaymentFeeMode | "not_applicable";

export interface SalePaymentFeeSnapshot {
  amount: string | null;
  fixedAmount: string | null;
  mode: SalePaymentFeeMode;
  percentage: string | null;
}

export interface SalePaymentProfileSnapshot {
  anticipationFee: SalePaymentFeeSnapshot;
  expectedSettlementDays: number | null;
  paymentProfileId: string | null;
  paymentProfileName: string | null;
  paymentProfileRuleId: string | null;
  paymentProfileVersion: number | null;
  processingFee: SalePaymentFeeSnapshot;
}

export interface PaymentProfileForSale {
  id: string;
  name: string;
  rules: ReadonlyArray<NormalizedPaymentProfileRule & { id: string }>;
  version: number;
}

export interface PaymentContextForSale {
  anticipationRequested: boolean;
  installmentPlan: CardInstallmentPlan | null;
  installments: number | null;
  method: string;
}

export class InvalidPaymentProfileError extends Error {
  readonly code = "invalid_payment_profile";

  constructor(options?: ErrorOptions) {
    super("invalid_payment_profile", options);
    this.name = "InvalidPaymentProfileError";
  }
}

export class PaymentProfileVersionConflictError extends Error {
  readonly code = "payment_profile_version_conflict";

  constructor() {
    super("payment_profile_version_conflict");
    this.name = "PaymentProfileVersionConflictError";
  }
}

export class PaymentProfileNotFoundError extends Error {
  readonly code = "payment_profile_not_found";

  constructor() {
    super("payment_profile_not_found");
    this.name = "PaymentProfileNotFoundError";
  }
}

export class PaymentProfileLifecycleError extends Error {
  readonly code = "payment_profile_lifecycle_conflict";

  constructor() {
    super("payment_profile_lifecycle_conflict");
    this.name = "PaymentProfileLifecycleError";
  }
}

type PaymentFeeParser = (value: string) => { toString: () => string };
const maxPostgresInteger = 2_147_483_647;
const paymentMethods = new Set([
  "pix",
  "cash",
  "credit_card",
  "debit_card",
  "bank_transfer",
  "other",
]);

function parseFeeAmount(value: string): Money {
  try {
    const amount = Money.from(value);
    if (amount.minorUnits < 0n) {
      throw new InvalidPaymentProfileError();
    }
    return amount;
  } catch (cause) {
    // The domain error constructor forwards this value to ErrorOptions.cause.
    // biome-ignore lint/style/useErrorCause: Biome cannot follow the custom error constructor.
    throw new InvalidPaymentProfileError({ cause });
  }
}

function parseFeePercentage(value: string): Percentage {
  try {
    return Percentage.from(value);
  } catch (cause) {
    // The domain error constructor forwards this value to ErrorOptions.cause.
    // biome-ignore lint/style/useErrorCause: Biome cannot follow the custom error constructor.
    throw new InvalidPaymentProfileError({ cause });
  }
}

function normalizePaymentFee(
  input: PaymentFeeConfigurationInput,
  parseFixed: PaymentFeeParser,
  parsePercentage: PaymentFeeParser
): NormalizedPaymentFeeConfiguration {
  if (!input || typeof input !== "object") {
    throw new InvalidPaymentProfileError();
  }

  const fixedInput = input.fixedAmount ?? null;
  const percentageInput = input.percentage ?? null;
  const hasFixed = fixedInput !== null;
  const hasPercentage = percentageInput !== null;
  let fixedAmount: string | null = null;
  let percentage: string | null = null;

  switch (input.mode) {
    case "unknown":
    case "none":
      if (hasFixed || hasPercentage) {
        throw new InvalidPaymentProfileError();
      }
      break;
    case "fixed":
      if (!hasFixed || hasPercentage) {
        throw new InvalidPaymentProfileError();
      }
      fixedAmount = parseFixed(fixedInput as string).toString();
      break;
    case "percentage":
      if (hasFixed || !hasPercentage) {
        throw new InvalidPaymentProfileError();
      }
      percentage = parsePercentage(percentageInput as string).toString();
      break;
    case "fixed_and_percentage":
      if (!(hasFixed && hasPercentage)) {
        throw new InvalidPaymentProfileError();
      }
      fixedAmount = parseFixed(fixedInput as string).toString();
      percentage = parsePercentage(percentageInput as string).toString();
      break;
    default:
      throw new InvalidPaymentProfileError();
  }

  return { fixedAmount, mode: input.mode, percentage };
}

function paymentFeeRuleKey(rule: NormalizedPaymentProfileRule): string {
  return [
    rule.method,
    rule.installmentPlan ?? "",
    rule.installments?.toString() ?? "",
  ].join("|");
}

function normalizePaymentProfileRule(
  input: PaymentProfileRuleInput
): NormalizedPaymentProfileRule {
  if (!input || typeof input !== "object") {
    throw new InvalidPaymentProfileError();
  }

  const {
    method,
    installments: inputInstallments,
    installmentPlan: inputInstallmentPlan,
  } = input;
  const installments = inputInstallments ?? null;
  const installmentPlan = inputInstallmentPlan ?? null;
  if (typeof method !== "string" || !paymentMethods.has(method)) {
    throw new InvalidPaymentProfileError();
  }

  if (method === "credit_card") {
    if (
      !Number.isInteger(installments) ||
      installments === null ||
      installments < 1 ||
      installments > maxPostgresInteger ||
      (installmentPlan !== "merchant" && installmentPlan !== "issuer")
    ) {
      throw new InvalidPaymentProfileError();
    }
  } else if (installments !== null || installmentPlan !== null) {
    throw new InvalidPaymentProfileError();
  }

  const expectedSettlementDays = input.expectedSettlementDays ?? null;
  if (
    expectedSettlementDays !== null &&
    (!Number.isInteger(expectedSettlementDays) ||
      expectedSettlementDays < 0 ||
      expectedSettlementDays > maxPostgresInteger)
  ) {
    throw new InvalidPaymentProfileError();
  }

  return {
    anticipationFee: normalizePaymentFee(
      input.anticipationFee,
      parseFeeAmount,
      parseFeePercentage
    ),
    expectedSettlementDays,
    installmentPlan,
    installments,
    method,
    processingFee: normalizePaymentFee(
      input.processingFee,
      parseFeeAmount,
      parseFeePercentage
    ),
  };
}

export function normalizePaymentProfile(
  input: PaymentProfileInput
): NormalizedPaymentProfile {
  if (!input || typeof input !== "object" || !Array.isArray(input.rules)) {
    throw new InvalidPaymentProfileError();
  }

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || [...name].length > 100 || input.rules.length === 0) {
    throw new InvalidPaymentProfileError();
  }

  const rules = input.rules.map(normalizePaymentProfileRule);
  const keys = new Set<string>();
  for (const rule of rules) {
    const key = paymentFeeRuleKey(rule);
    if (keys.has(key)) {
      throw new InvalidPaymentProfileError();
    }
    keys.add(key);
  }
  return { name, rules };
}

export function calculatePaymentFee(
  totalDue: string,
  configuration: NormalizedPaymentFeeConfiguration
): PaymentFeeCalculation {
  const due = Money.from(totalDue);
  if (due.minorUnits < 0n) {
    throw new InvalidPaymentProfileError();
  }

  const normalizedConfiguration = normalizePaymentFee(
    configuration,
    parseFeeAmount,
    parseFeePercentage
  );
  if (normalizedConfiguration.mode === "unknown") {
    return { amount: null, configuration: normalizedConfiguration };
  }
  if (normalizedConfiguration.mode === "none") {
    return { amount: "0.00", configuration: normalizedConfiguration };
  }

  let exact = DecimalAmount.from("0");
  if (normalizedConfiguration.fixedAmount !== null) {
    exact = exact.add(
      Money.from(normalizedConfiguration.fixedAmount).toDecimalAmount()
    );
  }
  if (normalizedConfiguration.percentage !== null) {
    exact = exact.add(
      Percentage.from(normalizedConfiguration.percentage).applyTo(due)
    );
  }
  return {
    amount: exact.toMoneyHalfUp().toString(),
    configuration: normalizedConfiguration,
  };
}

export function snapshotPaymentProfileForSale(
  totalDue: string,
  payment: PaymentContextForSale,
  profile: PaymentProfileForSale | null
): SalePaymentProfileSnapshot {
  const due = Money.from(totalDue);
  if (due.minorUnits < 0n) {
    throw new InvalidPaymentProfileError();
  }
  if (
    typeof payment.anticipationRequested !== "boolean" ||
    !paymentMethods.has(payment.method) ||
    (payment.method === "credit_card" &&
      (!Number.isInteger(payment.installments) ||
        payment.installments === null ||
        payment.installments < 1 ||
        payment.installments > maxPostgresInteger ||
        (payment.installmentPlan !== "merchant" &&
          payment.installmentPlan !== "issuer"))) ||
    (payment.method !== "credit_card" &&
      (payment.installments !== null ||
        payment.installmentPlan !== null ||
        payment.anticipationRequested))
  ) {
    throw new InvalidPaymentProfileError();
  }

  const matchingRule = profile?.rules.find(
    (rule) =>
      rule.method === payment.method &&
      rule.installments === payment.installments &&
      rule.installmentPlan === payment.installmentPlan
  );

  const unknownFee: SalePaymentFeeSnapshot = {
    amount: null,
    fixedAmount: null,
    mode: "unknown",
    percentage: null,
  };
  const unknownConfiguration: NormalizedPaymentFeeConfiguration = {
    fixedAmount: null,
    mode: "unknown",
    percentage: null,
  };
  const processing = matchingRule
    ? calculatePaymentFee(totalDue, matchingRule.processingFee)
    : { amount: null, configuration: unknownConfiguration };

  let anticipation: SalePaymentFeeSnapshot;
  if (!payment.anticipationRequested) {
    anticipation = {
      amount: "0.00",
      fixedAmount: null,
      mode: "not_applicable",
      percentage: null,
    };
  } else if (matchingRule) {
    const calculated = calculatePaymentFee(
      totalDue,
      matchingRule.anticipationFee
    );
    anticipation = {
      amount: calculated.amount,
      fixedAmount: calculated.configuration.fixedAmount,
      mode: calculated.configuration.mode,
      percentage: calculated.configuration.percentage,
    };
  } else {
    anticipation = unknownFee;
  }

  return {
    anticipationFee: anticipation,
    expectedSettlementDays: matchingRule?.expectedSettlementDays ?? null,
    paymentProfileId: profile?.id ?? null,
    paymentProfileName: profile?.name ?? null,
    paymentProfileRuleId: matchingRule?.id ?? null,
    paymentProfileVersion: profile?.version ?? null,
    processingFee: {
      amount: processing.amount,
      fixedAmount: processing.configuration.fixedAmount,
      mode: processing.configuration.mode,
      percentage: processing.configuration.percentage,
    },
  };
}

export type PaymentProfileLifecycle = "active" | "archived";
export type PaymentProfileLifecycleAction = "archive" | "restore";

export function derivePaymentProfileLifecycle(
  archivedAt: Date | null
): PaymentProfileLifecycle {
  return archivedAt === null ? "active" : "archived";
}

export function transitionPaymentProfileLifecycle(
  archivedAt: Date | null,
  action: PaymentProfileLifecycleAction,
  at: Date = new Date()
): {
  archivedAt: Date | null;
  changed: boolean;
  lifecycle: PaymentProfileLifecycle;
} {
  const current = derivePaymentProfileLifecycle(archivedAt);
  const target = action === "archive" ? "archived" : "active";
  if (current === target) {
    return { archivedAt, changed: false, lifecycle: current };
  }
  return {
    archivedAt: target === "archived" ? at : null,
    changed: true,
    lifecycle: target,
  };
}
