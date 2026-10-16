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

/** WhatsApp link for a number stored as digits (country code included). */
export function whatsappLink(digits: string): string {
  return `https://wa.me/${digits}`;
}

export function instagramLink(handle: string): string {
  return `https://www.instagram.com/${encodeURIComponent(handle)}/`;
}
