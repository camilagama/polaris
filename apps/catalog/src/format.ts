const PRICE_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;
const LEADING_ZEROS = /^0+(?=\d)/;
const THOUSANDS = /\B(?=(\d{3})+(?!\d))/g;

/**
 * A list price as the visitor reads it ("R$ 1.234,50"). The price arrives as a
 * decimal string from the database and is only re-spelled here, never turned into
 * a number, so nothing is rounded (docs/business-rules/money.md).
 */
export function formatPrice(price: string): string {
  const match = PRICE_PATTERN.exec(price);
  if (!match) {
    return price;
  }
  const whole = (match[1] ?? "0").replace(LEADING_ZEROS, "");
  const cents = (match[2] ?? "").padEnd(2, "0");
  return `R$ ${whole.replace(THOUSANDS, ".")},${cents}`;
}

/** The pieces of a list price ("R$" and "1.234,50"), for a page that sets the symbol apart; null when it is not a price. */
export function priceParts(
  price: string
): { amount: string; symbol: string } | null {
  const text = formatPrice(price);
  return text === price ? null : { amount: text.slice(3), symbol: "R$" };
}

const WHATSAPP_NUMBER = /^[0-9]{10,15}$/;

/**
 * WhatsApp link for a number stored as digits (country code included). The origin is fixed and the number
 * must be 10 to 15 digits, so nothing else can end up in the address; anything else is no link at all.
 * `text` is the message the chat opens with, percent-encoded here.
 */
export function whatsappLink(digits: string, text?: string): string | null {
  if (!WHATSAPP_NUMBER.test(digits)) {
    return null;
  }
  const base = `https://wa.me/${digits}`;
  return text === undefined ? base : `${base}?text=${encodeURIComponent(text)}`;
}

/** The message a visitor sends from a product page: the name and the address of the page, nothing about price or stock. */
export function productQuestion(name: string, pageUrl: string): string {
  return `Olá! Tenho uma pergunta sobre ${name}: ${pageUrl}`;
}

interface Contacts {
  instagram: string | null;
  whatsapp: string | null;
}

/** Whether the store published a way to be asked something (a number that is not a link does not count). */
export function hasContact(contacts: Contacts): boolean {
  return (
    (contacts.whatsapp !== null && whatsappLink(contacts.whatsapp) !== null) ||
    Boolean(contacts.instagram)
  );
}

/** What a price-less variant says: neutral, and it points to a contact only when there is one. */
export function noPriceLabel(contacts: Contacts): string {
  return hasContact(contacts) ? "Preço sob consulta" : "Preço não informado";
}

export function instagramLink(handle: string): string {
  return `https://www.instagram.com/${encodeURIComponent(handle)}/`;
}
