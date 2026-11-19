import type { BillingPlanView } from "@polaris/contracts";
import { orpcClient } from "./orpc";
import { subscribePlanUsageChanges } from "./plan-usage-changes";

/** How long a reading of the plan answers whoever asks (the warning is informative: the server is who refuses). */
export const PLAN_READ_TTL_MS = 10_000;

interface PlanReadOptions {
  /** The person asked for a reading of now (a `version` of the screen moved): the memory is not used. */
  fresh?: boolean;
}

export interface PlanRead {
  /** Lets go of every reading and of the reads on their way: the next ask goes to the server. */
  clear: () => void;
  get: (
    organizationId: string,
    options?: PlanReadOptions
  ) => Promise<BillingPlanView>;
  /**
   * A reading that someone else made (the Assinatura) becomes the newest for everyone. `token` is what `begin` gave
   * before that read started: a reading begun before a clear is not kept.
   */
  remember: (
    organizationId: string,
    plan: BillingPlanView,
    token: PlanReadToken
  ) => void;
  /** Marks the start of a read made outside the memory, to hand to `remember` with its answer. */
  begin: () => PlanReadToken;
}

interface PlanReadToken {
  at: number;
  generation: number;
}

interface Kept {
  /** When the read that gave this plan started: the 10 s count from the data, not from its answer. */
  at: number;
  generation: number;
  plan: BillingPlanView;
}

interface Flying {
  generation: number;
  promise: Promise<BillingPlanView>;
}

/**
 * One memory of `billing/readPlan` for the screens that warn near the limit, per store: it answers within the TTL,
 * joins the read already on its way, and nothing is written in the browser. Every read gets a generation when it
 * starts; an answer is kept only if no newer reading is kept and nothing was cleared since it started, so a slow old
 * answer never replaces a newer one nor outlives a write. The key is the store: the session that ends clears all of it,
 * and a different person only comes in by a reload of the page, which starts with nothing.
 */
export function createPlanRead(deps: {
  now: () => number;
  read: (organizationId: string) => Promise<BillingPlanView>;
  ttlMs?: number;
}): PlanRead {
  const ttlMs = deps.ttlMs ?? PLAN_READ_TTL_MS;
  const kept = new Map<string, Kept>();
  const flying = new Map<string, Flying>();
  let generation = 0;
  let clearedAt = 0;

  function keep(organizationId: string, entry: Kept) {
    const current = kept.get(organizationId);
    if (
      entry.generation > clearedAt &&
      entry.generation > (current?.generation ?? 0)
    ) {
      kept.set(organizationId, entry);
    }
  }

  function start(organizationId: string): Promise<BillingPlanView> {
    generation += 1;
    const mine = generation;
    const startedAt = deps.now();
    const promise = deps.read(organizationId).then(
      (plan) => {
        keep(organizationId, { at: startedAt, generation: mine, plan });
        if (flying.get(organizationId)?.generation === mine) {
          flying.delete(organizationId);
        }
        return plan;
      },
      (error: unknown) => {
        if (flying.get(organizationId)?.generation === mine) {
          flying.delete(organizationId);
        }
        throw error;
      }
    );
    flying.set(organizationId, { generation: mine, promise });
    return promise;
  }

  return {
    clear() {
      generation += 1;
      clearedAt = generation;
      kept.clear();
      flying.clear();
    },
    get(organizationId, options = {}) {
      if (options.fresh !== true) {
        const entry = kept.get(organizationId);
        if (entry) {
          // a clock that went back makes the age negative: such a reading is not trusted
          const age = deps.now() - entry.at;
          if (age >= 0 && age <= ttlMs) {
            return Promise.resolve(entry.plan);
          }
          kept.delete(organizationId);
        }
        const joined = flying.get(organizationId);
        if (joined) {
          return joined.promise;
        }
      }
      return start(organizationId);
    },
    begin() {
      generation += 1;
      return { at: deps.now(), generation };
    },
    remember(organizationId, plan, token) {
      keep(organizationId, { ...token, plan });
    },
  };
}

export const planRead = createPlanRead({
  now: () => Date.now(),
  read: (organizationId) => orpcClient.billing.readPlan({ organizationId }),
});

subscribePlanUsageChanges(() => planRead.clear());
