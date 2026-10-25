import type { PlanMethod } from "@polaris/domain/billing/plan-view";
import {
  type BillingEmailStore,
  type BillingNoticeContent,
  openSubscription,
} from "./content";
import { amountText, calendarDay, methodText } from "./format";

/** The yearly renewal, 7 days ahead (Q-E1, ADR 0104, decision 7). */
export interface AnnualRenewalReminderEmail {
  amount: string;
  /** The day the renewal is charged (YYYY-MM-DD). */
  chargeOn: string;
  method: PlanMethod;
  store: BillingEmailStore;
}

/** "The text of E-B adjusted (amount, date and method)", as ADR 0104 asks; approved by Petković (24/10, 20:31). */
export function annualRenewalReminderContent(
  email: AnnualRenewalReminderEmail
): BillingNoticeContent {
  const { store } = email;
  const amount = amountText(email.amount);
  const date = calendarDay(email.chargeOn);
  const subject = `Em 7 dias o Polaris Pro será renovado: ${amount}`;
  return {
    action: openSubscription(store),
    footer: "subscription",
    heading: subject,
    paragraphs: [
      `Em 7 dias, ${date}, fazemos a renovação anual do Pro da loja ${store.name}: ${amount} por ano, ${methodText(email.method)}.`,
      "Quer continuar? Não precisa fazer nada. Quer parar? Cancele a renovação em Assinatura antes disso e nada será cobrado.",
    ],
    preview: `A renovação anual da loja ${store.name} é em 7 dias.`,
    subject,
    summary: null,
  };
}
