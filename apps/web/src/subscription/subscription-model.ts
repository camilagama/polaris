import type { BillingPlanView } from "@polaris/contracts";
import { saoPauloDateOf } from "@polaris/domain/billing/provider-period";
import { TRIAL_DAYS } from "@polaris/domain/billing/subscription-state";
import { Money } from "@polaris/domain/money/money";
import { formatBrlAmount, formatCalendarDate } from "../lib/format";
import {
  isConnectionFailure,
  isPlatformCut,
  rpcErrorCode,
  rpcErrorReason,
} from "../lib/rpc-error";
import {
  accessDateText,
  DAY_MS,
  daysLeftText,
  daysUntil,
  lastDayOf,
  plural,
  untilText,
} from "./plan-notice";

/**
 * What the Assinatura says (corte assinatura-e-cancelar, AC-9 to AC-17).
 * Everything comes from `billing.readPlan`: the days are São Paulo's, as the server's, and nothing is
 * counted on the client but the day the trial's first charge would fall on, before any checkout (the same rule the
 * server sets at the provider).
 */

export type PlanMethod = "card" | "pix_automatic";
export type CycleMonths = 1 | 6 | 12;

type BadgeTone = "ink" | "outline" | "secondary" | "warning";

export interface PlanHeadline {
  badge: { text: string; tone: BadgeTone } | null;
  support: string | null;
  title: string;
}

function freeSupport(plan: BillingPlanView): string | null {
  const limit = plan.limits.variants;
  return limit === null
    ? null
    : `Você usa ${plan.usage.variants} de ${limit} variantes.`;
}

/** The title, the badge and the line under it, one per state (AC-9, with the amendment of the "Ativo" line). */
export function planHeadline(plan: BillingPlanView, now: Date): PlanHeadline {
  const proUntil =
    plan.accessEndsAt === null ? null : accessDateText(plan.accessEndsAt);
  switch (plan.state) {
    case "free":
      return { badge: null, support: freeSupport(plan), title: "Plano Free" };
    case "free_over_limit":
      return {
        badge: { text: "acima do limite", tone: "warning" },
        support:
          "Sua loja tem mais variantes do que o Free permite. Seus dados estão guardados.",
        title: "Plano Free",
      };
    case "trial_setup":
      return {
        badge: null,
        support: "O teste começa quando o pagamento ficar pronto.",
        title: "Falta autorizar o pagamento",
      };
    case "grace": {
      const today = saoPauloDateOf(now);
      return {
        badge:
          plan.accessEndsAt === null
            ? null
            : {
                text: daysLeftText(
                  daysUntil(lastDayOf(plan.accessEndsAt), today)
                ),
                tone: "warning",
              },
        support:
          proUntil === null
            ? null
            : `Seu Pro vai até ${proUntil}. Depois a loja volta ao Free e seus dados ficam.`,
        title: "Pagamento não confirmado",
      };
    }
    default:
      break;
  }
  if (plan.renewalCancelled && proUntil !== null) {
    return plan.refundPending
      ? {
          badge: { text: "Reembolso pendente", tone: "warning" },
          support:
            "A renovação foi cancelada. O reembolso ainda não foi concluído.",
          title: `Pro até ${proUntil}`,
        }
      : {
          badge: { text: "Renovação cancelada", tone: "secondary" },
          support: "Depois dessa data a loja volta ao Free. Seus dados ficam.",
          title: `Pro até ${proUntil}`,
        };
  }
  const charge = plan.nextCharge;
  if (plan.state === "trialing") {
    return {
      // the Pix trial counts from the bank's approval: no number of days (AC-12)
      badge: {
        text:
          plan.method === "pix_automatic" ? "teste grátis" : "7 dias grátis",
        tone: "secondary",
      },
      support:
        charge === null
          ? null
          : `A primeira cobrança é em ${formatCalendarDate(charge.on)}. Cancele antes e nada é cobrado.`,
      title: "Pro, em teste",
    };
  }
  return {
    badge: { text: "Ativo", tone: "ink" },
    support:
      charge === null
        ? null
        : `Próxima cobrança em ${formatCalendarDate(charge.on)}, ${formatBrlAmount(charge.amount)}.`,
    title: "Plano Pro",
  };
}

/** The line of the payment that comes next, in the "Pagamento" block. */
export interface ChargeLine {
  label: string;
  value: string;
}

