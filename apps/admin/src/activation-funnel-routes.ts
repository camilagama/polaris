import {
  ACTIVATION_FUNNEL_NOT_COUNTED,
  type ActivationFunnelCount,
  type ActivationFunnelPercent,
  type ActivationFunnelResponse,
  activationFunnelResponse,
  type RawActivationFunnel,
  type RawActivationFunnelCell,
  rawActivationFunnel,
} from "@polaris/contracts/admin-activation-funnel";
import type { PlatformCapability } from "@polaris/domain/admin/platform-capabilities";
import { describeError } from "@polaris/observability/wide-event";
import { Hono, type MiddlewareHandler } from "hono";
import type { AdminBindings, AdminEnv } from "./app";

/**
 * The activation funnel in the Admin (corte 2.4, ADR 0071 amended): `GET /api/funnel?weeks=N`, JSON only, read by the
 * operator in the browser behind Access; the screen comes with the Admin's own (Phase 9). It asks for `platform:read`
 * (an aggregate of the platform, no store's), takes nothing but `weeks` (1 to 26: no window or filter to move, so no
 * store is isolated by difference), and reads only through `admin_read_activation_funnel`, which records an event of
 * the operator (no content) in the same transaction as the read. The answer is checked against a closed contract on
 * the way in and on the way out; nothing of it is logged.
 *
 * Every read writes an audit row, so a principal reads at most `ACTIVATION_FUNNEL_READS_PER_HOUR` times in an hour
 * (Rodrigo's condition), a brake on sweeping the function. The Admin has no rate limiter of its own, and the Workers
 * rate-limit binding counts only over 10 or 60 seconds, so the count lives in the isolate: a sliding hour per
 * principal. Two isolates count apart; the audit rows stay the full record either way.
 */

export const ACTIVATION_FUNNEL_READS_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;
const WEEKS = /^[1-9]\d?$/;
const MAX_WEEKS = 26;

export interface ActivationFunnelDependencies {
  /** One audited read through the wrapper; the database's answer as it came (checked here). */
  read: (
    principalId: string,
    weeks: number,
    bindings: AdminBindings
  ) => Promise<unknown>;
}

/** Counts each principal's reads over the last hour; `take` says whether one more is allowed and counts it if so. */
export interface ReadLimiter {
  take: (
    principalId: string
  ) => { allowed: true } | { allowed: false; retryAfterSeconds: number };
}

export function createReadLimiter(
  limit = ACTIVATION_FUNNEL_READS_PER_HOUR,
  now: () => number = Date.now
): ReadLimiter {
  const reads = new Map<string, number[]>();
  return {
    take: (principalId) => {
      const at = now();
      const recent = (reads.get(principalId) ?? []).filter(
        (time) => at - time < HOUR_MS
      );
      if (recent.length >= limit) {
        reads.set(principalId, recent);
        const oldest = recent[0] ?? at;
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((oldest + HOUR_MS - at) / 1000)
          ),
        };
      }
      recent.push(at);
      reads.set(principalId, recent);
      return { allowed: true };
    },
  };
}

/** `weeks` alone, once, an integer from 1 to 26 written plainly; anything else in the query is a 400. */
function weeksOf(url: string): number | null {
  const parameters = new URL(url).searchParams;
  const keys = [...parameters.keys()];
  if (keys.length !== 1 || keys[0] !== "weeks") {
    return null;
  }
  const text = parameters.get("weeks") ?? "";
  if (!WEEKS.test(text)) {
    return null;
  }
  const weeks = Number(text);
  return weeks <= MAX_WEEKS ? weeks : null;
}

function count(cell: RawActivationFunnelCell): ActivationFunnelCount {
  switch (cell.state) {
    case "shown":
      return { reason: null, value: cell.value };
    case "suppressed":
      return { reason: "suppressed", value: null };
    default:
      return { reason: cell.reason, value: null };
  }
}

/** A share of two numbers the function showed, in percent with one decimal; otherwise `null` with the missing side's reason. */
export function percent(
  part: ActivationFunnelCount,
  whole: ActivationFunnelCount
): ActivationFunnelPercent {
  if (part.value === null) {
    return { reason: part.reason, value: null };
  }
  if (whole.value === null) {
    return { reason: whole.reason, value: null };
  }
  if (whole.value === 0 || part.value > whole.value) {
    // the function never shows these; a share that cannot be is not made up
    throw new Error("activation_funnel_inconsistent");
  }
  return {
    reason: null,
    value: Math.round((part.value * 1000) / whole.value) / 10,
  };
}

