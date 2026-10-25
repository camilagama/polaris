import type { BillingPlanView } from "@polaris/contracts";
import { formatBrlAmount } from "../lib/format";
import {
  isConnectionFailure,
  rpcErrorCode,
  rpcErrorReason,
} from "../lib/rpc-error";
import { accessDateText, untilText } from "./plan-notice";
import { keptList, type Refusal } from "./subscription-model";

/**
 * What the owner's commands of the Assinatura say (corte assinatura-e-cancelar, AC-21 to AC-34, AC-42 to AC-44;
 * design t268 v2, § 4 and § 11; ADR 0104, decision 3): cancel the renewal, the refund of the right of withdrawal and
 * paying the charge that failed. Everything comes from `billing.readPlan` and from the commands' answers; the client
 * counts no window and trusts no clock of its own: the screen reads the plan again once the server's `until` passes.
 */

export type OwnerCommand = "cancel" | "overdue" | "refund";

// ---- what each state offers ------------------------------------------------------------------------------------

/** The renewal may be cancelled: a Pro (trial, active or grace) whose renewal is still on (AS-21, AS-28). */
export function canCancelRenewal(plan: BillingPlanView): boolean {
  return (
    !plan.renewalCancelled &&
    (plan.state === "trialing" ||
      plan.state === "active" ||
      plan.state === "grace")
  );
}

/** The line next to "Cancelar a renovação": what stays (AS-21, AS-25). */
export function cancelHint(plan: BillingPlanView): string {
  if (plan.state === "trialing") {
    return "O teste vai até o fim e nada é cobrado. Você não terá outro teste grátis.";
  }
  if (plan.state === "grace" && plan.accessEndsAt !== null) {
    return `Seu Pro continua até ${accessDateText(plan.accessEndsAt)}.`;
  }
  return "Seu Pro continua até o fim do que você já pagou.";
}

// ---- cancel the renewal ----------------------------------------------------------------------------------------

/**
 * What changes on the Free, each line a rule of billing-and-entitlements.md (AC-23), with no number: the Free's limits
 * are the catalog's and the plan read carries the limits in force, not the Free's.
 */
export const FREE_CHANGES: readonly string[] = [
  // the public catalog is served only with `public_catalog` in the plan in force
  "O catálogo público sai do ar.",
  // offline writing is a feature of the plan: without it there is no lease
  "A escrita sem internet desliga.",
  // the oldest goals up to the limit go on, the newer are paused
  "Metas acima do limite do Free ficam pausadas. As mais antigas continuam.",
  // only the chosen variants (or the most recently sold) take sales and stock entries
  "Variantes acima do limite do Free só recebem vendas e entradas nas que você escolher.",
  // images beyond the limits are kept; only new ones are refused
  "Imagens acima do limite ficam guardadas. Só não entram novas.",
];

/** The kept line of the dialogs: the store's numbers, or that the data stays when it has none yet (AS-24). */
export function keptText(plan: BillingPlanView): string {
  const listed = keptList(plan.kept);
  return listed === null
    ? "Seus dados não são apagados."
    : `${listed}. Seus dados não são apagados.`;
}

export interface DialogText {
  description: string;
  title: string;
}

/**
 * The dialog of "Cancelar a renovação" (AC-22, AC-25, AC-28): until when the Pro goes (the trial says no date: its
 * screen speaks only of the first charge, item 13), and that afterwards the store is on the Free.
 */
export function cancelDialogText(plan: BillingPlanView): DialogText {
  if (plan.state === "trialing") {
    return {
      description:
        "O teste vai até o fim e nada é cobrado. Você não terá outro teste grátis. Depois a loja volta ao plano Free.",
      title: "Cancelar o Pro em teste?",
    };
  }
  const until =
    plan.accessEndsAt === null ? null : accessDateText(plan.accessEndsAt);
  if (plan.state === "grace") {
    return {
      description:
        until === null
          ? "Não há nova tentativa de cobrança. A loja volta ao plano Free quando o prazo terminar."
          : `Não há nova tentativa de cobrança. Seu Pro continua até ${until}. Depois dessa data a loja volta ao plano Free.`,
      title: "Cancelar a renovação do Pro?",
    };
  }
  return {
    description:
      until === null
        ? "Seu Pro continua até o fim do que você já pagou. Depois a loja volta ao plano Free."
        : `Seu Pro continua até ${until}, o fim do que você já pagou. Depois dessa data a loja volta ao plano Free.`,
    title: "Cancelar a renovação do Pro?",
  };
}

export const REASON_MAX = 500;
export const REASON_HINT =
  "Não escreva dados pessoais. O motivo fica guardado sem o nome da loja.";

/** Control, format (zero-width, bidirectional), unassigned and lone surrogate characters, but line breaks and tabs. */
const REFUSED_IN_REASON = /(?![\n\t])\p{C}/gu;