export const METHOD_NAMES: Readonly<Record<PlanMethod, string>> = {
  card: "Cartão de crédito",
  pix_automatic: "Pix Automático",
};

const CYCLE_NAMES: Readonly<Record<CycleMonths, string>> = {
  1: "Mensal",
  6: "Semestral",
  12: "Anual",
};

const CYCLE_UNITS: Readonly<Record<CycleMonths, string>> = {
  1: "por mês",
  6: "por semestre",
  12: "por ano",
};

function cycleName(cycleMonths: CycleMonths): string {
  return CYCLE_NAMES[cycleMonths];
}

/**
 * The "Pagamento" block of a Pro store: how it pays, the cycle and the charge to come ("Nenhuma" once the renewal is
 * cancelled). Null on Free and while the method is not ready. In grace the charge that failed is not in the read:
 * the block says how the store pays and nothing about a date.
 */
export function paymentLines(plan: BillingPlanView): ChargeLine[] | null {
  if (
    !(
      plan.state === "trialing" ||
      plan.state === "active" ||
      plan.state === "grace"
    ) ||
    plan.method === null
  ) {
    return null;
  }
  const lines: ChargeLine[] = [
    { label: "Como paga", value: METHOD_NAMES[plan.method] },
  ];
  if (plan.cycleMonths !== null) {
    lines.push({
      label: "Ciclo",
      value:
        plan.nextCharge === null
          ? cycleName(plan.cycleMonths)
          : `${cycleName(plan.cycleMonths)} · ${formatBrlAmount(plan.nextCharge.amount)}`,
    });
  }
  if (plan.state === "grace") {
    return lines;
  }
  const label =
    plan.state === "trialing" ? "Primeira cobrança" : "Próxima cobrança";
  if (plan.renewalCancelled) {
    lines.push({ label: "Próxima cobrança", value: "Nenhuma" });
  } else if (plan.nextCharge !== null) {
    lines.push({
      label,
      value: `${formatCalendarDate(plan.nextCharge.on)} · ${formatBrlAmount(plan.nextCharge.amount)}`,
    });
  }
  return lines;
}

export interface UsageRow {
  id: "goals" | "images" | "variants";
  label: string;
  limit: number | null;
  /** The use is above the limit, on any plan (the badge and the full bar); never without a limit. */
  over: boolean;
  used: number;
}

function usageRow(
  id: UsageRow["id"],
  label: string,
  limit: number | null,
  used: number
): UsageRow {
  return { id, label, limit, over: limit !== null && used > limit, used };
}

/** The three limits of the plan and what the store uses of each (the server's counts, AS-4). */
export function usageRows(plan: BillingPlanView): UsageRow[] {
  const { limits, usage } = plan;
  return [
    usageRow("variants", "Variantes", limits.variants, usage.variants),
    usageRow("images", "Imagens", limits.images, usage.images),
    usageRow("goals", "Metas em andamento", limits.goals, usage.goals),
  ];
}

/** "N vendas, N produtos e N meses de histórico", each part in the singular for 1 and left out at 0; null at 0. */
export function keptList(kept: BillingPlanView["kept"]): string | null {
  const parts = [
    kept.sales > 0 ? plural(kept.sales, "venda", "vendas") : null,
    kept.products > 0 ? plural(kept.products, "produto", "produtos") : null,
    kept.historyMonths > 0
      ? `${plural(kept.historyMonths, "mês", "meses")} de histórico`
      : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) {
    return null;
  }
  const last = parts.pop();
  return parts.length === 0 ? (last ?? null) : `${parts.join(", ")} e ${last}`;
}

/**
 * What the store already keeps (AS-24, amendment D1): "N vendas, N produtos e N meses de histórico", each part in
 * the singular for 1 and left out at 0; no line when the three are 0. The numbers are the server's.
 */
export function keptLine(kept: BillingPlanView["kept"]): string | null {
  const listed = keptList(kept);
  return listed === null
    ? null
    : `O que a sua loja já guardou: ${listed}. Seus dados não são apagados.`;
}

/** The notice of a refund asked and not completed, by whether the app may still complete it (AS-42, E-RP). */
export interface RefundPendingNotice {
  description: string;
  title: string;
}