/** The route's answer from the function's: same numbers, `null` with a reason where there is none, and the shares. */
export function activationFunnelView(
  raw: RawActivationFunnel
): ActivationFunnelResponse {
  const updatedAt = new Date(raw.generatedAt);
  if (Number.isNaN(updatedAt.getTime())) {
    throw new Error("activation_funnel_inconsistent");
  }
  return {
    activeStores: raw.activeStores.map((week) => ({
      inProgress: week.inProgress,
      stores: count(week.stores),
      week: week.week,
      weekStart: week.weekStart,
    })),
    cohorts: raw.cohorts.map((cohort) => {
      const stores = count(cohort.stores);
      const withFirstProduct = count(cohort.withFirstProduct);
      const withFirstSale = count(cohort.withFirstSale);
      const activatedIn7Days = count(cohort.activatedIn7Days);
      const retention = {
        week2: count(cohort.retention.week2),
        week3: count(cohort.retention.week3),
        week5: count(cohort.retention.week5),
      };
      return {
        activatedIn7Days,
        inProgress: cohort.inProgress,
        percent: {
          activatedIn7Days: percent(activatedIn7Days, stores),
          retentionWeek2: percent(retention.week2, stores),
          retentionWeek3: percent(retention.week3, stores),
          retentionWeek5: percent(retention.week5, stores),
          withFirstProduct: percent(withFirstProduct, stores),
          withFirstSale: percent(withFirstSale, stores),
        },
        retention,
        stores,
        timeToFirstSale: {
          after7Days: count(cohort.timeToFirstSale.after7Days),
          upTo1Day: count(cohort.timeToFirstSale.upTo1Day),
          upTo1Hour: count(cohort.timeToFirstSale.upTo1Hour),
          upTo7Days: count(cohort.timeToFirstSale.upTo7Days),
          upTo10Minutes: count(cohort.timeToFirstSale.upTo10Minutes),
        },
        week: cohort.week,
        weekStart: cohort.weekStart,
        withFirstProduct,
        withFirstSale,
        withoutSale: count(cohort.withoutSale),
      };
    }),
    internalStoresExcluded: raw.internalStoresExcluded,
    minimumStores: raw.k,
    notCounted: { ...ACTIVATION_FUNNEL_NOT_COUNTED },
    signups: raw.signups.map((week) => {
      const accounts = count(week.accounts);
      const withStore = count(week.withStore);
      return {
        accounts,
        inProgress: week.inProgress,
        percentWithStore: percent(withStore, accounts),
        week: week.week,
        weekStart: week.weekStart,
        withStore,
      };
    }),
    timezone: raw.timezone,
    updatedAt: updatedAt.toISOString(),
    weeks: raw.weeks,
  };
}

/**
 * The answer to send, or null when the database's is not the closed shape: a key more or less, a count under k, a
 * list that is not one row per week asked for, or numbers no share can be made of. Nothing of it is thrown or logged.
 */
function closedView(
  answer: unknown,
  weeks: number
): ActivationFunnelResponse | null {
  const raw = rawActivationFunnel.safeParse(answer);
  if (
    !raw.success ||
    raw.data.weeks !== weeks ||
    raw.data.cohorts.length !== weeks ||
    raw.data.signups.length !== weeks ||
    raw.data.activeStores.length !== weeks
  ) {
    return null;
  }
  try {
    const view = activationFunnelResponse.safeParse(
      activationFunnelView(raw.data)
    );
    return view.success ? view.data : null;
  } catch {
    return null;
  }
}

export function activationFunnelRoutes(
  dependencies: ActivationFunnelDependencies,
  requireCapability: (
    capability: PlatformCapability
  ) => MiddlewareHandler<AdminEnv>,
  report: (event: string, fields?: Record<string, string>) => void,
  limiter: ReadLimiter = createReadLimiter()
) {
  const routes = new Hono<AdminEnv>();

  routes.onError((error, context) => {
    if (error instanceof Error && error.message === "admin_not_configured") {
      report("admin_not_configured");
      return context.json({ error: "admin_not_configured" }, 503);
    }
    if (
      error instanceof Error &&
      error.message === "activation_funnel_timeout"
    ) {
      report("activation_funnel_timeout");
      return context.json({ error: "unavailable" }, 503);
    }
    report("admin_error", describeError(error));
    return context.json({ error: "internal_error" }, 500);
  });

  routes.get("/funnel", requireCapability("platform:read"), async (context) => {
    const weeks = weeksOf(context.req.url);
    if (weeks === null) {
      return context.json({ error: "invalid_request" }, 400);
    }
    // every read is written down and counted: a link on another site must not spend the operator's reads
    if (context.req.header("sec-fetch-site") === "cross-site") {
      return context.json({ error: "forbidden" }, 403);
    }
    const principalId = context.get("principal").id;
    const turn = limiter.take(principalId);
    if (!turn.allowed) {
      // the operator's id, not a customer's: who is sweeping is what the alert is for
      report("activation_funnel_rate_limited", { principal: principalId });
      context.header("Retry-After", String(turn.retryAfterSeconds));
      return context.json({ error: "rate_limited" }, 429);
    }
    const view = closedView(
      await dependencies.read(principalId, weeks, context.env),
      weeks
    );
    if (view === null) {
      // the shape is closed: an answer of another shape is not passed on, and what it held is not logged
      report("activation_funnel_unexpected_shape");
      return context.json({ error: "internal_error" }, 500);
    }
    return context.json(view);
  });

  return routes;
}
