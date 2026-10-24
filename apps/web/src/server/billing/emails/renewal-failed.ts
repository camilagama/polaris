import {
  lastCoveredDay,
  type RenewalFailedMilestone,
} from "@polaris/domain/billing/notices";
import type { PlanMethod } from "@polaris/domain/billing/plan-view";
import {
  type BillingEmailStore,
  type BillingNoticeContent,
  FREE_CHANGES,
  openSubscription,
} from "./content";
import {
  amountText,
  daysBetween,
  daysText,
  lastDayOf,
  methodText,
  subjectStore,
} from "./format";

/** E-C2: the renewal failed; the store keeps Pro for the days that remain. Three notices: d0, d3 and the day before the end. */
export type RenewalFailedEmail =
  | {
      /** When the access ends (the end of the paid period plus the days of grace). */
      accessEndsAt: Date;
      amount: string;
      method: PlanMethod;
      milestone: "d0";
      store: BillingEmailStore;
    }
  | {
      accessEndsAt: Date;
      milestone: Exclude<RenewalFailedMilestone, "d0">;
      store: BillingEmailStore;
      /** The local day the notice is for (YYYY-MM-DD): the days of Pro that remain, today included, never below 1. */
      today: string;
    };

const AFTER =
  "Depois dessa data a loja volta ao plano Free e seus dados ficam. Abra Assinatura para ver o que fazer.";

export function renewalFailedContent(
  email: RenewalFailedEmail
): BillingNoticeContent {
  const { store } = email;
  const until = lastDayOf(email.accessEndsAt, store.timeZone);
  const common = {
    action: openSubscription(store),
    extra: null,
    footer: "subscription" as const,
  };
  if (email.milestone === "d0") {
    const subject = "O pagamento do Polaris Pro não foi confirmado";
    return {
      ...common,
      heading: subject,
      paragraphs: [
        `Não conseguimos receber ${amountText(email.amount)} da renovação do plano Pro da loja ${store.name}, ${methodText(email.method)}. Seu Pro continua ativo até ${until}.`,
        AFTER,
      ],
      preview: `Seu Pro continua ativo até ${until}.`,
      subject,
    };
  }
  if (email.milestone === "d3") {
    const days = Math.max(
      1,
      daysBetween(
        email.today,
        lastCoveredDay(email.accessEndsAt, store.timeZone)
      ) + 1
    );
    const remaining = `${days === 1 ? "Falta" : "Faltam"} ${daysText(days)} de Pro na loja`;
    return {
      ...common,
      heading: `${remaining} ${store.name}`,
      paragraphs: [
        `O pagamento da renovação do Pro ainda não foi confirmado. Seu Pro vai até ${until}.`,
        AFTER,
      ],
      preview: `Seu Pro vai até ${until}.`,
      subject: `${remaining} ${subjectStore(store.name)}`,
    };
  }
  return {
    ...common,
    heading: `Amanhã o Pro da loja ${store.name} termina`,
    paragraphs: [
      `O pagamento da renovação não foi confirmado e o seu Pro termina amanhã, ${until}.`,
      `Depois, a loja volta ao plano Free: ${FREE_CHANGES}. Seus dados e seu histórico ficam. Abra Assinatura para ver o que fazer.`,
    ],
    preview: `Seu Pro termina amanhã, ${until}.`,
    subject: `Amanhã o Pro da loja ${subjectStore(store.name)} termina`,
  };
}