export function refundPendingNotice(
  plan: BillingPlanView
): RefundPendingNotice | null {
  if (!plan.refundPending) {
    return null;
  }
  if (plan.refund !== null) {
    return {
      description: `Nada será cobrado a mais. O prazo de desistência continua valendo até ${untilText(plan.refund.until)}.`,
      title: "Cancelamos a renovação, mas o reembolso não foi concluído.",
    };
  }
  // past the 72 hours the request is the operator's (ADR 0104, decision 3): no way to try again here
  return {
    description:
      "Nada será cobrado a mais. Você recebe um e-mail quando o reembolso for concluído.",
    title: "Cancelamos a renovação. O reembolso está com o nosso suporte.",
  };
}

/**
 * When a store whose renewal was cancelled may subscribe again (AS-27): after the last day already paid for, as the
 * refusal of the checkout says it (`renewal_cancelled_until`).
 */
export function resubscribeLine(plan: BillingPlanView): string | null {
  return plan.resubscribeFrom === null
    ? null
    : `Dá para assinar de novo depois de ${accessDateText(plan.resubscribeFrom)}, quando este período termina.`;
}

// ---- the offer -------------------------------------------------------------------------------------------------

export interface OfferCycle {
  amount: string;
  /** "2 meses grátis" against twelve months of the monthly price, when the catalog has both. */
  bonus: string | null;
  cycleMonths: CycleMonths;
  name: string;
  /** "R$ 24,90" */
  price: string;
  /** "por mês", or "por ano · R$ 20,75 por mês" */
  unit: string;
}

/** The price per month of a longer cycle, for display only: half-up to the cent, never stored nor charged. */
function perMonth(amount: string, months: number): string {
  const cents = Money.from(amount).minorUnits;
  const divisor = BigInt(months);
  const rounded = (cents * 2n + divisor) / (2n * divisor);
  return formatBrlAmount(Money.fromMinorUnits(rounded).toString());
}

/** Whole months the longer cycle saves against the monthly price ("2 meses grátis"); null under one. */
function bonusOf(
  amount: string,
  months: number,
  monthly: string | null
): string | null {
  if (monthly === null || months === 1) {
    return null;
  }
  const monthlyCents = Money.from(monthly).minorUnits;
  if (monthlyCents <= 0n) {
    return null;
  }
  const saved = monthlyCents * BigInt(months) - Money.from(amount).minorUnits;
  const free = Number(saved / monthlyCents);
  if (free < 1) {
    return null;
  }
  return `${plural(free, "mês", "meses")} grátis`;
}

/** The cycles of the catalog's active prices (AS-5), shortest first, each with its total price (AS-11). */
export function offerCycles(plan: BillingPlanView): OfferCycle[] {
  const prices = [...plan.offer.prices].sort(
    (left, right) => left.cycleMonths - right.cycleMonths
  );
  const monthly =
    prices.find((price) => price.cycleMonths === 1)?.amount ?? null;
  return prices.map(({ amount, cycleMonths }) => ({
    amount,
    bonus: bonusOf(amount, cycleMonths, monthly),
    cycleMonths,
    name: CYCLE_NAMES[cycleMonths],
    price: formatBrlAmount(amount),
    unit:
      cycleMonths === 1
        ? CYCLE_UNITS[1]
        : `${CYCLE_UNITS[cycleMonths]} · ${perMonth(amount, cycleMonths)} por mês`,
  }));
}

/** The monthly cycle comes chosen (AS-11); without it, the first the catalog has. */
export function defaultCycle(
  cycles: readonly OfferCycle[]
): CycleMonths | null {
  return (
    cycles.find((cycle) => cycle.cycleMonths === 1)?.cycleMonths ??
    cycles[0]?.cycleMonths ??
    null
  );
}

export const METHOD_HINTS: Readonly<Record<PlanMethod, string>> = {
  card: "Você vai pagar na página segura do Asaas. O Polaris não vê o número do cartão.",
  pix_automatic: "Você autoriza uma vez no app do banco.",
};

/** The methods the server offers (AS-6), the card first. */
export function offerMethods(plan: BillingPlanView): PlanMethod[] {
  return (["card", "pix_automatic"] as const).filter((method) =>
    plan.offer.methods.includes(method)
  );
}

/** The day the first charge falls on: today in São Paulo, or after the trial (the rule the checkout sets). */
export function firstChargeDay(now: Date, trial: boolean): string {
  return saoPauloDateOf(
    trial ? new Date(now.getTime() + TRIAL_DAYS * DAY_MS) : now
  );
}

export interface OfferTerms {
  /** The button that starts the checkout. */
  action: string;
  /** The rest of the first line: when and how much the first charge is. */
  charge: string;
  /** The words in bold that open the box: what the person gets now. */
  lead: string;
}

