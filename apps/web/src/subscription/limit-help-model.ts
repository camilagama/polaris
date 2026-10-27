import type { BillingPlanView } from "@polaris/contracts";
import { rpcErrorCode, rpcErrorReason } from "../lib/rpc-error";

/**
 * The limits of the plan a screen meets (corte 1.6): the active variants, the images of the store and the active goals
 * are read with their numbers (`billing.readPlan`); the images of one product and the public catalog have none on the
 * client (the plan's read carries no per-product limit, and the catalog is in the plan or not).
 */
export type LimitSubject =
  | "catalog"
  | "goals"
  | "images"
  | "productImages"
  | "variants";

/** The way to a bigger plan: "Conhecer o Pro" to the Assinatura, or the way to the owner. */
type LimitHelpAction = "ask_owner" | "upgrade";

export interface LimitUsage {
  max: number;
  subject: "goals" | "images" | "variants";
  used: number;
}

export interface LimitHelpView {
  action: LimitHelpAction;
  /** "Você usa N de M…", only when the read of the plan gave both numbers. */
  usage: LimitUsage | null;
}

/** For whom cannot change the plan (AC-5 of the corte 1.6, the 61b's sentence). */
export const LIMIT_ASK_OWNER = "Fale com o dono da loja para mudar o plano.";

/** The refusal of a command by the plan's limit, as the RPC says it: a `CONFLICT` with its own reason. */
export function isLimitReached(error: unknown): boolean {
  return (
    rpcErrorCode(error) === "CONFLICT" &&
    rpcErrorReason(error) === "entitlement_limit_reached"
  );
}

type PlanRead = Pick<BillingPlanView, "limits" | "state" | "usage">;

function usageOf(plan: PlanRead, subject: LimitSubject): LimitUsage | null {
  if (subject !== "goals" && subject !== "images" && subject !== "variants") {
    return null;
  }
  const max = plan.limits[subject];
  return max === null ? null : { max, subject, used: plan.usage[subject] };
}

/**
 * The one rule of what goes with a limit (AC-5 of the corte 1.6, the 61b's generalized), the same in every place:
 * - the billing self-service off: nothing (no Assinatura to name);
 * - whom may not manage the billing: the way to the owner (the plan is not read for them);
 * - the owner of a Free store (or Free over the limit): "Conhecer o Pro", with "Você usa N de M" when the plan has them;
 * - Pro, trial, grace, or a plan that could not be read (`null`): nothing.
 */
export function limitHelpFor(input: {
  billingSelfService: boolean;
  canManageBilling: boolean;
  /** The plan `billing.readPlan` gave, or null when it was not read. */
  plan: PlanRead | null;
  subject: LimitSubject;
}): LimitHelpView | null {
  if (!input.billingSelfService) {
    return null;
  }
  if (!input.canManageBilling) {
    return { action: "ask_owner", usage: null };
  }
  const { plan } = input;
  if (
    plan === null ||
    !(plan.state === "free" || plan.state === "free_over_limit")
  ) {
    return null;
  }
  return { action: "upgrade", usage: usageOf(plan, input.subject) };
}

const SUBJECT_WORDS: Record<LimitUsage["subject"], [string, string]> = {
  goals: ["meta em andamento", "metas em andamento"],
  images: ["imagem", "imagens"],
  variants: ["variante", "variantes"],
};

/** "Você usa 50 de 50 variantes no plano Free." The word agrees with the limit ("1 de 1 meta em andamento"). */
export function limitUsageText(usage: LimitUsage): string {
  const [one, many] = SUBJECT_WORDS[usage.subject];
  const word = usage.max === 1 && usage.used <= 1 ? one : many;
  return `Você usa ${usage.used} de ${usage.max} ${word} no plano Free.`;
}
