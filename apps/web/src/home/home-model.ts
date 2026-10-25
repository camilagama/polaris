import type { GoalReadModel, PeriodSummaryReadModel } from "@polaris/contracts";
import { hasCapabilityForRole } from "@polaris/domain/authorization/capabilities";
import { Money } from "@polaris/domain/money/money";
import { groupGoals } from "../dashboard/goal-model";
import { calendarDayInTimezone } from "../lib/dates";
import { formatBrlAmount, formatQuantity } from "../lib/format";

/**
 * Pure rules of the Início (desenho t269 v2, § 2.4 and § 5): which periods it reads, what "today" is, the series of
 * the miniatures and of the chart, the comparison with the previous month, which goal the card shows, the lines of
 * "Precisa de atenção" and the checklist of a store with no sale. Every figure is the server's; money is added in
 * exact cents (`Money`), never as a float, and the numbers given to a drawing are only for the drawing.
 */

export interface Period {
  from: string;
  to: string;
}

/** What the Início reads of a day: the costs of the day are the Resultado's. */
type Daily = Pick<
  PeriodSummaryReadModel["daily"][number],
  "date" | "netSales" | "salesCount"
>[];

const DAY = 86_400_000;

function utcDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** A calendar day `days` away from `day` (YYYY-MM-DD), with no time zone in the way. */
function addDays(day: string, days: number): string {
  return new Date(utcDate(day).getTime() + days * DAY)
    .toISOString()
    .slice(0, 10);
}

function firstOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function lastOfMonth(day: string): string {
  const date = utcDate(firstOfMonth(day));
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);
}

/**
 * A, the month of `today` from its first to its last day (the same read as the Resultado, rotulado com o nome do
 * mês, AC-6), and B, the days before it that the comparison and the 30 days need: from the first day of the
 * previous month, or from 29 days before today when that is earlier, to the eve of the first day (§ 2.4).
 */
export function homePeriods(today: string): { before: Period; month: Period } {
  const first = firstOfMonth(today);
  const eve = addDays(first, -1);
  const previousFirst = firstOfMonth(eve);
  const thirtyDays = addDays(today, -29);
  return {
    before: {
      from: thirtyDays < previousFirst ? thirtyDays : previousFirst,
      to: eve,
    },
    month: { from: first, to: lastOfMonth(today) },
  };
}

/** The store's today: the date of the server's clock (`generatedAt`) in the store's time zone, never the device's. */
export function storeToday(
  generatedAt: string,
  timezone: string | null
): string {
  return calendarDayInTimezone(new Date(generatedAt), timezone);
}

/**
 * Milliseconds from `now` to the next midnight in the store's time zone (plus a second, so the read after it is
 * already in the new day). `now` is the server's clock as the device estimates it (`generatedAt` plus what passed
 * since the answer), so a device on the wrong time or in another zone does not move the turn of the day.
 */
export function msUntilNextMidnight(
  now: number,
  timezone: string | null
): number {
  const parts = (zone: string | undefined) => {
    const found: Record<string, number> = {};
    for (const part of new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      second: "2-digit",
      timeZone: zone,
    }).formatToParts(new Date(now))) {
      found[part.type] = Number(part.value);
    }
    return found;
  };
  let found: Record<string, number>;
  try {
    found = parts(timezone ?? undefined);
  } catch {
    found = parts(undefined);
  }
  const elapsed =
    (Number(found.hour) * 3600 +
      Number(found.minute) * 60 +
      Number(found.second)) *
      1000 +
    (now % 1000);
  return DAY - elapsed + 1000;
}

/** Re-reading when the tab comes back is limited to once every 30 s (§ 5.1). */
const FOCUS_REFRESH_MS = 30_000;

export function shouldRefreshOnReturn(
  lastReadAt: number,
  now: number
): boolean {
  return now - lastReadAt >= FOCUS_REFRESH_MS;
}

/** The day of a series, or a day with nothing in it (the series of the server has every date of its period). */
function dayOf(series: Daily, date: string) {
  return (
    series.find((entry) => entry.date === date) ?? {
      date,
      netSales: "0.00",
      salesCount: 0,
    }
  );
}

/** Hoje: the item of today in the series of the month (AC-5: the same figures as a period of that day alone). */
export function todayFigures(month: Daily, today: string) {
  return dayOf(month, today);
}

