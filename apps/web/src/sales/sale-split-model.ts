import { formatBrlAmount } from "../lib/format";
import type {
  PaymentDraft,
  ProfileSelectionDraft,
  SaleMethod,
} from "./sale-form-model";

/**
 * The split of a sale's payment into parts, as the form keeps it. Part 1 stays in `SaleFormState.payment` and
 * `.profile` (a sale of one part is the form it always was); what a second part adds lives in `SplitDraft`, null while
 * the sale is paid in one go. All arithmetic is in whole cents (`bigint`): a remainder or a difference never goes
 * through a float.
 */
export interface SecondPartDraft {
  /** The typed text; null is "the rest", which follows the total and the first part until the person types here. */
  amount: string | null;
  payment: PaymentDraft;
  profile: ProfileSelectionDraft;
}

export interface SplitDraft {
  /** The text typed in part 1. */
  firstAmount: string;
  second: SecondPartDraft;
  /** The total due when an amount was last typed or set; a different one now means the parts may be stale. */
  totalSeen: string | null;
}

const CENTS_PER_UNIT = 100n;

/** Cents of a normalized amount (`123.45`, `100`); the caller has already validated the text. */
export function centsOfMoney(money: string): bigint {
  const [whole = "0", fraction = ""] = money.split(".");
  return BigInt(whole) * CENTS_PER_UNIT + BigInt(fraction.padEnd(2, "0"));
}

/** The amount text the API and the domain read (`123.45`). */
export function moneyOfCents(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  const fraction = String(absolute % CENTS_PER_UNIT).padStart(2, "0");
  return `${sign}${absolute / CENTS_PER_UNIT}.${fraction}`;
}

/** The text of an amount in the field, with the comma the person types (`123,45`). */
export function fieldTextOfCents(cents: bigint): string {
  return moneyOfCents(cents).replace(".", ",");
}

const brl = (cents: bigint): string => formatBrlAmount(moneyOfCents(cents));

/** What is left of the total after the first part: the amount the last part has while nobody typed in it. */
export function restOfTotal(total: bigint, first: bigint): bigint {
  return first >= total ? 0n : total - first;
}

type SplitAction =
  | { amount: bigint; kind: "add_to_second"; label: "Pôr na parte 2" }
  | { amount: bigint; kind: "take_from_second"; label: "Tirar da parte 2" };

export interface SplitBalanceInput {
  /** The cents typed in part 1. */
  first: bigint;
  methods: readonly [SaleMethod | "", SaleMethod | ""];
  /** The cents typed in part 2; null while it is the rest. */
  second: bigint | null;
  total: bigint;
}

/** "Ajustar para R$ X" on the cash part: the extra is change, so the cash part drops by it, wherever it sits. */
export interface CashAdjust {
  /** The cents the cash part is set to. */
  amount: bigint;
  /** What the customer gets back once the cash part drops. */
  change: bigint;
  label: string;
  part: 1 | 2;
}

export interface SplitBalance {
  /** What closes the difference by moving part 2, or null when part 2 cannot absorb it. */
  action: SplitAction | null;
  /** Present with the change hint: the button the screen offers instead of `action`. */
  cashAdjust: CashAdjust | null;
  /** Parts minus total: positive is "Passou", negative "Falta". */
  difference: bigint;
  /** Said only for the cash part when the parts pass the total: the cash part if the extra is change. */
  hint: string | null;
  kind: "closed" | "over" | "short";
  /** The cents part 2 has now: what was typed, or the rest. */
  second: bigint;
  /** "Falta R$ 66,68", "Passou R$ 50,00" or "Fechou: R$ 100,00". */
  text: string;
}