/**
 * The reason as the contract takes it, or nothing when it is empty: without the characters the contract refuses
 * (an emoji joined by a zero-width joiner comes apart, and is not refused), trimmed, and cut at 500 UTF-16 units
 * without splitting a character.
 */
export function reasonOf(value: string): string | undefined {
  const cleaned = value.replace(REFUSED_IN_REASON, "").trim();
  let cut = "";
  for (const character of cleaned) {
    if (cut.length + character.length > REASON_MAX) {
      break;
    }
    cut += character;
  }
  const reason = cut.trim();
  return reason === "" ? undefined : reason;
}

/** What the screen says once the renewal is cancelled (or was already). */
export function cancelledText(
  result: "already_cancelled" | "cancelled",
  accessEndsAt: string | null
): string {
  const until = accessEndsAt === null ? null : accessDateText(accessEndsAt);
  const first =
    result === "cancelled"
      ? "Renovação cancelada."
      : "A renovação já estava cancelada.";
  return until === null
    ? `${first} Nada mais é cobrado.`
    : `${first} Seu Pro continua até ${until} e nada mais é cobrado.`;
}

// ---- the refund of the right of withdrawal ---------------------------------------------------------------------

/** "Desistir e receber o reembolso" and its line: until when, how much and that the Pro ends now (AC-30, AC-34). */
export function refundHint(refund: NonNullable<BillingPlanView["refund"]>) {
  return `Vale até ${untilText(refund.until)}. Devolvemos ${formatBrlAmount(refund.amount)} e o Pro termina na hora.`;
}

/** The dialog of the refund (AC-34): the amount and the effect, with no promise of when the money arrives. */
export function refundDialogText(amount: string): DialogText {
  return {
    description: `Você recebe ${formatBrlAmount(amount)} de volta e o Pro acaba agora. Seus dados ficam.`,
    title: "Desistir do Pro e receber o reembolso?",
  };
}

/**
 * The way of Pix while its refund goes to support (AC-30, AC-44, R-1): the last minute of the window, that a request
 * sent until then counts, and only the store's name. The box is the configuration's (`BILLING_SUPPORT_EMAIL`), never
 * the code's: without it the line names the support only.
 */
export function supportRefundText(
  refund: NonNullable<BillingPlanView["refund"]>,
  supportEmail: string | null
): string {
  // the box is at the end of every e-mail of the subscription (`billingEmailFooter`)
  const to =
    supportEmail === null
      ? "o suporte do Polaris (o endereço está no fim dos e-mails da sua assinatura)"
      : supportEmail;
  return `Para desistir e receber o reembolso de ${formatBrlAmount(refund.amount)}, escreva para ${to} até ${untilText(refund.until)} com o nome da loja. O pedido enviado até essa data vale, mesmo que a resposta chegue depois. Não mande CPF, CNPJ nem dados de pagamento.`;
}

/**
 * What the screen says after the provider took the refund (`refund_requested`): with the card, the provider's fact
 * comes back by webhook, and until it does the plan reads as a refund not done (`refundPending`). The screen says the
 * refund was asked, and that it is confirmed once the plan read again has left the Pro; never that the money arrived.
 */
export function refundRequestedText(
  amount: string,
  plan: BillingPlanView | null
): string {
  const confirmed =
    plan !== null &&
    !plan.refundPending &&
    (plan.state === "free" || plan.state === "free_over_limit");
  return confirmed
    ? `Reembolso confirmado: você recebe ${formatBrlAmount(amount)} de volta e o Pro acabou. Seus dados ficam.`
    : `Pedimos o reembolso de ${formatBrlAmount(amount)}. Quando ele for confirmado, o Pro acaba e a loja volta ao Free. Seus dados ficam.`;
}

// ---- pay the charge that failed --------------------------------------------------------------------------------

/**
 * What the screen says before the click and on the way back (AC-43): it pays the charge that failed and does not
 * change the card. The day is the one from which the store may subscribe again (the end of the grace).
 */
export function overdueText(plan: BillingPlanView): string {
  const until =
    plan.accessEndsAt === null ? null : accessDateText(plan.accessEndsAt);
  return until === null
    ? "Isto paga a cobrança que falhou. A próxima renovação ainda tenta o cartão cadastrado. Para usar outro cartão, cancele a renovação e assine de novo quando este período terminar."
    : `Isto paga a cobrança que falhou. A próxima renovação ainda tenta o cartão cadastrado. Para usar outro cartão, cancele a renovação e assine de novo depois de ${until}.`;
}

/** The exact hosts of Asaas's page of a charge (ADR 0104, decision 3): never by suffix. */
const OVERDUE_HOSTS: ReadonlySet<string> = new Set([
  "www.asaas.com",
  "asaas.com",
  "sandbox.asaas.com",
]);

