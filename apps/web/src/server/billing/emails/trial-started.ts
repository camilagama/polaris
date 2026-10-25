import type { BillingCycleMonths } from "@polaris/domain/billing/facts";
import type { PlanMethod } from "@polaris/domain/billing/plan-view";
import {
  type BillingEmailStore,
  type BillingNoticeContent,
  openSubscription,
} from "./content";
import {
  amountText,
  calendarDay,
  cycleText,
  daysBetween,
  daysText,
  methodText,
} from "./format";

/** E-A: the trial began (the method is ready). */
export interface TrialStartedEmail {
  amount: string;
  cycleMonths: BillingCycleMonths;
  /** The day of the first charge set at the provider (YYYY-MM-DD): the e-mail speaks only of it, never of the trial's end. */
  firstChargeOn: string;
  method: PlanMethod;
  store: BillingEmailStore;
  /** The local day the notice was recorded (YYYY-MM-DD). */
  today: string;
}

/**
 * The text of the corte. The days of Pro are counted to the first charge (a Pix approved late has fewer than 7), and
 * when the first charge is today the e-mail says so (emenda t268, AC-4) and promises no days.
 */
export function trialStartedContent(
  email: TrialStartedEmail
): BillingNoticeContent {
  const { store } = email;
  const days = daysBetween(email.today, email.firstChargeOn);
  const charge = `${amountText(email.amount)} ${cycleText(email.cycleMonths)}`;
  const date = calendarDay(email.firstChargeOn);
  const method = methodText(email.method);
  const chargeToday = days === 0;
  // with the first charge today there is no trial to speak of: the Pro began (Petković, 24/10, T329-1)
  const title = chargeToday
    ? "Seu Polaris Pro começou"
    : "Seu teste do Polaris Pro começou";
  return {
    action: openSubscription(store),
    footer: "subscription",
    heading: title,
    paragraphs: chargeToday
      ? [
          `O plano Pro começou na loja ${store.name}. A primeira cobrança, de ${charge}, é hoje, ${date}, ${method}. Se não quiser continuar, cancele a renovação em Assinatura antes da cobrança: nada é cobrado. Se continuar, você ainda pode desistir em até 7 dias depois da primeira cobrança e receber o valor de volta.`,
        ]
      : [
          `Seu teste grátis do plano Pro começou na loja ${store.name}. Você usa tudo o que o Pro tem por ${daysText(days)}. A primeira cobrança, de ${charge}, é em ${date}, ${method}. Se não quiser continuar, cancele a renovação em Assinatura antes dessa data: nada é cobrado. Se continuar, você ainda pode desistir em até 7 dias depois da primeira cobrança e receber o valor de volta.`,
        ],
    preview: chargeToday
      ? `A primeira cobrança da loja ${store.name} é hoje.`
      : `Você tem ${daysText(days)} de Pro na loja ${store.name}.`,
    subject: title,
    summary: null,
  };
}