function cashAdjustOf(
  input: SplitBalanceInput,
  second: bigint,
  excess: bigint
): CashAdjust | null {
  const amounts: readonly [bigint, bigint] = [input.first, second];
  const cash = input.methods
    .map((method, index) => ({
      cents: amounts[index] ?? 0n,
      method,
      part: (index + 1) as 1 | 2,
    }))
    .filter((part) => part.method === "cash");
  const only = cash.length === 1 ? cash[0] : undefined;
  if (only === undefined || only.cents <= excess) {
    return null;
  }
  const amount = only.cents - excess;
  return {
    amount,
    change: excess,
    label: `Ajustar para ${brl(amount)}`,
    part: only.part,
  };
}

/** "Troco: R$ 50,00", said beside the cash part after "Ajustar para". */
export function changeText(change: bigint): string {
  return `Troco: ${brl(change)}`;
}

function actionFor(
  kind: SplitBalance["kind"],
  second: bigint,
  difference: bigint
): SplitAction | null {
  if (kind === "short") {
    return {
      amount: second - difference,
      kind: "add_to_second",
      label: "Pôr na parte 2",
    };
  }
  if (kind === "over" && second > difference) {
    return {
      amount: second - difference,
      kind: "take_from_second",
      label: "Tirar da parte 2",
    };
  }
  return null;
}

/** The state line of the two parts against the total: how far they are, and what would close them. */
export function splitBalance(input: SplitBalanceInput): SplitBalance {
  const second = input.second ?? restOfTotal(input.total, input.first);
  const difference = input.first + second - input.total;
  if (difference === 0n) {
    return {
      action: null,
      cashAdjust: null,
      difference,
      hint: null,
      kind: "closed",
      second,
      text: `Fechou: ${brl(input.total)}`,
    };
  }
  if (difference < 0n) {
    return {
      action: actionFor("short", second, difference),
      cashAdjust: null,
      difference,
      hint: null,
      kind: "short",
      second,
      text: `Falta ${brl(-difference)}`,
    };
  }
  const cashAdjust = cashAdjustOf(input, second, difference);
  return {
    action: actionFor("over", second, difference),
    cashAdjust,
    difference,
    hint:
      cashAdjust === null
        ? null
        : `Se for troco, a parte em dinheiro é ${brl(cashAdjust.amount)}.`,
    kind: "over",
    second,
    text: `Passou ${brl(difference)}`,
  };
}

/** The status and, when there is one, the change hint, as one sentence for a live region. */
export function splitBalanceSentence(balance: SplitBalance): string {
  return balance.hint === null
    ? balance.text
    : `${balance.text}. ${balance.hint}`;
}

/** One warning, one button, when both parts use the profile that changed. */
export const SHARED_PROFILE_REVIEW_MESSAGE = "Revise a prévia das duas partes.";

export const SPLIT_TOTAL_CHANGED_MESSAGE = "O total mudou. Confira as partes.";

/**
 * The warning that the total moved under typed parts. With a part 2 that is still the rest there is none: it followed
 * the total on its own.
 */
export function splitTotalChangedNotice(
  split: SplitDraft,
  total: string | null
): string | null {
  return split.second.amount !== null &&
    split.totalSeen !== null &&
    total !== null &&
    split.totalSeen !== total
    ? SPLIT_TOTAL_CHANGED_MESSAGE
    : null;
}

/** The part a message or a key is about: null is the sale paid in one go, whose texts are the ones of always. */
export type PartOrdinal = 1 | 2 | null;

export interface PartMessages {
  amountEmpty: string;
  amountNotPositive: string;
  installmentsEmpty: string;
  installmentsInvalid: string;
  methodEmpty: string;
  planEmpty: string;
  profileChanged: (name: string) => string;
  profileEmpty: string;
  profileGone: string;
  profileInactive: string;
  profileReview: string;
}