/**
 * Only an https address on an exact host of Asaas, with no credentials and no port, is opened (the server checks
 * the same, and production does not hand out the sandbox's): the second gate.
 */
export function safeOverduePaymentUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      OVERDUE_HOSTS.has(url.hostname) &&
      url.username === "" &&
      url.password === "" &&
      url.port === ""
      ? url.href
      : null;
  } catch {
    return null;
  }
}

// ---- the refusals ----------------------------------------------------------------------------------------------

const CONNECTION_TEXT =
  "A conexão falhou antes da resposta. Confira a conexão e tente de novo: o pedido não é feito duas vezes.";

const PROVIDER_TEXT: Readonly<Record<OwnerCommand, string>> = {
  // AC-26
  cancel:
    "Não conseguimos cancelar agora. Nada foi cancelado e nada foi cobrado a mais. Tente de novo.",
  overdue:
    "Não conseguimos abrir a página de pagamento agora. Nada foi cobrado. Tente de novo em alguns minutos.",
  // never "Nada foi cancelado" (AS-42): on a repeat the renewal is already cancelled
  refund:
    "Não conseguimos pedir o reembolso agora. Nada foi cobrado a mais. Tente de novo.",
};

/**
 * The text of each refusal of the owner's commands, by its reason (ADR 0104, decision 3): "Tentar de novo" when the
 * same request may still work (repeating the same request ID is safe), "Atualizar" when the plan has changed.
 */
export function commandRefusal(command: OwnerCommand, error: unknown): Refusal {
  if (isConnectionFailure(error)) {
    return { reread: false, retry: true, text: CONNECTION_TEXT };
  }
  switch (rpcErrorReason(error)) {
    case "command_in_progress":
      return {
        reread: false,
        retry: true,
        // the lock is the store's, and one per isolate: it may be another store's request
        text: "Já tem um pedido em andamento. Espere alguns segundos e tente de novo.",
      };
    case "billing_command_rate_limited":
      return {
        reread: false,
        retry: true,
        // 1 every 30 s and 10 an hour (ADR 0104): no promise of how long
        text: "Muitas tentativas seguidas. Espere um pouco e tente de novo.",
      };
    case "billing_audit_unavailable":
      // the act was done: the screen does not say it failed, and the same request ID confirms it
      return {
        reread: false,
        retry: true,
        text: "Não conseguimos confirmar o pedido. Tente de novo: ele não é feito duas vezes.",
      };
    case "billing_provider_unavailable":
      return { reread: false, retry: true, text: PROVIDER_TEXT[command] };
    case "nothing_to_cancel":
      return {
        reread: true,
        retry: false,
        text: "Não há renovação para cancelar. Atualize para ver o plano.",
      };
    case "nothing_to_refund":
      return {
        reread: true,
        retry: false,
        text: "Não há valor a reembolsar: o prazo de 7 dias terminou ou o reembolso já foi feito. Atualize para ver o plano.",
      };
    case "refund_via_support":
      return {
        reread: true,
        retry: false,
        text: "O reembolso do Pix Automático é pedido ao suporte. Atualize para ver como pedir.",
      };
    case "refund_window_expired":
      return {
        reread: true,
        retry: false,
        text: "O prazo para concluir o reembolso pelo app terminou. O nosso suporte conclui o reembolso. Atualize para ver o plano.",
      };
    case "no_overdue_payment":
      return {
        reread: true,
        retry: false,
        text: "Não há cobrança pendente para pagar aqui. Atualize para ver o plano.",
      };
    case "billing_manage_required":
      return {
        reread: false,
        retry: false,
        text: "Só o dono da loja pode ver e mudar a assinatura.",
      };
    case "billing_not_configured":
    case "billing_self_service_off":
      return {
        reread: false,
        retry: false,
        text: "A assinatura pelo app não está disponível agora. Nada foi cobrado. Tente mais tarde.",
      };
    default:
      break;
  }
  if (rpcErrorCode(error) === "BAD_REQUEST") {
    // the dialog stays open with what was typed
    return {
      reread: false,
      retry: true,
      text: "O motivo tem caracteres que não conseguimos guardar. Mude o texto ou apague-o e tente de novo.",
    };
  }
  if (rpcErrorCode(error) === "SERVICE_UNAVAILABLE") {
    return { reread: false, retry: true, text: PROVIDER_TEXT[command] };
  }
  return {
    reread: true,
    retry: false,
    text: "Não foi possível concluir o pedido agora. Atualize e tente de novo.",
  };
}

/** An address of the page of the charge out of Asaas's exact hosts: said as the provider's failure. */
export function unsafeOverdueRefusal(): Refusal {
  return { reread: false, retry: true, text: PROVIDER_TEXT.overdue };
}