/**
 * The box above the button (AC-12): with the trial, "Começar os 7 dias grátis" on the card and
 * "Começar o teste grátis" on Pix, which counts from the bank's approval; without it, "Assinar o Pro" and that the
 * trial was used. Never "sem cartão".
 */
export function offerTerms(input: {
  amount: string;
  method: PlanMethod;
  now: Date;
  trialAvailable: boolean;
}): OfferTerms {
  const price = formatBrlAmount(input.amount);
  if (!input.trialAvailable) {
    return {
      action: "Assinar o Pro",
      charge: `A primeira cobrança, de ${price}, é hoje.`,
      lead: "Seu teste grátis já foi usado.",
    };
  }
  const day = formatCalendarDate(firstChargeDay(input.now, true));
  const charge = `A primeira cobrança, de ${price}, é em ${day}. Cancele antes e nada é cobrado.`;
  return input.method === "pix_automatic"
    ? { action: "Começar o teste grátis", charge, lead: "Teste grátis." }
    : { action: "Começar os 7 dias grátis", charge, lead: "7 dias grátis." };
}

/**
 * What the Pro adds, true for every catalog (no number: the limits are the catalog's and change without code). The
 * wireframe's "sem limite" is not said: the Pro has limits too.
 */
export const PRO_PITCH =
  "Catálogo público no ar, vendas sem internet e mais variantes, imagens e metas.";

/**
 * The hosts of the provider's pages the server hands out: Asaas's (and its subdomains, as `pickAsaasCheckout` takes
 * them) and Woovi's (`PAYMENT_LINK_DOMAINS` of the Woovi port). The server is the gate; this is the second one.
 */
const PROVIDER_DOMAINS = [
  "asaas.com",
  "woovi.com",
  "woovi-sandbox.com",
  "openpix.com.br",
];

/** Only an https address on a host of the provider's is opened (the contract only says it is a URL). */
export function safeProviderUrl(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  // `new URL`, not `URL.parse`, which Safari 16.4 (the floor) lacks
  try {
    const url = new URL(value);
    const onProvider = PROVIDER_DOMAINS.some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)
    );
    return url.protocol === "https:" &&
      onProvider &&
      url.username === "" &&
      url.password === "" &&
      url.port === ""
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export const REFUND_RULE =
  "Você pode desistir em até 7 dias depois da primeira cobrança e receber o valor de volta.";

/** The rule once the window is over, with the day it ended (AS-14, Emenda 2; the mockup's text). */
function refundRuleEndedText(endedOn: string): string {
  return `O reembolso integral vale nos primeiros 7 dias depois da primeira cobrança. Esse prazo terminou em ${formatCalendarDate(endedOn)}.`;
}

/**
 * The line of the right of withdrawal in the footer (AS-14, Emenda 2), only where it is true, read from the plan and
 * never from the client's clock: none while the screen already speaks of the refund asked (`refundPending`) or of
 * the charge that failed (grace); the rule where the right still comes (the offer, the waiting for the method, the
 * trial) or still holds (`refund`, with the button or by support); the day it ended once the window is over
 * (`refundWindowEndedOn`, the server's). A Pro with neither (a link older than the recorded first charge) says nothing.
 */
export function refundRuleLine(plan: BillingPlanView): string | null {
  if (plan.refundPending || plan.state === "grace") {
    return null;
  }
  if (plan.state !== "active") {
    return REFUND_RULE;
  }
  if (plan.refund !== null) {
    return REFUND_RULE;
  }
  // a Worker of the previous version answers without the field: no date, no line
  return plan.refundWindowEndedOn
    ? refundRuleEndedText(plan.refundWindowEndedOn)
    : null;
}

/** The supplier, as in the Terms (AS-14; the final text waits on P48). */
export const SUPPLIER_LINE =
  "Polaris, um produto de Agência Summit, CNPJ 35.584.467/0001-00.";

// ---- the Pix payer ---------------------------------------------------------------------------------------------

/** Only the digits of a CPF or CNPJ typed with dots, dashes or a slash. */
export function taxIdDigits(value: string): string {
  return value.replace(/\D+/g, "");
}

// ---- the return of the checkout and the reading again ----------------------------------------------------------

export type CheckoutReturn = "cancelada" | "concluida" | "expirada";

