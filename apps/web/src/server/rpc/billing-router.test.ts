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
import { payerLockKey } from "../billing/commands";
import type { WorkerBindings } from "../environment";
import type { TenantRequestContextInput } from "../tenant-request-context";
import { createRpcRouter } from "./router";

const EIGHT_HEX = /^[\da-f]{8}$/;
const PAYER_CUSTOMER_KEY = /^polaris-payer-[\da-f]{32}$/;
const requestedOrganizationId = "organization-the-client-claims";
const serverOrganizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const sessionUserId = "verified-session-user";
const CHECKOUT_URL = "https://sandbox.asaas.com/checkoutSession/show?id=abc";

const baseBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  BILLING_PAYER_KEY: "b".repeat(32),
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
    hasSubscription: vi.fn(() => Promise.resolve(false)),
    prepareSubscription: vi.fn(() =>
      Promise.resolve({
        checkoutId: "chk-1",
        handoff: { kind: "redirect", url: CHECKOUT_URL },
        providerRef: "chk-1",
      })
    ),
    provider: "asaas",
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
    withPayerLock: vi.fn((_bucket: string, operation: () => Promise<unknown>) =>
      operation()
    ),
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
  // the Pix answer waits 3 s at least; the test's clock never moves and its sleep is instant
  const pixTiming = {
    elapsedMs: vi.fn(() => 0),
    sleep: vi.fn((_ms: number) => Promise.resolve()),
  };
  const router = createRpcRouter({
    billing: {
      createBillingStore,
      listBillingPrices,
      pixTiming,
      providerPortOf,
    },
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
    pixTiming,
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
      ["a Pix Automático with no payer", { method: "pix_automatic" }],
      ["a method Polaris does not offer", { method: "boleto" }],
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

  it("answers a conflict with the date the paid access ends when the renewal was cancelled", async () => {
    const fixture = setup({
      storeOverrides: {
        readRecord: vi.fn(() =>
          Promise.resolve({
            accessEndsAt: new Date("2026-11-14T12:00:00.000Z"),
            cancelAtPeriodEnd: true,
            state: "active",
          })
        ),
      },
    });

    await expect(
      fixture.client.billing.startCheckout(valid)
    ).rejects.toMatchObject({
      code: "CONFLICT",
      data: {
        reason: "renewal_cancelled_until",
        until: "2026-11-14T12:00:00.000Z",
      },
    });
    expect(fixture.port.prepareSubscription).not.toHaveBeenCalled();
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

const PAYER = {
  email: "pagador.pix@example.com",
  name: "Pagador Pix de Teste",
  taxId: "52998224725",
};
const EMV = "00020126580014br.gov.bcb.pix0136SECRET-EMV6304ABCD";
const AUTH_URL = "https://woovi-sandbox.com/pay/authorization";
const pix = {
  cycleMonths: 12,
  method: "pix_automatic",
  organizationId: requestedOrganizationId,
  payer: PAYER,
  trial: true,
};

function wooviSetup(options: Parameters<typeof setup>[0] = {}) {
  return setup({
    ...options,
    portOverrides: {
      prepareSubscription: vi.fn(() =>
        Promise.resolve({
          checkoutId: "woovi-chk-1",
          handoff: { emv: EMV, kind: "pix_authorization", url: AUTH_URL },
          providerRef: "woovi-ref-1",
        })
      ),
      provider: "woovi",
      ...options.portOverrides,
    } as Partial<BillingProviderPort>,
  });
}

describe("billing.startCheckout by Pix Automático", () => {
  it("accepts a valid payer, asks for the Woovi port, and hands the Pix over", async () => {
    const fixture = wooviSetup();

    await expect(fixture.client.billing.startCheckout(pix)).resolves.toEqual({
      handoff: { emv: EMV, kind: "pix_authorization", url: AUTH_URL },
    });

    expect(fixture.capabilities).toEqual(["billing:manage"]);
    // the port is asked for with the bindings only: no option carries a question about the organization
    expect(fixture.providerPortOf).toHaveBeenCalledWith(
      billingBindings,
      "woovi"
    );
    expect(fixture.port.prepareSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: "249.00",
        payer: expect.objectContaining({
          customerKey: expect.stringMatching(PAYER_CUSTOMER_KEY),
          email: PAYER.email,
          name: PAYER.name,
          taxId: PAYER.taxId,
        }),
        trial: true,
      })
    );
    expect(
      vi.mocked(fixture.port.prepareSubscription).mock.calls[0]?.[0]
    ).not.toHaveProperty("organizationId");
    expect(fixture.store.attachProvider).toHaveBeenCalledWith(
      serverOrganizationId,
      "woovi",
      "woovi-ref-1"
    );
    expect(fixture.store.close).toHaveBeenCalledTimes(1);
    // the answer waits for the minimum time (here, the instant sleep the test gave)
    expect(fixture.pixTiming.sleep).toHaveBeenCalledWith(3000);
  });

  it.each([
    ["no payer", { payer: undefined }],
    [
      "a tax ID with wrong check digits",
      { payer: { ...PAYER, taxId: "52998224724" } },
    ],
    [
      "a tax ID with punctuation",
      { payer: { ...PAYER, taxId: "529.982.247-25" } },
    ],
    [
      "a tax ID of one repeated digit, punctuated",
      { payer: { ...PAYER, taxId: "111.111.111-11" } },
    ],
    [
      "a tax ID of one repeated digit",
      { payer: { ...PAYER, taxId: "11111111111" } },
    ],
    [
      "a tax ID of the wrong length",
      { payer: { ...PAYER, taxId: "5299822472" } },
    ],
    [
      "an extra key in the payer",
      { payer: { ...PAYER, phone: "11999999999" } },
    ],
    [
      "a payer with no e-mail",
      { payer: { name: PAYER.name, taxId: PAYER.taxId } },
    ],
    ["a tax ID outside the payer, besides it", { taxId: PAYER.taxId }],
  ])(
    "refuses %s with 400, before anything is called",
    async (_label, change) => {
      const fixture = wooviSetup();

      await expect(
        fixture.client.billing.startCheckout({ ...pix, ...change })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      expect(fixture.withTenantRequestContext).not.toHaveBeenCalled();
      expect(fixture.listBillingPrices).not.toHaveBeenCalled();
      expect(fixture.createBillingStore).not.toHaveBeenCalled();
      expect(fixture.providerPortOf).not.toHaveBeenCalled();
      expect(fixture.port.prepareSubscription).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["missing", undefined],
    ["shorter than 32 characters", "a".repeat(31)],
  ])(
    "answers service unavailable (billing_not_configured) when BILLING_PAYER_KEY is %s (the session secret does not stand in), before the store and the port",
    async (_label, secret) => {
      const fixture = wooviSetup({
        bindings: { ...billingBindings, BILLING_PAYER_KEY: secret as never },
      });

      await expect(
        fixture.client.billing.startCheckout(pix)
      ).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        data: { reason: "billing_not_configured" },
      });

      expect(fixture.createBillingStore).not.toHaveBeenCalled();
      expect(fixture.providerPortOf).not.toHaveBeenCalled();
      expect(fixture.port.prepareSubscription).not.toHaveBeenCalled();
    }
  );

  it("answers service unavailable when BILLING_PAYER_KEY is the session secret reused", async () => {
    const fixture = wooviSetup({
      bindings: {
        ...billingBindings,
        BILLING_PAYER_KEY: billingBindings.BETTER_AUTH_SECRET as never,
      },
    });

    await expect(
      fixture.client.billing.startCheckout(pix)
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      data: { reason: "billing_not_configured" },
    });
    expect(fixture.createBillingStore).not.toHaveBeenCalled();
  });

  it("keys the payer's lock with BILLING_PAYER_KEY (not the session secret), never putting the document in it", async () => {
    const fixture = wooviSetup();

    await fixture.client.billing.startCheckout(pix);

    const calls = fixture.store.withPayerLock.mock.calls as unknown as [
      string,
      unknown,
    ][];
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toMatch(EIGHT_HEX);
    expect(calls[0]?.[0]).toBe(await payerLockKey("b".repeat(32), PAYER.taxId));
    expect(calls[0]?.[0]).not.toBe(
      await payerLockKey("a".repeat(32), PAYER.taxId)
    );
  });

  it("does not ask the card checkout for the secret", async () => {
    const fixture = setup({
      bindings: { ...billingBindings, BILLING_PAYER_KEY: undefined as never },
    });

    await expect(fixture.client.billing.startCheckout(valid)).resolves.toEqual({
      handoff: { kind: "redirect", url: CHECKOUT_URL },
    });
  });

  it("refuses the card with a payer, before anything is called", async () => {
    const fixture = setup();

    await expect(
      fixture.client.billing.startCheckout({ ...valid, payer: PAYER })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(fixture.withTenantRequestContext).not.toHaveBeenCalled();
    expect(fixture.providerPortOf).not.toHaveBeenCalled();
  });

  it("answers a conflict with payer_not_accepted and a message in Portuguese, saying nothing of why", async () => {
    const refusal = Object.assign(new Error("payer_data_mismatch"), {
      code: "payer_data_mismatch",
    });
    const fixture = wooviSetup({
      portOverrides: {
        prepareSubscription: vi.fn(() => Promise.reject(refusal)),
      },
    });

    const failure = await fixture.client.billing
      .startCheckout(pix)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "CONFLICT",
      data: { reason: "payer_not_accepted" },
      message: expect.stringContaining(
        "Não foi possível iniciar o Pix Automático"
      ),
    });
    expect(JSON.stringify(failure)).not.toContain(PAYER.taxId);
    expect(fixture.store.attachProvider).not.toHaveBeenCalled();
    expect(fixture.store.close).toHaveBeenCalledTimes(1);
    expect(fixture.pixTiming.sleep).toHaveBeenCalledWith(3000);
  });

  it("answers a conflict with checkout_in_progress when the payer's lock times out", async () => {
    const fixture = wooviSetup({
      storeOverrides: {
        withPayerLock: vi.fn(() =>
          Promise.reject(Object.assign(new Error("lock"), { code: "55P03" }))
        ),
      },
    });

    await expect(
      fixture.client.billing.startCheckout(pix)
    ).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "checkout_in_progress" },
      message: expect.stringContaining("em andamento"),
    });
    expect(fixture.port.prepareSubscription).not.toHaveBeenCalled();
  });
});
