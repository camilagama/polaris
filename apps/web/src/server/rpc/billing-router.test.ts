import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  type BillingProviderPort,
  ProviderUnavailableError,
} from "@polaris/billing/provider-port";
import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import { RejectedBillingEventError } from "@polaris/domain/billing/subscription-state";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import type { TenantRequestContextInput } from "../tenant-request-context";
import { createRpcRouter } from "./router";

const requestedOrganizationId = "organization-the-client-claims";
const serverOrganizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const sessionUserId = "verified-session-user";
const CHECKOUT_URL = "https://sandbox.asaas.com/checkoutSession/show?id=abc";

const baseBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

const billingBindings: WorkerBindings = {
  ...baseBindings,
  BILLING_HYPERDRIVE: {
    connectionString: "postgresql://billing.invalid/neondb",
  },
};

const prices = [
  { amount: "24.90", intervalMonths: 1, planId: "pro" },
  { amount: "249.00", intervalMonths: 12, planId: "pro" },
];

type Overrides = NonNullable<Parameters<typeof createRpcRouter>[0]>;

interface BillingClient {
  billing: { startCheckout: (input: unknown) => Promise<unknown> };
}

function setup(
  options: {
    bindings?: WorkerBindings;
    portOverrides?: Partial<BillingProviderPort>;
    storeOverrides?: Record<string, unknown>;
  } = {}
) {
  const capabilities: string[] = [];
  const requested: string[] = [];
  const port = {
    cancelRenewal: vi.fn(),
    discardCheckout: vi.fn(() => Promise.resolve("discarded")),
    prepareSubscription: vi.fn(() =>
      Promise.resolve({
        checkoutId: "chk-1",
        handoff: { kind: "redirect", url: CHECKOUT_URL },
        providerRef: "chk-1",
      })
    ),
    provider: "asaas",
    hasSubscription: vi.fn(() => Promise.resolve(false)),
    readState: vi.fn(),
    refundCurrentPeriod: vi.fn(),
    ...options.portOverrides,
  } as unknown as BillingProviderPort & {
    discardCheckout: ReturnType<typeof vi.fn>;
    prepareSubscription: ReturnType<typeof vi.fn>;
  };
  const store = {
    attachProvider: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    processEvent: vi.fn(() => Promise.resolve({ status: "applied" })),
    readProviderLink: vi.fn(() => Promise.resolve(null)),
    readRecord: vi.fn(() => Promise.resolve(null)),
    recordEvent: vi.fn(() => Promise.resolve({ duplicate: false, id: "ev-1" })),
    startTrial: vi.fn(() => Promise.resolve({})),
    ...options.storeOverrides,
  };
  const createBillingStore = vi.fn(
    (_connection: string, _options?: unknown) => store
  );
  const listBillingPrices = vi.fn(() => Promise.resolve(prices));
  const providerPortOf = vi.fn(() => port);
  const withTenantRequestContext = vi.fn(
    (input: TenantRequestContextInput<unknown>) => {
      capabilities.push(input.capability);
      requested.push(input.requestedOrganizationId);
      return input.operation({} as never, {
        capability: input.capability,
        organizationId: serverOrganizationId,
        role: "owner",
        userId: sessionUserId,
      });
    }
  );
  const router = createRpcRouter({
    billing: { createBillingStore, listBillingPrices, providerPortOf },
    withTenantRequestContext,
  } as unknown as Overrides);
  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) =>
      Promise.resolve(app.fetch(request, options.bindings ?? billingBindings)),
    headers: { origin: "https://polaris.example.invalid" },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  return {
    capabilities,
    client: createORPCClient(link) as unknown as BillingClient,
    createBillingStore,
    listBillingPrices,
    port,
    providerPortOf,
    requested,
    store,
    withTenantRequestContext,
  };
}

const valid = {
  cycleMonths: 12,
  method: "card",
  organizationId: requestedOrganizationId,
  trial: true,
};

