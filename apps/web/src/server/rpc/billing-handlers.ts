import { implement, ORPCError } from "@orpc/server";
import type { BillingProviderPort } from "@polaris/billing/provider-port";
import { type BillingPlanView, polarisContract } from "@polaris/contracts";
import { listBillingPrices } from "@polaris/db/billing-repository";
import {
  createBillingStore,
  type OwnerPlanRecord,
} from "@polaris/db/billing-store";
import {
  type OwnerPlanTenantFacts,
  readOwnerPlanTenantFacts,
} from "@polaris/db/plan-read-repository";
import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import { grantsPro } from "@polaris/domain/billing/entitlements";
import { isBillingCycleMonths } from "@polaris/domain/billing/facts";
import {
  nextChargeOf,
  type PlanMethod,
  planMethodOf,
  recoveryOf,
  refundOfferOf,
  refundPendingOf,
  resubscribeFromOf,
} from "@polaris/domain/billing/plan-view";
import {
  BillingCommandError,
  checkoutPriceOf,
  startCardCheckout,
  startPixCheckout,
} from "../billing/commands";
import { billingSelfServiceEnabled } from "../billing/self-service";
import {
  type BillingPortOptions,
  billingProviderPortOf,
} from "../billing/provider-ports";
import type { WorkerBindings } from "../environment";
import type { withTenantRequestContext } from "../tenant-request-context";

interface BillingRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

export interface BillingRpcOverrides {
  createBillingStore?: typeof createBillingStore;
  listBillingPrices?: typeof listBillingPrices;
  /** The server's clock of the plan's read; tests give their own. */
  now?: () => Date;
  /** The tenant's part of the plan's read; tests give their own. */
  readOwnerPlanTenantFacts?: typeof readOwnerPlanTenantFacts;
  /** The Pix checkout's waits (its minimum answer time); tests give their own. */
  pixTiming?: {
    elapsedMs: () => number;
    sleep: (ms: number) => Promise<void>;
  };
  /** The provider's port; tests give a fake one. */
  providerPortOf?: (
    bindings: WorkerBindings,
    provider: string,
    options?: BillingPortOptions
  ) => BillingProviderPort;
}

interface BillingRpcDependencies extends BillingRpcOverrides {
  toRpcError: (error: unknown) => never;
  withTenantRequestContext: typeof withTenantRequestContext;
}

const CAPABILITY = "billing:manage";

/**
 * The Pix payer's lock and customer key are keyed by the billing payer key (its own secret, ADR 0101): too short, or
 * the session secret reused, is not configured.
 */
function pixPayerKeyConfigured(bindings: WorkerBindings): boolean {
  const payerKey = bindings.BILLING_PAYER_KEY ?? "";
  return payerKey.length >= 32 && payerKey !== bindings.BETTER_AUTH_SECRET;
}

/** The provider errors that mean "try again later", with the code the client may show. */
const unavailableCodes: ReadonlySet<string> = new Set([
  "billing_provider_not_configured",
  "provider_not_found",
  "provider_rejected",
  "provider_response_malformed",
  "provider_unavailable",
]);

/** What the person reads when a refusal needs more than its code (the client may show it as it is). */
const refusalMessages: Readonly<Record<string, string>> = {
  checkout_in_progress:
    "Outro checkout com esse documento está em andamento. Aguarde um instante e tente de novo.",
  checkout_pending_confirmation:
    "Seu pagamento anterior ainda está sendo confirmado. Aguarde alguns minutos e atualize a página antes de abrir um novo checkout.",
  // the same text whatever the reason: it never tells whether the CPF or CNPJ is known
  payer_not_accepted:
    "Não foi possível iniciar o Pix Automático com esses dados. Confira o nome, o CPF ou CNPJ e o e-mail, ou escolha o cartão.",
};

function billingRpcError(
  error: unknown,
  fallback: (error: unknown) => never
): never {
  if (error instanceof BillingCommandError) {
    throw new ORPCError(
      error.code === "cycle_not_offered" ? "BAD_REQUEST" : "CONFLICT",
      {
        cause: error,
        data: {
          reason: error.code,
          ...(error.until ? { until: error.until.toISOString() } : {}),
        },
        ...(Object.hasOwn(refusalMessages, error.code)
          ? { message: refusalMessages[error.code] }
          : {}),
      }
    );
  }
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  if (code !== undefined && unavailableCodes.has(code)) {
    // nothing of the provider's answer: the errors carry only their code
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      cause: error,
      data: { reason: "billing_provider_unavailable" },
    });
  }
  return fallback(error);
}