/** `?retorno=` of the provider's page (the URLs are the server's): anything else is no return. */
export function checkoutReturnOf(search: string): CheckoutReturn | null {
  const value = new URLSearchParams(search).get("retorno");
  return value === "concluida" || value === "cancelada" || value === "expirada"
    ? value
    : null;
}

/** Every 5 s for up to 2 min, then "Atualizar". */
export const REREAD_EVERY_MS = 5000;
export const REREAD_FOR_MS = 120_000;

/** The plan is still waiting for the provider's fact: the screen reads it again by itself. */
export function waitsForProvider(
  plan: BillingPlanView,
  returned: CheckoutReturn | null
): boolean {
  if (returned === "cancelada" || returned === "expirada") {
    // the card's page said no payment was made: nothing to wait for
    return false;
  }
  if (plan.state === "trial_setup") {
    return true;
  }
  return (
    returned === "concluida" &&
    (plan.state === "free" || plan.state === "free_over_limit")
  );
}

/** What the screen says when the person came back from the card's page without paying (AS-15: nothing spent). */
export function abandonedCheckoutText(
  returned: CheckoutReturn | null,
  plan: BillingPlanView
): string | null {
  if (returned !== "cancelada" && returned !== "expirada") {
    return null;
  }
  if (
    !(
      plan.state === "free" ||
      plan.state === "free_over_limit" ||
      plan.state === "trial_setup"
    )
  ) {
    return null;
  }
  return plan.trialAvailable
    ? "O pagamento não foi feito e nada foi cobrado. Seu teste grátis continua disponível."
    : "O pagamento não foi feito e nada foi cobrado.";
}

/** A Free store still, 2 min after the return of a payment done: the fact did not come, and the offer is back. */
export const UNCONFIRMED_RETURN_TEXT =
  "Ainda não recebemos a confirmação do pagamento. Se você concluiu na página do Asaas, não assine de novo: avisamos por e-mail quando confirmar. Se desistiu lá, pode começar de novo aqui.";

// ---- the refusals -----------------------------------------------------------------------------------------------

export interface Refusal {
  /** The plan may have changed: the screen offers "Atualizar", which reads it again, instead of trying. */
  reread: boolean;
  /** Trying the same again is safe and may work. */
  retry: boolean;
  text: string;
}

const CONNECTION_TEXT =
  "A conexão falhou antes da resposta. Nada foi cobrado. Confira a conexão e tente de novo.";

/**
 * `billing_provider_unavailable`, the Worker's 503 with no reason and the cut of the platform may come after the
 * provider created the checkout, and the screen cannot tell. Creating it never charges (the card is typed on the
 * provider's page; the Pix is authorized in the bank), so "Nada foi cobrado" is true; what is unknown is whether
 * the page exists, and trying again discards the one left.
 */
const CHECKOUT_UNCONFIRMED_TEXT =
  "Não deu para confirmar se a página de pagamento foi aberta. Nada foi cobrado: toque em Atualizar e tente de novo.";

/**
 * `previous_checkout_unverified`: the provider did not answer whether the checkout the store had before was paid.
 * That one may have been approved with its webhook late, so unlike `CHECKOUT_UNCONFIRMED_TEXT` this text never says
 * nothing was charged; "Atualizar" reads the plan, where the subscription shows up if it was approved.
 */
const PREVIOUS_CHECKOUT_UNVERIFIED_TEXT =
  "Não deu para confirmar se o pagamento que você começou antes foi aprovado. Toque em Atualizar: se foi, a assinatura aparece aqui. Se não, tente de novo.";

/**
 * `previous_renewal_cancel_unverified`: the provider did not confirm the cancellation of the renewal of the old
 * subscription. It may have been made with the answer lost, so the text never says nothing changed; "Atualizar"
 * reads the plan before trying again. The new subscription is never created before this step, so saying it did not
 * start is safe; the old renewal may still be alive, so the text avoids "Nada foi cobrado" and a direct retry.
 */
const PREVIOUS_RENEWAL_CANCEL_UNVERIFIED_TEXT =
  "A assinatura nova não começou. Não deu para confirmar o encerramento da anterior: toque em Atualizar para ver o plano antes de tentar de novo.";

