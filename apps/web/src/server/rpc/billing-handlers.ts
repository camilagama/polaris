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
import {
  type BillingRequestAuditType,
  recordBillingRequestAudit,
} from "@polaris/db/tenant-audit";
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
  refundWindowEndedOnOf,
  resubscribeFromOf,
} from "@polaris/domain/billing/plan-view";
import { logger, opaqueId } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import {
  BillingCommandError,
  checkoutPriceOf,
  startCardCheckout,
  startPixCheckout,
} from "../billing/commands";
import {
  type OwnerCommandDependencies,
  type OwnerCommandOutcome,
  OwnerCommandProviderFailure,
  OwnerCommandRefusal,
  ownerCancelRenewal,
  ownerOpenOverduePayment,
  ownerRequestRefund,
} from "../billing/owner-commands";
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
  /** The owner's commands' clocks (the 45 s budget and the 15 s per call); tests give their own. */
  ownerCommandTiming?: Pick<
    OwnerCommandDependencies,
    "elapsedMs" | "timeoutSignal"
  >;
  /** The audit of the owner's billing requests; tests give their own (a failure after the billing, ADR 0104). */
  recordBillingRequestAudit?: typeof recordBillingRequestAudit;
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

/** The errors that mean "try again later", each with the reason the client may show. */
const unavailableReasons: ReadonlyMap<string, string> = new Map([
  ["billing_provider_not_configured", "billing_provider_unavailable"],
  ["previous_checkout_unverified", "previous_checkout_unverified"],
  ["previous_renewal_cancel_unverified", "previous_renewal_cancel_unverified"],
  ["provider_not_found", "billing_provider_unavailable"],
  ["provider_rejected", "billing_provider_unavailable"],
  ["provider_response_malformed", "billing_provider_unavailable"],
  ["provider_unavailable", "billing_provider_unavailable"],
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

/**
 * The 503 of a provider failure or an unverified earlier checkout, counted with its closed reason and the error's own code (never the provider's answer, a
 * provider id or anything of the store) so a spike of one reason shows apart from the other 503s.
 */
function unavailableRefusal(
  reason: string,
  code: string | undefined,
  cause: unknown
): ORPCError<"SERVICE_UNAVAILABLE", { reason: string }> {
  logger.warn("billing_unavailable_refused", { errorCode: code, reason });
  return new ORPCError("SERVICE_UNAVAILABLE", { cause, data: { reason } });
}

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
  const unavailableReason =
    code === undefined ? undefined : unavailableReasons.get(code);
  if (unavailableReason !== undefined) {
    // nothing of the provider's answer: the errors carry only their code
    throw unavailableRefusal(unavailableReason, code, error);
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

/** The refusals and failures of the owner's commands (ADR 0104, decision 3), each with its own reason. */
function ownerCommandRpcError(
  error: unknown,
  fallback: (error: unknown) => never
): never {
  if (error instanceof OwnerCommandRefusal) {
    throw new ORPCError("CONFLICT", {
      cause: error,
      data: { reason: error.code },
    });
  }
  if (error instanceof OwnerCommandProviderFailure) {
    throw unavailableRefusal("billing_provider_unavailable", error.code, error);
  }
  return billingRpcError(error, fallback);
}

/** The audit type a command's refusal or failure names, if it is one of the owner's commands'. */
function auditOfFailure(error: unknown): BillingRequestAuditType | null {
  return error instanceof OwnerCommandRefusal ||
    error instanceof OwnerCommandProviderFailure
    ? error.audit
    : null;
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
                portFor: (other) => portOf(context.bindings, other),
                store,
              },
              { ...checkout, payer: input.payer }
            );
          }
          return await startCardCheckout(
            {
              port,
              // the old link may be the other provider's: its renewal is cancelled before a new checkout
              portFor: (other) => portOf(context.bindings, other),
              store,
            },
            checkout
          );
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
    const port =
      record.firstChargeAt !== null && record.provider !== null
        ? portOrNull(bindings, record.provider)
        : null;
    const refund = refundOfferOf(record, now, port?.refundsEnabled ?? false);
    if (refund !== null && port === null && record.provider !== null) {
      // the offer goes to support because the port is not built: counted, with the provider and nothing of the store
      logger.warn("billing_port_unavailable", { provider: record.provider });
    }
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
      refundPending: refundPendingOf(record),
      refundWindowEndedOn: refundWindowEndedOnOf(record, now),
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

  const recordAudit =
    dependencies.recordBillingRequestAudit ?? recordBillingRequestAudit;

  /**
   * The molde of the owner's three commands (ADR 0104, decision 3). The flag first, so with it off everyone gets the
   * same answer. The tenant transaction authorizes (`billing:manage`, the server's organization; the client's ID is
   * only the context asked for); then, outside it, the billing role runs the command under the store's lock; then a
   * tenant transaction of its own writes the audit of the request with the type the outcome names (one row per
   * request ID and type). An outcome whose audit cannot be written answers `billing_audit_unavailable`, never
   * success: the client repeats with the same request ID, which the command recognizes. A refusal or a failure
   * whose audit is lost still answers what it is.
   */
  /** The tenant transaction of an owner's command: it authorizes and answers the server's organization. */
  const authorizeOwner = async (
    context: BillingRpcContext,
    requestedOrganizationId: string
  ): Promise<string> => {
    try {
      return await dependencies.withTenantRequestContext({
        bindings: context.bindings,
        capability: CAPABILITY,
        operation: (_transaction, identity) =>
          Promise.resolve(identity.organizationId),
        request: context.request,
        requestedOrganizationId,
      });
    } catch (error: unknown) {
      if (error instanceof ORPCError) {
        throw error;
      }
      throw (
        readPlanRefusalOf(error) ??
        billingRpcError(error, dependencies.toRpcError)
      );
    }
  };

  /** The tenant transaction of its own that writes the audit of the request; false when it could not be written. */
  const auditRequest = async (
    context: BillingRpcContext,
    input: {
      eventType: BillingRequestAuditType;
      organizationId: string;
      requestId: string;
      requestedOrganizationId: string;
    }
  ): Promise<boolean> => {
    try {
      await dependencies.withTenantRequestContext({
        bindings: context.bindings,
        capability: CAPABILITY,
        operation: (transaction, identity) =>
          recordAudit(transaction, identity, {
            eventType: input.eventType,
            requestId: input.requestId,
          }),
        request: context.request,
        requestedOrganizationId: input.requestedOrganizationId,
      });
      return true;
    } catch (error: unknown) {
      logger.warn("billing_request_audit_failed", {
        ...describeError(error),
        eventType: input.eventType,
        organizationId: opaqueId(input.organizationId),
      });
      return false;
    }
  };

  /**
   * The molde of the owner's three commands (ADR 0104, decision 3). The flag first, so with it off everyone gets the
   * same answer. The tenant transaction authorizes (`billing:manage`, the server's organization; the client's ID is
   * only the context asked for); then, outside it, the billing role runs the command under the store's lock; then a
   * tenant transaction of its own writes the audit of the request with the type the outcome names (one row per
   * request ID and type). An outcome whose audit cannot be written answers `billing_audit_unavailable`, never
   * success: the client repeats with the same request ID, which the command recognizes. A refusal or a failure
   * whose audit is lost still answers what it is.
   */
  const runOwnerCommand = async <T>(
    context: BillingRpcContext,
    input: { organizationId: string; requestId: string },
    command: (
      commandDependencies: OwnerCommandDependencies,
      organizationId: string,
      requestId: string
    ) => Promise<OwnerCommandOutcome<T>>
  ): Promise<T> => {
    if (!billingSelfServiceEnabled(context.bindings)) {
      throw new ORPCError("NOT_FOUND", {
        data: { reason: "billing_self_service_off" },
      });
    }
    const requestId = input.requestId.toLowerCase();
    const organizationId = await authorizeOwner(context, input.organizationId);
    const connectionString =
      context.bindings.BILLING_HYPERDRIVE?.connectionString;
    if (!connectionString) {
      throw new ORPCError("SERVICE_UNAVAILABLE", {
        data: { reason: "billing_not_configured" },
      });
    }
    const store = createStore(connectionString);
    let outcome: OwnerCommandOutcome<T> | null = null;
    let failure: unknown = null;
    try {
      outcome = await command(
        {
          ...dependencies.ownerCommandTiming,
          portFor: (provider, signal) =>
            portOf(context.bindings, provider, { signal }),
          store,
        },
        organizationId,
        requestId
      );
    } catch (error: unknown) {
      failure = error;
    } finally {
      await store.close().catch(() => undefined);
    }
    const eventType = outcome?.audit ?? auditOfFailure(failure);
    const audited =
      eventType === null ||
      (await auditRequest(context, {
        eventType,
        organizationId,
        requestId,
        requestedOrganizationId: input.organizationId,
      }));
    if (outcome !== null) {
      if (!audited) {
        // the act was done and is in the billing ledger: the client is told it could not be confirmed
        throw new ORPCError("SERVICE_UNAVAILABLE", {
          data: { reason: "billing_audit_unavailable" },
        });
      }
      return outcome.response;
    }
    if (failure instanceof ORPCError) {
      throw failure;
    }
    return ownerCommandRpcError(failure, dependencies.toRpcError);
  };

  const cancelRenewal = implementContract.billing.cancelRenewal.handler(
    async ({ context, input }) => {
      const response = await runOwnerCommand(
        context,
        input,
        (commandDependencies, organizationId, requestId) =>
          ownerCancelRenewal(commandDependencies, {
            organizationId,
            reason: input.reason ?? null,
            requestId,
          })
      );
      return {
        accessEndsAt: response.accessEndsAt?.toISOString() ?? null,
        result: response.result,
      };
    }
  );

  const requestRefund = implementContract.billing.requestRefund.handler(
    async ({ context, input }) => {
      const response = await runOwnerCommand(
        context,
        input,
        (commandDependencies, organizationId, requestId) =>
          ownerRequestRefund(commandDependencies, { organizationId, requestId })
      );
      return {
        amount: response.amount,
        result: response.result,
        until: response.until.toISOString(),
      };
    }
  );

  const openOverduePayment =
    implementContract.billing.openOverduePayment.handler(
      async ({ context, input }) => {
        const response = await runOwnerCommand(
          context,
          input,
          (commandDependencies, organizationId, requestId) =>
            ownerOpenOverduePayment(commandDependencies, {
              organizationId,
              requestId,
            })
        );
        // the payer's page: never logged; the client opens it with `noopener`
        return { handoff: { kind: "redirect" as const, url: response.url } };
      }
    );

  return {
    cancelRenewal,
    openOverduePayment,
    readPlan,
    requestRefund,
    startCheckout,
  };
}