describe("billing.startCheckout", () => {
  it("asks for billing:manage on the organization the client names, and hands the link back as a redirect", async () => {
    const fixture = setup();

    await expect(fixture.client.billing.startCheckout(valid)).resolves.toEqual({
      handoff: { kind: "redirect", url: CHECKOUT_URL },
    });

    expect(fixture.capabilities).toEqual(["billing:manage"]);
    expect(fixture.requested).toEqual([requestedOrganizationId]);
  });

  it("acts on the organization and the user of the server's context, never on the input's", async () => {
    const fixture = setup();

    await fixture.client.billing.startCheckout(valid);

    expect(fixture.store.startTrial).toHaveBeenCalledWith(
      serverOrganizationId,
      sessionUserId,
      expect.any(Date)
    );
    expect(fixture.store.attachProvider).toHaveBeenCalledWith(
      serverOrganizationId,
      "asaas",
      "chk-1"
    );
    expect(fixture.store.readRecord).toHaveBeenCalledWith(serverOrganizationId);
    expect(JSON.stringify(fixture.store.startTrial.mock.calls)).not.toContain(
      requestedOrganizationId
    );
  });

  it("charges the price of the cycle from billing_prices, as text, and never anything of the payer", async () => {
    const fixture = setup();

    await fixture.client.billing.startCheckout({ ...valid, cycleMonths: 1 });

    expect(fixture.port.prepareSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ amount: "24.90", cycleMonths: 1 })
    );
    expect(
      fixture.port.prepareSubscription.mock.calls[0]?.[0]
    ).not.toHaveProperty("payer");
  });

  it("does not start a trial when the person did not ask for one", async () => {
    const fixture = setup();

    await fixture.client.billing.startCheckout({ ...valid, trial: false });

    expect(fixture.store.startTrial).not.toHaveBeenCalled();
  });

  it("connects the billing store to the billing connection and closes it after a success", async () => {
    const fixture = setup();

    await fixture.client.billing.startCheckout(valid);

    expect(fixture.createBillingStore).toHaveBeenCalledWith(
      "postgresql://billing.invalid/neondb",
      expect.anything()
    );
    expect(fixture.store.close).toHaveBeenCalledTimes(1);
  });

  it("closes the billing store after a failure too", async () => {
    const fixture = setup({
      storeOverrides: {
        attachProvider: vi.fn(() => Promise.reject(new Error("database down"))),
      },
    });

    await expect(
      fixture.client.billing.startCheckout(valid)
    ).rejects.toBeDefined();

    expect(fixture.store.close).toHaveBeenCalledTimes(1);
  });

  it("does not let a failure to close the store hide the result", async () => {
    const fixture = setup({
      storeOverrides: {
        close: vi.fn(() => Promise.reject(new Error("close"))),
      },
    });

    await expect(fixture.client.billing.startCheckout(valid)).resolves.toEqual({
      handoff: { kind: "redirect", url: CHECKOUT_URL },
    });
  });

  it("gives the store a way to give up the checkout of the organization a trial reservation moved away from", async () => {
    const fixture = setup();

    await fixture.client.billing.startCheckout(valid);

    const options = fixture.createBillingStore.mock.calls[0]?.[1] as {
      discardCheckout: (checkout: {
        provider: string;
        providerRef: string;
      }) => Promise<unknown>;
    };
    await options.discardCheckout({
      provider: "asaas",
      providerRef: "old-ref",
    });
    expect(fixture.providerPortOf).toHaveBeenLastCalledWith(
      billingBindings,
      "asaas"
    );
    expect(fixture.port.discardCheckout).toHaveBeenCalledWith("old-ref");
  });

  describe("strict input (AC-10)", () => {
    it.each([
      ["a card number", { cardNumber: "4444444444444444" }],
      ["a tax ID", { taxId: "52998224725" }],
      ["a payer", { payer: { email: "a@example.com", name: "A" } }],
    ])("refuses %s before anything is called", async (_label, extra) => {
      const fixture = setup();

      await expect(
        fixture.client.billing.startCheckout({ ...valid, ...extra })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      expect(fixture.withTenantRequestContext).not.toHaveBeenCalled();
      expect(fixture.createBillingStore).not.toHaveBeenCalled();
      expect(fixture.providerPortOf).not.toHaveBeenCalled();
    });

    it.each([
      ["a method that is not the card", { method: "pix_automatic" }],
      ["a cycle that does not exist", { cycleMonths: 3 }],
      ["no trial answer", { trial: undefined }],
    ])("refuses %s", async (_label, change) => {
      const fixture = setup();

      await expect(
        fixture.client.billing.startCheckout({ ...valid, ...change })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      expect(fixture.withTenantRequestContext).not.toHaveBeenCalled();
      expect(fixture.port.prepareSubscription).not.toHaveBeenCalled();
    });
  });

  it("refuses a cycle with no active price with its reason, before the provider is called (AC-42)", async () => {
    const fixture = setup();

    await expect(
      fixture.client.billing.startCheckout({ ...valid, cycleMonths: 6 })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "cycle_not_offered" },
    });

    expect(fixture.port.prepareSubscription).not.toHaveBeenCalled();
    expect(fixture.createBillingStore).not.toHaveBeenCalled();
  });

  it.each([
    [new Error("trial_already_used"), "trial_already_used"],
    [new Error("trial_in_progress"), "trial_in_progress"],
    [
      new RejectedBillingEventError(
        "trial_already_consumed",
        "free",
        "start_trial"
      ),
      "trial_already_used",
    ],
  ])(
    "answers a conflict with the reason when the trial is refused (%s)",
    async (failure, reason) => {
      const fixture = setup({
        storeOverrides: { startTrial: vi.fn(() => Promise.reject(failure)) },
      });

      await expect(
        fixture.client.billing.startCheckout(valid)
      ).rejects.toMatchObject({
        code: "CONFLICT",
        data: { reason },
      });
      expect(fixture.port.prepareSubscription).not.toHaveBeenCalled();
      expect(fixture.store.close).toHaveBeenCalledTimes(1);
    }
  );

  it("answers a conflict when the organization already has Pro", async () => {
    const fixture = setup({
      storeOverrides: {
        readRecord: vi.fn(() => Promise.resolve({ state: "active" })),
      },
    });

    await expect(
      fixture.client.billing.startCheckout(valid)
    ).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "already_subscribed" },
    });
  });

  const unconfirmedLink = {
    provider: "asaas",
    providerRef: "chk-old",
    providerSubscriptionId: null,
  };

  it("answers a conflict, with a message the person can read, when the old checkout already made a subscription", async () => {
    const fixture = setup({
      portOverrides: {
        hasSubscription: vi.fn(() => Promise.resolve(true)),
        readState: vi.fn(() =>
          Promise.resolve([
            {
              fact: {
                cycleMonths: 12 as const,
                occurredAt: new Date(),
                type: "trial_method_ready" as const,
              },
              providerEventId: "reconcile:sub_1:CHECKOUT_PAID",
              providerRef: "chk-old",
            },
          ])
        ),
      },
      storeOverrides: {
        readProviderLink: vi.fn(() => Promise.resolve(unconfirmedLink)),
      },
    });

    const failure = await fixture.client.billing
      .startCheckout(valid)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "CONFLICT",
      data: { reason: "checkout_pending_confirmation" },
      message: expect.stringContaining("sendo confirmado"),
    });
    expect(fixture.port.prepareSubscription).not.toHaveBeenCalled();
    expect(fixture.store.attachProvider).not.toHaveBeenCalled();
    expect(fixture.store.recordEvent).toHaveBeenCalledTimes(1);
  });

  it("answers service unavailable when the provider cannot say whether the old checkout was paid", async () => {
    const fixture = setup({
      portOverrides: {
        hasSubscription: vi.fn(() =>
          Promise.reject(new ProviderUnavailableError())
        ),
      },
      storeOverrides: {
        readProviderLink: vi.fn(() => Promise.resolve(unconfirmedLink)),
      },
    });

    await expect(
      fixture.client.billing.startCheckout(valid)
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      data: { reason: "billing_provider_unavailable" },
    });
    expect(fixture.port.prepareSubscription).not.toHaveBeenCalled();
    expect(fixture.store.attachProvider).not.toHaveBeenCalled();
  });

  it("answers service unavailable, with no word of the provider, when the provider cannot be reached", async () => {
    const fixture = setup({
      portOverrides: {
        prepareSubscription: vi.fn(() =>
          Promise.reject(new ProviderUnavailableError())
        ),
      },
    });

    const failure = await fixture.client.billing
      .startCheckout(valid)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      data: { reason: "billing_provider_unavailable" },
    });
    expect(fixture.store.close).toHaveBeenCalledTimes(1);
  });

  it("answers service unavailable when the provider's settings are missing", async () => {
    const fixture = setup();
    fixture.providerPortOf.mockImplementation(() => {
      throw Object.assign(new Error("billing_provider_not_configured"), {
        code: "billing_provider_not_configured",
      });
    });

    await expect(
      fixture.client.billing.startCheckout(valid)
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      data: { reason: "billing_provider_unavailable" },
    });
  });

  it("answers service unavailable when the billing connection is not configured, touching no store", async () => {
    const fixture = setup({ bindings: baseBindings });

    await expect(
      fixture.client.billing.startCheckout(valid)
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      data: { reason: "billing_not_configured" },
    });

    expect(fixture.createBillingStore).not.toHaveBeenCalled();
    expect(fixture.port.prepareSubscription).not.toHaveBeenCalled();
  });

  it.each(["capability_denied", "tenant_access_denied"] as const)(
    "answers forbidden on %s, before any store, port or provider call",
    async (code) => {
      const fixture = setup();
      fixture.withTenantRequestContext.mockImplementation(() =>
        Promise.reject(new TenantAuthorizationError(code))
      );

      await expect(
        fixture.client.billing.startCheckout(valid)
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      expect(fixture.listBillingPrices).not.toHaveBeenCalled();
      expect(fixture.createBillingStore).not.toHaveBeenCalled();
      expect(fixture.providerPortOf).not.toHaveBeenCalled();
      expect(fixture.port.prepareSubscription).not.toHaveBeenCalled();
    }
  );

  it("does not turn an unexpected failure into a reason the client can read", async () => {
    const fixture = setup({
      storeOverrides: {
        attachProvider: vi.fn(() =>
          Promise.reject(new Error("secret internals"))
        ),
      },
    });

    const failure = await fixture.client.billing
      .startCheckout(valid)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(JSON.stringify(failure)).not.toContain("secret internals");
  });
});
