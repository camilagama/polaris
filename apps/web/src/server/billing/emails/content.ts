/**
 * What one e-mail of the billing cycle says (corte `emails-ciclo-cobranca`, drafts of the texts; design t268 v2, §9):
 * the subject, the preview, the paragraphs and the one button, to the app's own screens with an absolute address and
 * no tracking parameter (AC-16). The texts are the corte's; each kind has its file next to this one.
 */

export interface BillingEmailLink {
  label: string;
  url: string;
}

export interface BillingNoticeContent {
  /** The button; the e-mail also writes its address in full, in case the button fails. */
  action: BillingEmailLink;
  /** A block of its own with a second button (E-D, only with the store over the Free limit). */
  extra: { action: BillingEmailLink; paragraphs: string[] } | null;
  /** The footer of a notice about the subscription, or the welcome's (E1 is not about a subscription). */
  footer: "subscription" | "welcome";
  /** The subject with the store's whole name, the heading of the body. */
  heading: string;
  paragraphs: string[];
  preview: string;
  /** At most 60 characters: the store's name in it is cut at 24 (AC-17). */
  subject: string;
}

/** What every e-mail of the cycle reads of the store and the app. */
export interface BillingEmailStore {
  /** The origin of the app (`https`, or `http` on localhost): the buttons lead to its screens. */
  appOrigin: string;
  name: string;
  timeZone: string;
}

/** The subscription screen (Assinatura), where every billing e-mail leads. */
export function subscriptionUrl(appOrigin: string): string {
  return `${new URL(appOrigin).origin}/subscription`;
}

/** The products screen: the welcome's button, until the short product form has an address of its own (AC-27). */
export function productsUrl(appOrigin: string): string {
  return `${new URL(appOrigin).origin}/products`;
}

/**
 * Where the owner chooses the variants that go on (AC-15). The screen of the choice does not exist yet: until it does,
 * the button leads to Assinatura.
 */
export function variantChoiceUrl(appOrigin: string): string {
  return subscriptionUrl(appOrigin);
}

export const OPEN_SUBSCRIPTION = "Abrir a assinatura";

export function openSubscription(store: BillingEmailStore): BillingEmailLink {
  return { label: OPEN_SUBSCRIPTION, url: subscriptionUrl(store.appOrigin) };
}

/** What changes on Free, as RN:9, RN:14 and the lines after them say (AC-13), in the present and in the past. */
export const FREE_CHANGES =
  "o catálogo público sai do ar, a escrita sem internet desliga e as metas acima de 1 ficam pausadas";
export const FREE_CHANGED =
  "o catálogo público saiu do ar, a escrita sem internet desligou e as metas acima de 1 ficam pausadas";
