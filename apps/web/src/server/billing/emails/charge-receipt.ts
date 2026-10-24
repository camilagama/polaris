import type { PlanMethod } from "@polaris/domain/billing/plan-view";
import {
  type BillingEmailStore,
  type BillingNoticeContent,
  openSubscription,
} from "./content";
import { amountText, lastDayOf, localDay, meansText } from "./format";

/** E4: a charge went through; the e-mail is the receipt of the payment (never an invoice, AC-29). */
export interface ChargeReceiptEmail {
  /** The amount really charged (the provider's, or the price the checkout recorded). */
  amount: string;
  method: PlanMethod;
  /** When the charge went through (the provider's moment). */
  paidAt: Date;
  /** The end of the period it paid. */
  periodEndsAt: Date;
  /** Only for the first charge: the last second of the right of withdrawal; a renewal has none (AC-28). */
  refundUntil: Date | null;
  store: BillingEmailStore;
}

export function chargeReceiptContent(
  email: ChargeReceiptEmail
): BillingNoticeContent {
  const { store } = email;
  const amount = amountText(email.amount);
  const paidOn = localDay(email.paidAt, store.timeZone);
  const paidThrough = lastDayOf(email.periodEndsAt, store.timeZone);
  const first = email.refundUntil !== null;
  return {
    action: openSubscription(store),
    extra: null,
    footer: "subscription",
    heading: "Recebemos o pagamento do Polaris Pro",
    paragraphs: [
      first
        ? `Recebemos ${amount} do plano Pro da loja ${store.name}, ${meansText(email.method)}, em ${paidOn}. Seu Pro está pago até ${paidThrough}.`
        : `Recebemos ${amount} da renovação do plano Pro da loja ${store.name}, ${meansText(email.method)}, em ${paidOn}. Seu Pro está pago até ${paidThrough}.`,
      ...(email.refundUntil
        ? [
            `Você pode desistir em até 7 dias depois desta cobrança, até ${localDay(email.refundUntil, store.timeZone)}, e receber o valor de volta: abra Assinatura.`,
          ]
        : []),
      "Este e-mail é o comprovante do pagamento.",
    ],
    preview: `Seu Pro está pago até ${paidThrough}.`,
    subject: "Recebemos o pagamento do Polaris Pro",
  };
}