/** The `days` days that end on `today`, from B and A together: the miniature of Hoje (7) and the chart (7 or 30). */
export function lastDays(
  before: Daily,
  month: Daily,
  today: string,
  days: number
): Daily {
  const all = [...before, ...month];
  return Array.from({ length: days }, (_, index) =>
    dayOf(all, addDays(today, index - days + 1))
  );
}

/** The days of the month up to today: the miniature of the Mês. */
export function monthUntilToday(month: Daily, today: string): Daily {
  return month.filter((entry) => entry.date <= today);
}

/** The exact sum of the net sales of some days, as BRL text. */
export function sumNetSales(series: Daily): string {
  return series
    .reduce(
      (total, entry) => total.add(Money.from(entry.netSales)),
      Money.fromMinorUnits(0n)
    )
    .toString();
}

function countSales(series: Daily): number {
  return series.reduce((total, entry) => total + entry.salesCount, 0);
}

/** The number given to a drawing: cents to reais. Only for the drawing; what is written comes from the text. */
export function chartValue(netSales: string): number {
  return Number(Money.from(netSales).minorUnits) / 100;
}

/** "18/10" for "2026-10-18". */
export function shortDate(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
}

/** The best day of a series (the first one with the highest net sales), or null when no day sold anything. */
export function bestDay(series: Daily): Daily[number] | null {
  let best: Daily[number] | null = null;
  for (const entry of series) {
    const cents = Money.from(entry.netSales).minorUnits;
    if (
      cents > 0n &&
      (best === null || cents > Money.from(best.netSales).minorUnits)
    ) {
      best = entry;
    }
  }
  return best;
}

/** "Melhor dia: 18/10, R$ 1.840,00", said once above the chart (§ 5.5). */
export function bestDayText(series: Daily): string | null {
  const best = bestDay(series);
  return best
    ? `Melhor dia: ${shortDate(best.date)}, ${formatBrlAmount(best.netSales)}`
    : null;
}

const MONTH_NAMES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
] as const;

/** "outubro" for a day of October. */
function monthName(day: string): string {
  return MONTH_NAMES[Number(day.slice(5, 7)) - 1] ?? day.slice(0, 7);
}

