import { z } from "zod";

/**
 * The activation funnel as the Admin answers it (corte 2.4, ADR 0071 amended): `GET /api/funnel?weeks=N`, read by the
 * operator in the browser behind Access. Two closed shapes, both strict (a key more fails the parse):
 *
 * - `rawActivationFunnel`: what `admin_read_activation_funnel` returns. The route parses it first, so a database
 *   answer of another shape is refused instead of passed on.
 * - `activationFunnelResponse`: what the route sends. A number the function did not show is `null` with a `reason`,
 *   never 0; a percentage is computed only between two numbers the function showed, and is `null` with the reason of
 *   the missing side otherwise. No store, person, amount or individual date; the only dates are the week starts and
 *   the instant of the read. `internalStoresExcluded` is an exact count, not suppressed: the stores the team marked as
 *   its own, not a customer's activity (ADR 0071 amended).
 */

// The pages run under a CSP without 'unsafe-eval' and the Worker never allows it: no code generation (as in ./index).
z.config({ jitless: true });

/** The smallest group the function shows a count for (k); below it a cell is `suppressed`. */
export const ACTIVATION_FUNNEL_MINIMUM_STORES = 5;
export const ACTIVATION_FUNNEL_TIMEZONE = "America/Sao_Paulo";

const count = z.number().int().nonnegative();
/** A count the function shows is never under k: a smaller one is a regression of the suppression, refused here too. */
const shownCount = z.number().int().min(ACTIVATION_FUNNEL_MINIMUM_STORES);
const weekLabel = z.string().regex(/^\d{4}-W\d{2}$/);
const weekStart = z.iso.date();
const unavailableReason = z.enum(["activation_window_open", "week_not_closed"]);

const rawCell = z.discriminatedUnion("state", [
  z.object({ state: z.literal("shown"), value: shownCount }).strict(),
  z.object({ state: z.literal("suppressed") }).strict(),
  z
    .object({ reason: unavailableReason, state: z.literal("unavailable") })
    .strict(),
]);

const rawWeek = {
  inProgress: z.boolean(),
  week: weekLabel,
  weekStart,
};

const rawBands = z
  .object({
    after7Days: rawCell,
    upTo1Day: rawCell,
    upTo1Hour: rawCell,
    upTo7Days: rawCell,
    upTo10Minutes: rawCell,
  })
  .strict();

const rawRetention = z
  .object({ week2: rawCell, week3: rawCell, week5: rawCell })
  .strict();

export const rawActivationFunnel = z
  .object({
    activeStores: z
      .array(z.object({ ...rawWeek, stores: rawCell }).strict())
      .max(26),
    cohorts: z
      .array(
        z
          .object({
            ...rawWeek,
            activatedIn7Days: rawCell,
            retention: rawRetention,
            stores: rawCell,
            timeToFirstSale: rawBands,
            withFirstProduct: rawCell,
            withFirstSale: rawCell,
            withoutSale: rawCell,
          })
          .strict()
      )
      .max(26),
    generatedAt: z.string(),
    internalStoresExcluded: count,
    k: z.literal(ACTIVATION_FUNNEL_MINIMUM_STORES),
    signups: z
      .array(
        z.object({ ...rawWeek, accounts: rawCell, withStore: rawCell }).strict()
      )
      .max(26),
    timezone: z.literal(ACTIVATION_FUNNEL_TIMEZONE),
    weeks: z.number().int().min(1).max(26),
  })
  .strict();

export type RawActivationFunnel = z.infer<typeof rawActivationFunnel>;
export type RawActivationFunnelCell = z.infer<typeof rawCell>;

/** Why a number is not there: under k on some side (no hint which), or not known yet. */
export const activationFunnelReason = z.enum([
  "suppressed",
  "activation_window_open",
  "week_not_closed",
]);

/** A count: the number the function showed, or `null` with the reason; never 0 in its place. */
const funnelCount = z.union([
  z.object({ reason: z.null(), value: shownCount }).strict(),
  z.object({ reason: activationFunnelReason, value: z.null() }).strict(),
]);

/** A percentage (0 to 100, one decimal) between two numbers shown, or `null` with the reason of the side missing. */
const funnelPercent = z.union([
  z
    .object({
      reason: z.null(),
      value: z.number().min(0).max(100).multipleOf(0.1),
    })
    .strict(),
  z.object({ reason: activationFunnelReason, value: z.null() }).strict(),
]);

const week = {
  inProgress: z.boolean(),
  week: weekLabel,
  weekStart,
};

/** What the numbers leave out, said with them (AC-12 moves to the screen; the JSON says it already). */
export const ACTIVATION_FUNNEL_NOT_COUNTED = Object.freeze({
  internalStores:
    "Lojas internas (de teste, do dono e do time) ficam fora de todos os números de lojas; internalStoresExcluded diz quantas foram criadas na janela.",
  purgedStores: "Lojas já apagadas não entram em nenhum número.",
  signups:
    "Cadastros contam só contas verificadas que ainda existem, e incluem as contas internas (elas não têm marcador).",
} as const);

export const activationFunnelResponse = z
  .object({
    activeStores: z
      .array(z.object({ ...week, stores: funnelCount }).strict())
      .max(26),
    cohorts: z
      .array(
        z
          .object({
            ...week,
            activatedIn7Days: funnelCount,
            percent: z
              .object({
                activatedIn7Days: funnelPercent,
                retentionWeek2: funnelPercent,
                retentionWeek3: funnelPercent,
                retentionWeek5: funnelPercent,
                withFirstProduct: funnelPercent,
                withFirstSale: funnelPercent,
              })
              .strict(),
            retention: z
              .object({
                week2: funnelCount,
                week3: funnelCount,
                week5: funnelCount,
              })
              .strict(),
            stores: funnelCount,
            timeToFirstSale: z
              .object({
                after7Days: funnelCount,
                upTo1Day: funnelCount,
                upTo1Hour: funnelCount,
                upTo7Days: funnelCount,
                upTo10Minutes: funnelCount,
              })
              .strict(),
            withFirstProduct: funnelCount,
            withFirstSale: funnelCount,
            withoutSale: funnelCount,
          })
          .strict()
      )
      .max(26),
    internalStoresExcluded: count,
    minimumStores: z.literal(ACTIVATION_FUNNEL_MINIMUM_STORES),
    notCounted: z
      .object({
        internalStores: z.literal(ACTIVATION_FUNNEL_NOT_COUNTED.internalStores),
        purgedStores: z.literal(ACTIVATION_FUNNEL_NOT_COUNTED.purgedStores),
        signups: z.literal(ACTIVATION_FUNNEL_NOT_COUNTED.signups),
      })
      .strict(),
    signups: z
      .array(
        z
          .object({
            ...week,
            accounts: funnelCount,
            percentWithStore: funnelPercent,
            withStore: funnelCount,
          })
          .strict()
      )
      .max(26),
    timezone: z.literal(ACTIVATION_FUNNEL_TIMEZONE),
    updatedAt: z.iso.datetime(),
    weeks: z.number().int().min(1).max(26),
  })
  .strict();

export type ActivationFunnelResponse = z.infer<typeof activationFunnelResponse>;
export type ActivationFunnelCount = z.infer<typeof funnelCount>;
export type ActivationFunnelPercent = z.infer<typeof funnelPercent>;
