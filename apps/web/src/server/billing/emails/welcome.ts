import {
  type BillingEmailStore,
  type BillingNoticeContent,
  productsUrl,
} from "./content";
import { subjectStore } from "./format";

/** E1: the welcome, once per person, for the first store. */
export interface WelcomeEmail {
  store: BillingEmailStore;
}

/** One e-mail, no sequence, no sale of the Pro, nothing about selling without internet (AC-27). */
export function welcomeContent(email: WelcomeEmail): BillingNoticeContent {
  const { store } = email;
  return {
    action: {
      label: "Cadastrar o 1º produto",
      url: productsUrl(store.appOrigin),
    },
    extra: null,
    footer: "welcome",
    heading: `Sua loja ${store.name} está aberta no Polaris`,
    paragraphs: [
      `Sua loja ${store.name} está aberta no Polaris. Para começar, cadastre o primeiro produto com o preço e quantos você tem agora. Depois é só fazer a primeira venda.`,
      "O plano Free não pede forma de pagamento.",
    ],
    preview: "Cadastre o primeiro produto para começar a vender.",
    subject: `Sua loja ${subjectStore(store.name)} está aberta no Polaris`,
  };
}