const SINGLE_MESSAGES: PartMessages = {
  amountEmpty: "Informe o valor do pagamento.",
  amountNotPositive: "O valor do pagamento deve ser maior que zero.",
  installmentsEmpty: "Informe o número de parcelas.",
  installmentsInvalid: "Use um número inteiro de 1 a 2.147.483.647.",
  methodEmpty: "Escolha o método de pagamento.",
  planEmpty: "Escolha quem parcela.",
  profileChanged: (name) =>
    `O perfil “${name}” mudou desde a última venda. Revise a prévia de taxas e prazo e confirme para continuar.`,
  profileEmpty: "Escolha um perfil de pagamento ou “Sem perfil”.",
  profileGone:
    "O perfil de pagamento escolhido não está mais ativo. Escolha outro perfil ou “Sem perfil” para continuar.",
  profileInactive:
    "O perfil escolhido não está na lista de perfis ativos. Escolha novamente.",
  profileReview:
    "Confirme a revisão da prévia do perfil atualizado antes de continuar.",
};

function messagesOfPart(ordinal: 1 | 2): PartMessages {
  const part = `parte ${ordinal}`;
  return {
    amountEmpty: `Informe o valor da ${part}.`,
    amountNotPositive: `O valor da ${part} deve ser maior que zero.`,
    installmentsEmpty: `Informe o número de parcelas da ${part}.`,
    installmentsInvalid: `Parcelas da ${part}: use um número inteiro de 1 a 2.147.483.647.`,
    methodEmpty: `Escolha o método da ${part}.`,
    planEmpty: `Escolha quem parcela na ${part}.`,
    profileChanged: (name) =>
      `O perfil “${name}” da ${part} mudou desde a última venda. Revise a prévia de taxas e prazo da ${part} e confirme para continuar.`,
    profileEmpty: `Escolha um perfil de pagamento ou “Sem perfil” na ${part}.`,
    profileGone: `O perfil de pagamento da ${part} não está mais ativo. Escolha outro perfil ou “Sem perfil” para continuar.`,
    profileInactive: `O perfil da ${part} não está na lista de perfis ativos. Escolha novamente.`,
    profileReview: `Confirme a revisão da prévia da ${part} antes de continuar.`,
  };
}

export function partMessages(ordinal: PartOrdinal): PartMessages {
  return ordinal === null ? SINGLE_MESSAGES : messagesOfPart(ordinal);
}

/** The keys the field errors of the second part use; part 1 keeps the keys of the sale paid in one go. */
export const splitFieldKeys = {
  firstAmount: "payment:amount",
  secondAmount: "payment2:amount",
  secondInstallmentPlan: "payment2:installmentPlan",
  secondInstallments: "payment2:installments",
  secondMethod: "payment2:method",
  secondProfile: "profile2",
} as const;

/* -------------------------------------------------------------------------- */
/* The screen                                                                 */
/* -------------------------------------------------------------------------- */

export const SPLIT_START_LABEL = "Dividir pagamento";
export const SPLIT_END_LABEL = "Voltar a um pagamento só";

/** What the (i) of "Pagamento" says while the sale is paid in one go. */
export const SINGLE_PAYMENT_HELP =
  "Um pagamento no valor total. Para receber de dois jeitos, use Dividir pagamento. O método não comprova o recebimento.";

/** What the (i) of "Pagamento" says while the sale is paid in two parts. */
export const SPLIT_PAYMENT_HELP =
  "Cada parte tem método, valor e perfil. As duas somam o total. O método não comprova o recebimento.";

const SPLIT_OFFLINE_REASON = "Dividir precisa de internet";
const SPLIT_EMPTY_REASON = "Adicione um item para dividir o pagamento.";

/** Said when a sale in parts meets a dropped connection at the confirmation: the device keeps one payment per sale. */
export const SPLIT_OFFLINE_REFUSAL =
  "Dividir precisa de internet. Confirme quando a conexão voltar ou volte a um pagamento só.";

/**
 * Why "Dividir pagamento" is off, or null when it is on. Without a connection the device could not keep the sale (it
 * carries one payment); with no total there is nothing to split.
 */
export function splitStartBlocker(
  offline: boolean,
  total: string | null
): string | null {
  if (offline) {
    return SPLIT_OFFLINE_REASON;
  }
  return total === null || total.startsWith("-") || centsOfMoney(total) <= 0n
    ? SPLIT_EMPTY_REASON
    : null;
}