/**
 * The plan's read tells a member without `billing:manage` why (its own reason, before the client's generic refusal of
 * the session); someone who is not a member and an organization that does not exist get the very same answer.
 */
function readPlanRefusalOf(error: unknown): ORPCError<string, unknown> | null {
  if (!(error instanceof TenantAuthorizationError)) {
    return null;
  }
  if (error.code === "capability_denied") {
    return new ORPCError("FORBIDDEN", {
      cause: error,
      data: { reason: "billing_manage_required" },
    });
  }
  if (error.code === "tenant_access_denied") {
    return new ORPCError("NOT_FOUND", {
      cause: error,
      data: { reason: "organization_not_found" },
    });
  }
  return null;
}

/**
 * The owner starts the Pro subscription (ADR 0101): the card at Asaas, or Pix
 * Automático at Woovi (the payer's name, document and e-mail go to Woovi and
 * nowhere else). Authorization, the
 * organization and the price come from the tenant transaction (the
 * organization is the server's, the price is `billing_prices`'); the trial,
 * the checkout and the link run on the billing role afterwards, outside it, so
 * no tenant transaction waits on the provider.
 */
export function createBillingRpcHandlers(dependencies: BillingRpcDependencies) {
  const implementContract =
    implement(polarisContract).$context<BillingRpcContext>();
  const createStore = dependencies.createBillingStore ?? createBillingStore;
  const listPrices = dependencies.listBillingPrices ?? listBillingPrices;
  const portOf = dependencies.providerPortOf ?? billingProviderPortOf;
  const readTenantFacts =
    dependencies.readOwnerPlanTenantFacts ?? readOwnerPlanTenantFacts;

  const startCheckout = implementContract.billing.startCheckout.handler(
    async ({ context, input }) => {
      try {
        const authorized = await dependencies.withTenantRequestContext({
          bindings: context.bindings,
          capability: CAPABILITY,
          operation: async (transaction, identity) => ({
            ...checkoutPriceOf(
              await listPrices(transaction),
              input.cycleMonths
            ),
            organizationId: identity.organizationId,
            userId: identity.userId,
          }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        const connectionString =
          context.bindings.BILLING_HYPERDRIVE?.connectionString;
        if (!connectionString) {
          throw new ORPCError("SERVICE_UNAVAILABLE", {
            data: { reason: "billing_not_configured" },
          });
        }
        if (
          input.method === "pix_automatic" &&
          !pixPayerKeyConfigured(context.bindings)
        ) {
          throw new ORPCError("SERVICE_UNAVAILABLE", {
            data: { reason: "billing_not_configured" },
          });
        }
        const payerKey = context.bindings.BILLING_PAYER_KEY ?? "";
        const provider = input.method === "pix_automatic" ? "woovi" : "asaas";
        const store = createStore(connectionString, {
          // the checkout of an organization the person's trial reservation left
          discardCheckout: (abandoned) =>
            portOf(context.bindings, abandoned.provider).discardCheckout(
              abandoned.providerRef
            ),
        });
        try {
          const port = portOf(context.bindings, provider);
          const checkout = {
            ...authorized,
            cycleMonths: input.cycleMonths,
            trial: input.trial,
          };
          if (input.method === "pix_automatic") {
            return await startPixCheckout(
              {
                ...dependencies.pixTiming,
                payerKey,
                port,
                store,
              },
              { ...checkout, payer: input.payer }
            );
          }
          return await startCardCheckout({ port, store }, checkout);
        } finally {
          await store.close().catch(() => undefined);
        }
      } catch (error: unknown) {
        if (error instanceof ORPCError) {
          throw error;
        }
        return billingRpcError(error, dependencies.toRpcError);
      }
    }
  );

  /** Whether the provider's port can be built from the Worker's settings; never throws. */
  const portOrNull = (bindings: WorkerBindings, provider: string) => {
    try {
      return portOf(bindings, provider);
    } catch {
      return null;
    }
  };

  /** The methods a checkout may start now: the adapters that are on, never a constant (AS-6). */
  const offeredMethods = (bindings: WorkerBindings): PlanMethod[] => {
    const methods: PlanMethod[] = [];
    if (portOrNull(bindings, "asaas")) {
      methods.push("card");
    }
    if (pixPayerKeyConfigured(bindings) && portOrNull(bindings, "woovi")) {
      methods.push("pix_automatic");
    }
    return methods;
  };

  const planViewOf = (
    bindings: WorkerBindings,
    facts: OwnerPlanTenantFacts,
    record: OwnerPlanRecord,
    now: Date
  ): BillingPlanView => {
    const { values } = facts.entitlements;
    // the port of the record's provider says whether it refunds; one that cannot be built sends the owner to support
    const refundsEnabled =
      record.firstChargeAt !== null && record.provider !== null
        ? (portOrNull(bindings, record.provider)?.refundsEnabled ?? false)
        : false;
    const refund = refundOfferOf(record, now, refundsEnabled);
    const resubscribeFrom = resubscribeFromOf(record);
    return {
      accessEndsAt: record.accessEndsAt?.toISOString() ?? null,
      cycleMonths: record.cycleMonths,
      kept: facts.kept,
      limits: {
        goals: values["goals.active.max"],
        images: values["images.active.max"],
        variants: values["variants.active.max"],
      },
      // a link left on Free (a checkout given up) is no method of the owner's
      method:
        grantsPro(record.state) || record.state === "trial_setup"
          ? planMethodOf(record.provider)
          : null,
      nextCharge: nextChargeOf(record, now),
      offer: {
        methods: offeredMethods(bindings),
        prices: facts.prices.flatMap((price) =>
          price.planId === "pro" && isBillingCycleMonths(price.intervalMonths)
            ? [{ amount: price.amount, cycleMonths: price.intervalMonths }]
            : []
        ),
      },
      recovery: recoveryOf(record),
      refund: refund && {
        amount: refund.amount,
        until: refund.until.toISOString(),
        via: refund.via,
      },
      refundPending: refundPendingOf(record, now),
      renewalCancelled: record.cancelAtPeriodEnd,
      resubscribeFrom: resubscribeFrom?.toISOString() ?? null,
      state: record.state,
      // a running subscription is offered no trial, whatever the person's claim says
      trialAvailable: record.trialAvailable && !grantsPro(record.state),
      usage: facts.usage,
    };
  };

  /**
   * The owner reads the plan (ADR 0104, decision 2). The flag is asked first, so with it off everyone gets the same
   * answer. The tenant transaction authorizes (`billing:manage`, the server's organization) and reads prices,
   * entitlements, usage and what the store keeps; the billing role reads the record and the person's trial
   * afterwards, outside it. A member without the capability is told why; someone who is not a member and an
   * organization that does not exist get the very same answer.
   */
  const readPlan = implementContract.billing.readPlan.handler(
    async ({ context, input }) => {
      if (!billingSelfServiceEnabled(context.bindings)) {
        throw new ORPCError("NOT_FOUND", {
          data: { reason: "billing_self_service_off" },
        });
      }
      try {
        const authorized = await dependencies.withTenantRequestContext({
          bindings: context.bindings,
          capability: CAPABILITY,
          operation: async (transaction, identity) => ({
            facts: await readTenantFacts(transaction, {
              organizationId: identity.organizationId,
            }),
            organizationId: identity.organizationId,
            userId: identity.userId,
          }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        });
        const connectionString =
          context.bindings.BILLING_HYPERDRIVE?.connectionString;
        if (!connectionString) {
          throw new ORPCError("SERVICE_UNAVAILABLE", {
            data: { reason: "billing_not_configured" },
          });
        }
        const store = createStore(connectionString);
        let record: OwnerPlanRecord;
        try {
          record = await store.readOwnerPlan(
            authorized.organizationId,
            authorized.userId
          );
        } finally {
          await store.close().catch(() => undefined);
        }
        return planViewOf(
          context.bindings,
          authorized.facts,
          record,
          dependencies.now?.() ?? new Date()
        );
      } catch (error: unknown) {
        if (error instanceof ORPCError) {
          throw error;
        }
        throw (
          readPlanRefusalOf(error) ??
          billingRpcError(error, dependencies.toRpcError)
        );
      }
    }
  );

  return { readPlan, startCheckout };
}
