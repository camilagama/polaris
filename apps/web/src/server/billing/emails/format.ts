import type { BillingCycleMonths } from "@polaris/domain/billing/facts";
import type { PlanMethod } from "@polaris/domain/billing/plan-view";
import { localDate } from "@polaris/domain/organization/closure-deadlines";
import { formatBrlAmount } from "../../../lib/format";
import { formatCalendarDate } from "../../privacy/closure-notice-email";

/**
 * The pieces of text the e-mails of the billing cycle share (corte `emails-ciclo-cobranca`, variables of the drafts):
 * the dates in the store's calendar, the amount as the record holds it, the cycle and the method. Nothing here reads
 * a clock: the day a notice speaks of is its own (`dueAt`), so a retry renders the same message.
 */

const DAY_MS = 86_400_000;

/** The store's name in a subject: one line, at most 24 characters and "…" (AC-17); the whole name goes in the body. */
export const SUBJECT_STORE_MAX = 24;

export function subjectStore(name: string): string {
  const line = name.replaceAll(/\s+/g, " ").trim();
  // by grapheme, so an emoji made of several code points is never cut in half
  const characters = Array.from(
    new Intl.Segmenter("pt-BR", { granularity: "grapheme" }).segment(line),
    (part) => part.segment
  );
  return characters.length > SUBJECT_STORE_MAX
    ? `${characters.slice(0, SUBJECT_STORE_MAX).join("").trimEnd()}…`
    : line;
}

/** A calendar day (YYYY-MM-DD) as "29 de outubro de 2026". */
export const calendarDay = formatCalendarDate;

/** The day of an instant in the store's calendar, as "29 de outubro de 2026" (AC-12: never in UTC). */
export function localDay(instant: Date, timeZone: string): string {
  return formatCalendarDate(localDate(instant, timeZone));
}

/** The last day an access that ends at `endsAt` still covers, in the store's calendar (it runs up to that instant). */
export function lastDayOf(endsAt: Date, timeZone: string): string {
  return localDay(new Date(endsAt.getTime() - 1), timeZone);
}

/** Whole calendar days from one local day to another (YYYY-MM-DD), negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      DAY_MS
  );
}

/** An amount recorded as exact decimal text ("24.90") as "R$ 24,90". */
export function amountText(value: string): string {
  return formatBrlAmount(value);
}

/** `{ciclo}`: how often the plan is charged. */
export function cycleText(cycleMonths: BillingCycleMonths): string {
  if (cycleMonths === 1) {
    return "por mês";
  }
  return cycleMonths === 12 ? "por ano" : `a cada ${cycleMonths} meses`;
}

/** `{metodo}` (AC-14): where the charge is taken, in the owner's words; never the provider's name. */
export function methodText(method: PlanMethod): string {
  return method === "card"
    ? "no cartão que você cadastrou"
    : "pelo Pix Automático que você autorizou no seu banco";
}

/** `{meio}` of the receipt (E4): how it was paid. */
export function meansText(method: PlanMethod): string {
  return method === "card" ? "pelo cartão" : "pelo Pix Automático";
}

/** "1 dia", "4 dias". */
export function daysText(days: number): string {
  return days === 1 ? "1 dia" : `${days} dias`;
}