/** "Outubro": the title of the Mês, the name of the month and never "até hoje" (AC-6). */
export function monthTitle(day: string): string {
  const name = monthName(day);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The line of meaning of the Mês (AC-7): the net sales from the 1st to today against the same days of the previous
 * month (on 31 March, 1 to 28 February), only when both have a sale; never a percent, never over a zero base.
 */
export function monthComparison(
  before: Daily,
  month: Daily,
  today: string
): string | null {
  const day = Number(today.slice(8, 10));
  const previousFirst = firstOfMonth(addDays(firstOfMonth(today), -1));
  const previousLast = lastOfMonth(previousFirst);
  const previousTo = addDays(
    previousFirst,
    Math.min(day, Number(previousLast.slice(8, 10))) - 1
  );
  const current = month.filter(
    (entry) => entry.date >= firstOfMonth(today) && entry.date <= today
  );
  const previous = before.filter(
    (entry) => entry.date >= previousFirst && entry.date <= previousTo
  );
  // the previous month must be whole in B: a short B (an old copy) says nothing instead of comparing with less
  if (
    previous.length !== Math.min(day, Number(previousLast.slice(8, 10))) ||
    countSales(current) === 0 ||
    countSales(previous) === 0
  ) {
    return null;
  }
  const difference = Money.from(sumNetSales(current)).subtract(
    Money.from(sumNetSales(previous))
  ).minorUnits;
  const name = monthName(previousFirst);
  if (difference === 0n) {
    return `Igual ao mesmo período de ${name}`;
  }
  const amount = formatBrlAmount(
    Money.fromMinorUnits(difference < 0n ? -difference : difference).toString()
  );
  return `${amount} a ${difference > 0n ? "mais" : "menos"} que no mesmo período de ${name}`;
}

/** "1 venda", "3 vendas". */
export function salesCountText(count: number): string {
  return `${formatQuantity(count)} ${count === 1 ? "venda" : "vendas"}`;
}

export type GoalView =
  | { goal: GoalReadModel; kind: "active"; others: number }
  | { goal: GoalReadModel; kind: "settled" }
  | { kind: "none" };

/** How many days back a goal that settled is still shown when no other is active (§ 5.3). */
const SETTLED_SHOWN_DAYS = 7;

/**
 * The goal of the card (AC-10, AC-11, § 5.3): the active one that ends first, with how many others there are; with
 * none active, the last one that settled (reached or missed, never a cancelled one) in the last 7 days of the store;
 * otherwise none ("Definir meta"). Reading the goals settles them, so the read is of every status.
 */
export function pickGoal(
  goals: readonly GoalReadModel[],
  today: string,
  timezone: string | null
): GoalView {
  const { active, settled } = groupGoals(goals);
  const [first] = active;
  if (first) {
    return { goal: first, kind: "active", others: active.length - 1 };
  }
  // today and the 6 days before it: 7 days of the store's calendar
  const since = addDays(today, 1 - SETTLED_SHOWN_DAYS);
  const recent = settled.find(
    (goal) =>
      (goal.status === "completed" || goal.status === "missed") &&
      goal.settledAt !== null &&
      storeToday(goal.settledAt, timezone) >= since
  );
  return recent ? { goal: recent, kind: "settled" } : { kind: "none" };
}

/** "de 01/10 a 31/10": the period of a goal (AC-10). */
export function goalPeriodShort(
  goal: Pick<GoalReadModel, "endsOn" | "startsOn">
): string {
  return `de ${shortDate(goal.startsOn)} a ${shortDate(goal.endsOn)}`;
}

/** A page of a list of balances: as many as came, and whether there are more than a page. */
export interface BalancesPage {
  count: number;
  more: boolean;
}

/** "3 variantes", "1 variante", "100 ou mais variantes" (AC-13: a page has 100). */
function variantsText(page: BalancesPage): string {
  if (page.more) {
    return "100 ou mais variantes";
  }
  return `${formatQuantity(page.count)} ${page.count === 1 ? "variante" : "variantes"}`;
}

export interface AttentionLine {
  href: string;
  id: "device" | "unknown-cost" | "without-stock";
  text: string;
}

export interface AttentionInput {
  /** Operations of this device that the server refused (the local summary, ADR 0038). */
  refused: number;
  /** The month's item lines sold with an unknown cost (`quality.itemLinesWithUnknownCost`), null when not read. */
  soldWithoutCost: number | null;
  /** Variants of active products whose cost is unknown (C), null when not read or not readable. */
  unknownCost: BalancesPage | null;
  /** Variants of active products with no stock (S), null when not read or not readable. */
  withoutStock: BalancesPage | null;
}

/** The most lines the block shows (AC-12). */
const MAX_ATTENTION_LINES = 3;

/**
 * The lines of "Precisa de atenção", in the order of AC-12, at most three, each with a real number and the link
 * that resolves it. The payment line (2) waits for the reading of the plan (corte assinatura-e-cancelar). The
 * unknown cost line exists only when the month sold something without a cost **and** the list filtered by it has a
 * variant (AC-14 emendado); its number is the list's.
 */
export function attentionLines(input: AttentionInput): AttentionLine[] {
  const lines: AttentionLine[] = [];
  if (input.refused > 0) {
    lines.push({
      href: "/attention",
      id: "device",
      text:
        input.refused === 1
          ? "1 operação deste aparelho precisa de atenção"
          : `${formatQuantity(input.refused)} operações deste aparelho precisam de atenção`,
    });
  }
  if (
    input.soldWithoutCost !== null &&
    input.soldWithoutCost > 0 &&
    input.unknownCost !== null &&
    input.unknownCost.count > 0
  ) {
    lines.push({
      href: "/inventory?filtro=sem-custo",
      id: "unknown-cost",
      text: `${variantsText(input.unknownCost)} sem custo. Informe para as próximas vendas.`,
    });
  }
  if (input.withoutStock !== null && input.withoutStock.count > 0) {
    lines.push({
      href: "/inventory?filtro=sem-saldo",
      id: "without-stock",
      text: `${variantsText(input.withoutStock)} sem saldo`,
    });
  }
  return lines.slice(0, MAX_ATTENTION_LINES);
}

/** What the checklist of a store with no sale asks next (AC-22, § 5.4). */
export type ChecklistNext =
  | { kind: "product" }
  | { kind: "sale" }
  | { kind: "stock"; productId: string };

/**
 * The next step: with no product, the first one; with a product but no variant with stock (the quantity is
 * optional when registering), "Dar entrada no estoque" on that product's panel; with stock, the first sale.
 */
export function checklistNext(
  firstProductId: string | null,
  hasStock: boolean
): ChecklistNext {
  if (firstProductId === null) {
    return { kind: "product" };
  }
  return hasStock
    ? { kind: "sale" }
    : { kind: "stock", productId: firstProductId };
}

export function checklistLink(next: ChecklistNext): {
  href: string;
  label: string;
} {
  switch (next.kind) {
    case "product":
      return { href: "/products?novo=1", label: "Cadastrar produto" };
    case "stock":
      return {
        href: `/products?produto=${encodeURIComponent(next.productId)}`,
        label: "Dar entrada no estoque",
      };
    default:
      return { href: "/sales", label: "Fazer a 1ª venda" };
  }
}

/** True when neither A nor B counted a sale: only then the Início asks whether the store ever sold (V). */
export function noSaleCounted(
  month: Pick<PeriodSummaryReadModel, "cards">,
  before: Pick<PeriodSummaryReadModel, "cards">
): boolean {
  return month.cards.salesCount === 0 && before.cards.salesCount === 0;
}

/** The reads the Início makes, each only with its capability (§ 2.4); a block whose read is not allowed is not shown. */
export interface HomeReads {
  goals: boolean;
  inventory: boolean;
  report: boolean;
  sales: boolean;
  /**
   * The unknown cost line reads `movingAverageCost` through a filter on it: it follows the rule of that field, today
   * `inventory:read`. A role that reads the stock without the cost (none exists yet) must lose this line too
   * (Rodrigo, PR 281, menor 2).
   */
  unknownCost: boolean;
}

export function homeReads(role: string): HomeReads {
  const can = (capability: string) => hasCapabilityForRole(role, capability);
  return {
    goals: can("goal:manage"),
    inventory: can("inventory:read"),
    report: can("report:read"),
    sales: can("sale:read"),
    unknownCost: can("inventory:read"),
  };
}

/** After this long from the server's read, the copy says its numbers may be out of date (AC-31 emendado: 24 h). */
const COPY_FRESH_MS = 24 * 3_600_000;
/** A device clock this far before the server's read is wrong: nothing of the copy is taken as of today. */
const CLOCK_BEHIND_MS = 5 * 60_000;

/**
 * How the copy stands now (§ 7.2): out of date after 24 h of its read, and today's only on the store's day of the
 * read. Both from the server's clock (`generatedAt`); a device clock before it is wrong, so the copy is neither today's
 * nor vouched for (the "Hoje" and the age use the server's read, never the device's date alone).
 */
export function copyStanding(
  confirmedAt: string,
  readAt: string,
  now: number,
  timezone: string | null
): { stale: boolean; todayShown: boolean } {
  const age = now - Date.parse(confirmedAt);
  const clockBehind = now < Date.parse(readAt) - CLOCK_BEHIND_MS;
  return {
    stale: clockBehind || age > COPY_FRESH_MS,
    todayShown:
      !clockBehind &&
      storeToday(readAt, timezone) ===
        calendarDayInTimezone(new Date(now), timezone),
  };
}

/** The line under the title when the figures are the device's copy (AC-28, AC-31). */
export function copyLine(confirmed: string, stale: boolean): string {
  return stale
    ? `${confirmed}. Estes números podem estar desatualizados.`
    : confirmed;
}

/** The goal of the card without a connection (§ 7.3, emenda (ii) do ADR 0056). */
export type OfflineGoal =
  | { ended: boolean; goal: GoalReadModel; kind: "active" }
  | { goal: GoalReadModel; kind: "settled" }
  | { kind: "online-only" };

/**
 * The goal kept on the device, as it can be told now: an active one is "em andamento" only while today, in the
 * store's zone, is inside its period; after its end it says the result comes with the connection, with no percent.
 * A goal paused by the plan stays as it was read. With no goal kept (or none to show any more), goals are only with
 * a connection: the device cannot know whether one was set elsewhere since.
 */
export function offlineGoal(
  view: GoalView | null,
  today: string,
  timezone: string | null
): OfflineGoal {
  if (view === null) {
    return { kind: "online-only" };
  }
  if (view.kind === "active") {
    return {
      ended: !view.goal.paused && today > view.goal.endsOn,
      goal: view.goal,
      kind: "active",
    };
  }
  if (view.kind === "settled") {
    // the same 7 days as with a connection, counted from today
    const kept = pickGoal([view.goal], today, timezone);
    return kept.kind === "settled" ? kept : { kind: "online-only" };
  }
  return { kind: "online-only" };
}

/** What "Nova venda" says without a connection (AC-30): a promise only when this device can keep a sale now. */
export function newSaleOfflineText(canSellOffline: boolean): string {
  return canSellOffline
    ? "Você pode vender sem internet. A venda é enviada quando a conexão voltar."
    : "Sem internet: para vender é preciso conexão.";
}
