import type { BillingCycleMonths } from "@polaris/domain/billing/facts";
import {
  type BillingEmailStore,
  type BillingNoticeContent,
  FREE_CHANGES,
  openSubscription,
} from "./content";
import { amountText, cycleText } from "./format";

/** E-C1: the first charge after the trial failed, and the store is on Free. */
export interface FirstChargeFailedEmail {
  amount: string;
  cycleMonths: BillingCycleMonths;
  store: BillingEmailStore;
}

export function firstChargeFailedContent(
  email: FirstChargeFailedEmail
): BillingNoticeContent {
  const { store } = email;
  return {
    action: openSubscription(store),
    footer: "subscription",
    heading: "Não conseguimos cobrar o teste do Polaris Pro",
    paragraphs: [
      `Tentamos cobrar ${amountText(email.amount)} ${cycleText(email.cycleMonths)} no fim do teste da loja ${store.name} e o pagamento não foi confirmado. O Pro não foi ativado e a loja está no plano Free.`,
      `Seus dados e seu histórico continuam aqui. O que muda no Free: ${FREE_CHANGES}.`,
      "Para assinar o Pro, abra Assinatura. O teste grátis vale uma vez por pessoa, então a próxima assinatura é cobrada no mesmo dia.",
    ],
    preview: `O Pro não foi ativado na loja ${store.name}.`,
    subject: "Não conseguimos cobrar o teste do Polaris Pro",
    summary: null,
  };
}
