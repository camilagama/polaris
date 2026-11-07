import {
  type BillingEmailStore,
  type BillingNoticeContent,
  FREE_CHANGED,
  openSubscription,
} from "./content";
import { lastDayOf, localDay, subjectStore } from "./format";

/** E-D: the Pro access ended (the days that remained, or a cancelled period), and the store is on Free. */
export interface AccessEndedEmail {
  /** The instant the access ended (the notice's key). */
  endedAt: Date;
  /** Only with the store over the Free limit (`free_over_limit`, AC-15): the real count, the limit and the window's end. */
  overLimit: {
    /** The end of the 7 days to choose the variants that go on. */
    chooseUntil: Date;
    limit: number;
    variants: number;
  } | null;
  store: BillingEmailStore;
}

/**
 * Over the Free limit, the count, the limit and the window's end go in the text, and the one button leads to
 * Assinatura: the screen of the choice of the variants does not exist yet, and the e-mail offers no button to it
 * (AC-15 stays open until that screen exists).
 */
export function accessEndedContent(
  email: AccessEndedEmail
): BillingNoticeContent {
  const { overLimit, store } = email;
  return {
    action: openSubscription(store),
    footer: "subscription",
    heading: `A loja ${store.name} voltou ao plano Free`,
    paragraphs: [
      `O acesso Pro da loja ${store.name} terminou em ${localDay(email.endedAt, store.timeZone)}. A loja está no plano Free. Seus dados e seu histórico continuam aqui.`,
      `O que muda: ${FREE_CHANGED}. Imagens acima do limite do Free ficam guardadas; só não entram novas.`,
      ...(overLimit
        ? [
            `A loja tem ${overLimit.variants} variantes e o plano Free permite ${overLimit.limit}. Nos próximos 7 dias, até ${lastDayOf(overLimit.chooseUntil, store.timeZone)}, você escolhe quais continuam recebendo vendas e entradas de estoque. Depois desse prazo, só dá para aumentar a escolha até o limite.`,
          ]
        : []),
      "Para voltar ao Pro, abra Assinatura.",
    ],
    preview: "Seus dados e seu histórico continuam aqui.",
    subject: `A loja ${subjectStore(store.name)} voltou ao plano Free`,
    summary: null,
  };
}
