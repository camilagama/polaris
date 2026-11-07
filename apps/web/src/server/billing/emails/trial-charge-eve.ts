import type { BillingCycleMonths } from "@polaris/domain/billing/facts";
import type { PlanMethod } from "@polaris/domain/billing/plan-view";
import {
  type BillingEmailStore,
  type BillingNoticeContent,
  openSubscription,
} from "./content";
import { amountText, calendarDay, cycleText, methodText } from "./format";

/** E-B: the eve of the first charge. */
export interface TrialChargeEveEmail {
  amount: string;
  cycleMonths: BillingCycleMonths;
  /** The day of the first charge set at the provider (YYYY-MM-DD), tomorrow in the store's calendar. */
  firstChargeOn: string;
  method: PlanMethod;
  store: BillingEmailStore;
}

/** The text of the corte: it speaks of the first charge, never of the trial's end. */
export function trialChargeEveContent(
  email: TrialChargeEveEmail
): BillingNoticeContent {
  const { store } = email;
  const amount = amountText(email.amount);
  const subject = `Amanhã o Polaris Pro será cobrado: ${amount}`;
  return {
    action: openSubscription(store),
    footer: "subscription",
    heading: subject,
    paragraphs: [
      `Amanhã, ${calendarDay(email.firstChargeOn)}, fazemos a primeira cobrança do Pro da loja ${store.name}: ${amount} ${cycleText(email.cycleMonths)}, ${methodText(email.method)}.`,
      "Quer continuar? Não precisa fazer nada. Quer parar? Cancele a renovação em Assinatura antes disso e nada será cobrado.",
      "Depois da cobrança você ainda pode desistir em até 7 dias e receber o valor de volta.",
    ],
    preview: `A primeira cobrança da loja ${store.name} é amanhã.`,
    subject,
    summary: null,
  };
}
