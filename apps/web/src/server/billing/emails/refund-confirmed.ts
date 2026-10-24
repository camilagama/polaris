import {
  type BillingEmailStore,
  type BillingNoticeContent,
  openSubscription,
} from "./content";
import { amountText } from "./format";

/** E-R: the full refund of the period in force was applied; the Pro ended. */
export interface RefundConfirmedEmail {
  amount: string;
  store: BillingEmailStore;
}

/**
 * The text of the corte without "Nenhuma nova cobrança será feita.": that sentence goes in only after AS-32 passes in
 * the Gate 7 (EM-33). No number of days for the money to come back (AC-33).
 */
export function refundConfirmedContent(
  email: RefundConfirmedEmail
): BillingNoticeContent {
  const { store } = email;
  const amount = amountText(email.amount);
  const subject = `Devolução do Polaris Pro: ${amount}`;
  return {
    action: openSubscription(store),
    extra: null,
    footer: "subscription",
    heading: subject,
    paragraphs: [
      `Pedimos a devolução de ${amount} do plano Pro da loja ${store.name}. O Pro terminou agora e a loja está no plano Free. Seus dados e seu histórico ficam.`,
      "O valor volta para o mesmo meio de pagamento, no prazo do banco ou da operadora do cartão.",
      "Para assinar de novo, abra Assinatura.",
    ],
    preview: `O Pro da loja ${store.name} terminou.`,
    subject,
  };
}