/** The text of each refusal of the checkout (AS-17) and of the read; the server's message where it has one. */
export function checkoutRefusal(error: unknown): Refusal {
  if (isConnectionFailure(error)) {
    return { reread: false, retry: true, text: CONNECTION_TEXT };
  }
  const code = rpcErrorCode(error);
  const reason = rpcErrorReason(error);
  switch (reason) {
    case "already_subscribed":
      return {
        reread: true,
        retry: false,
        text: "Sua loja já tem o Pro. Atualize para ver o plano.",
      };
    case "checkout_in_progress":
      return {
        reread: false,
        retry: true,
        text: "Outro pedido de assinatura com esse documento está em andamento. Aguarde um instante e tente de novo.",
      };
    case "checkout_pending_confirmation":
      return {
        reread: true,
        retry: false,
        text: "Seu pagamento anterior ainda está sendo confirmado. Aguarde alguns minutos e atualize antes de começar de novo.",
      };
    case "cycle_not_offered":
      return {
        reread: true,
        retry: false,
        text: "Esse ciclo não está mais disponível. Atualize e escolha de novo.",
      };
    case "payer_not_accepted":
      // the same text whatever the reason: it never tells whether the document is known
      return {
        reread: false,
        retry: false,
        text: "Não foi possível iniciar o Pix Automático com esses dados. Confira o nome, o CPF ou CNPJ e o e-mail, ou escolha o cartão.",
      };
    case "renewal_cancelled_until": {
      const until =
        typeof error === "object" &&
        error !== null &&
        "data" in error &&
        typeof (error.data as { until?: unknown } | null)?.until === "string"
          ? accessDateText((error.data as { until: string }).until)
          : null;
      return {
        reread: true,
        retry: false,
        text:
          until === null
            ? "Você cancelou a renovação. Dá para assinar de novo quando o período pago terminar."
            : `Você cancelou a renovação. Dá para assinar de novo depois de ${until}.`,
      };
    }
    case "trial_already_used":
      return {
        reread: true,
        retry: false,
        text: "Seu teste grátis já foi usado. Atualize para assinar sem o teste.",
      };
    case "trial_in_progress":
      return {
        reread: true,
        retry: false,
        text: "Seu teste grátis já está em andamento em outra loja. O teste vale uma vez por pessoa.",
      };
    case "billing_provider_unavailable":
      return {
        reread: true,
        retry: true,
        text: CHECKOUT_UNCONFIRMED_TEXT,
      };
    case "previous_checkout_unverified":
      return {
        reread: true,
        retry: true,
        text: PREVIOUS_CHECKOUT_UNVERIFIED_TEXT,
      };
    case "previous_renewal_cancel_unverified":
      return {
        reread: true,
        retry: false,
        text: PREVIOUS_RENEWAL_CANCEL_UNVERIFIED_TEXT,
      };
    case "billing_not_configured":
    case "billing_self_service_off":
      return {
        reread: false,
        retry: false,
        text: "A assinatura pelo app não está disponível agora. Nada foi cobrado. Tente mais tarde.",
      };
    case "billing_manage_required":
      return {
        reread: false,
        retry: false,
        text: "Só o dono da loja pode ver e mudar a assinatura.",
      };
    case "command_in_progress":
      return {
        reread: false,
        retry: true,
        text: "Já tem um pedido desta loja em andamento. Espere alguns segundos e tente de novo.",
      };
    case "billing_command_rate_limited":
      return {
        reread: false,
        retry: true,
        text: "Muitas tentativas seguidas. Espere um minuto e tente de novo.",
      };
    default:
      break;
  }
  if (code === "SERVICE_UNAVAILABLE" || isPlatformCut(error)) {
    return { reread: true, retry: true, text: CHECKOUT_UNCONFIRMED_TEXT };
  }
  return {
    reread: true,
    retry: false,
    text: "Não foi possível começar a assinatura agora. Atualize e tente de novo.",
  };
}

/** Why the plan could not be read (the alert of the screen, "Tentar novamente" when it may help). */
export function readRefusal(error: unknown): Refusal {
  const reason = rpcErrorReason(error);
  if (
    reason === "billing_manage_required" ||
    reason === "billing_self_service_off" ||
    reason === "billing_not_configured" ||
    rpcErrorCode(error) === "NOT_FOUND"
  ) {
    return {
      reread: false,
      retry: false,
      text:
        reason === "billing_manage_required"
          ? "Só o dono da loja pode ver e mudar a assinatura."
          : "A assinatura não está disponível agora.",
    };
  }
  return {
    reread: false,
    retry: true,
    text: "O servidor não respondeu. Nada mudou no seu plano.",
  };
}
