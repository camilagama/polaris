/**
 * The password that shows after the e-mail (identifier-first, design v5.2, amendment of the sign-in cut of
 * 20/10): only the shape of the address is looked at, never the server, so the flow is the same whether the
 * account exists or not. The rule of the region:
 *
 * - an address with a complete shape opens it; an empty field closes it;
 * - an address that stops being complete leaves it as it is (no jump of the layout while correcting);
 * - a password that arrives (a password manager filling both fields) opens it.
 */
const COMPLETE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isCompleteEmail(value: string): boolean {
  return COMPLETE_EMAIL.test(value.trim());
}

/** Whether the region is open after the e-mail became `value`. */
export function openAfterEmail(open: boolean, value: string): boolean {
  if (value.trim() === "") {
    return false;
  }
  return open || isCompleteEmail(value);
}

/** Whether the region is open after the password became `value` (typed, or filled by a manager). */
export function openAfterPassword(open: boolean, value: string): boolean {
  return open || value !== "";
}

export type EmailEnter = "focus-password" | "incomplete";

/**
 * Enter in the e-mail field, before the region opens there is no button to submit: a complete address
 * opens the region and takes the focus to the password; an incomplete one gets the local error (a silent
 * Enter looks like a broken button).
 */
export function emailEnter(value: string): EmailEnter {
  return isCompleteEmail(value) ? "focus-password" : "incomplete";
}
