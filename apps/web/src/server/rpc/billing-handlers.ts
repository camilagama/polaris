import { implement, ORPCError } from "@orpc/server";
import type { BillingProviderPort } from "@polaris/billing/provider-port";
import { polarisContract } from "@polaris/contracts";
import { listBillingPrices } from "@polaris/db/billing-repository";
import { createBillingStore } from "@polaris/db/billing-store";
import {
  BillingCommandError,
  checkoutPriceOf,
  startCardCheckout,
  startPixCheckout,
} from "../billing/commands";
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

  const startCheckout = implementContract.billing.startCheckout.handler(
    async ({ context, input }) => {
      try {
        const authorized = await dependencies.withTenantRequestContext({
          bindings: context.bindings,
          capability: CAPABILITY,
          operation: async (transaction, identity) => ({
            amount: checkoutPriceOf(
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
        const payerKey = context.bindings.BILLING_PAYER_KEY ?? "";
        if (
          input.method === "pix_automatic" &&
          (payerKey.length < 32 ||
            payerKey === context.bindings.BETTER_AUTH_SECRET)
        ) {
          // the payer's lock and customer key are keyed by the billing payer key (its own secret, ADR 0101):
          // too short, or the session secret reused, is not configured
          throw new ORPCError("SERVICE_UNAVAILABLE", {
            data: { reason: "billing_not_configured" },
          });
        }
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

  return { startCheckout };
}
