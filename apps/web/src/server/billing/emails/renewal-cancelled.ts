import {
  type BillingEmailStore,
  type BillingNoticeContent,
  FREE_CHANGES,
  openSubscription,
} from "./content";
import { lastDayOf } from "./format";

/**
 * E7: the renewal was cancelled, by the owner or by the provider (the Pix authorization revoked at the bank). The text
 * never says who cancelled (AC-31).
 */
export interface RenewalCancelledEmail {
  /** When the access ends: the trial's end, or the end of what was paid. */
  accessEndsAt: Date;
  /** During the trial, or with the Pro paid. */
  phase: "pro" | "trial";
  store: BillingEmailStore;
}

const NOT_YOU =
  "Se você não reconhece este cancelamento, entre na conta e confira o acesso à loja.";

export function renewalCancelledContent(
  email: RenewalCancelledEmail
): BillingNoticeContent {
  const { store } = email;
  const until = lastDayOf(email.accessEndsAt, store.timeZone);
  return {
    action: openSubscription(store),
    extra: null,
    footer: "subscription",
    heading: "A renovação do Polaris Pro foi cancelada",
    paragraphs:
      email.phase === "trial"
        ? [
            `A renovação do plano Pro da loja ${store.name} foi cancelada. Seu teste continua até ${until} e nada será cobrado.`,
            "Depois dessa data a loja volta ao plano Free; seus dados e seu histórico ficam. O teste grátis vale uma vez por pessoa, então não haverá outro.",
            NOT_YOU,
          ]
        : [
            `A renovação do plano Pro da loja ${store.name} foi cancelada. Seu Pro continua até ${until}, o fim do que você já pagou.`,
            `Depois dessa data a loja volta ao plano Free; seus dados e seu histórico ficam. O que muda no Free: ${FREE_CHANGES}.`,
            `Para assinar de novo, espere essa data. ${NOT_YOU}`,
          ],
    preview:
      email.phase === "trial"
        ? `Seu teste continua até ${until}.`
        : `Seu Pro continua até ${until}.`,
    subject: "A renovação do Polaris Pro foi cancelada",
  };
}
