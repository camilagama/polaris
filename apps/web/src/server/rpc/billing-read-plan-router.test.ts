import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { BillingProviderPort } from "@polaris/billing/provider-port";
import { ProviderNotConfiguredError } from "@polaris/billing/provider-port";
import type { OwnerPlanRecord } from "@polaris/db/billing-store";
import type { OwnerPlanTenantFacts } from "@polaris/db/plan-read-repository";
import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import {
  INITIAL_PLAN_CATALOG,
  resolveEntitlements,
} from "@polaris/domain/billing/entitlements";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import type { TenantRequestContextInput } from "../tenant-request-context";
import { createRpcRouter } from "./router";

const requestedOrganizationId = "organization-the-client-claims";
const serverOrganizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const sessionUserId = "verified-session-user";

/** An instant in São Paulo (UTC-3). */
const sp = (local: string) => new Date(`${local}-03:00`);

const bindings: WorkerBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  BILLING_HYPERDRIVE: {
    connectionString: "postgresql://billing.invalid/neondb",
  },
  BILLING_PAYER_KEY: "b".repeat(32),
  BILLING_SELF_SERVICE_ENABLED: "true",
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
};

/** The bindings with the flag set to `flag`, or without it. */
function withFlag(flag: string | undefined): WorkerBindings {
  const { BILLING_SELF_SERVICE_ENABLED: _flag, ...rest } = bindings;
  return flag === undefined
    ? rest
    : { ...rest, BILLING_SELF_SERVICE_ENABLED: flag };
}

function withoutBillingRole(): WorkerBindings {
  const { BILLING_HYPERDRIVE: _role, ...rest } = bindings;
  return rest;
}

/** The keys the read may carry, and nothing else (AS-2): nothing personal and nothing of the provider. */
const PLAN_KEYS = [
  "accessEndsAt",
  "cycleMonths",
  "kept",
  "kept.historyMonths",
  "kept.products",
  "kept.sales",
  "limits",
  "limits.goals",
  "limits.images",
  "limits.variants",
  "method",
  "nextCharge",
  "nextCharge.amount",
  "nextCharge.on",
  "offer",
  "offer.methods",
  "offer.prices",
  "offer.prices.amount",
  "offer.prices.cycleMonths",
  "recovery",
  "refund",
  "refund.amount",
  "refund.until",
  "refund.via",
  "refundPending",
  "renewalCancelled",
  "resubscribeFrom",
  "state",
  "trialAvailable",
  "usage",
  "usage.goals",
  "usage.images",
  "usage.variants",
];

function keysOf(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((item) => keysOf(item, prefix)))];
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  return Object.entries(value).flatMap(([key, inner]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...keysOf(inner, path)];
  });
}

const freeRecord: OwnerPlanRecord = {
  accessEndsAt: null,
  cancelAtPeriodEnd: false,
  cycleMonths: null,
  firstChargeAmount: null,
  firstChargeAt: null,
  firstChargeOn: null,
  priceAmount: null,
  provider: null,
  refundRequestedAt: null,
  revoked: null,
  state: "free",
  trialAvailable: true,
};

/** Paid by card on 10/10 at 15:00 in São Paulo, monthly. */
const activeRecord: OwnerPlanRecord = {
  ...freeRecord,
  accessEndsAt: sp("2026-11-11T00:00:00"),
  cycleMonths: 1,
  firstChargeAmount: "24.90",
  firstChargeAt: sp("2026-10-10T15:00:00"),
  firstChargeOn: "2026-10-10",
  priceAmount: "24.90",
  provider: "asaas",
  state: "active",
  trialAvailable: false,
};

const tenantFacts = (
  overrides: Partial<OwnerPlanTenantFacts> = {}
): OwnerPlanTenantFacts => ({
  entitlements: resolveEntitlements({
    catalog: INITIAL_PLAN_CATALOG,
    facts: { accessEndsAt: null, state: "free" },
    now: sp("2026-10-12T09:00:00"),
  }),
  kept: { historyMonths: 3, products: 12, sales: 140 },
  prices: [
    { amount: "24.90", id: "pro-1", intervalMonths: 1, planId: "pro" },
    { amount: "249.00", id: "pro-12", intervalMonths: 12, planId: "pro" },
  ],
  usage: { goals: 1, images: 9, variants: 31 },
  ...overrides,
});

type Overrides = NonNullable<Parameters<typeof createRpcRouter>[0]>;

interface PlanClient {
  billing: { readPlan: (input: unknown) => Promise<Record<string, unknown>> };
}

function setup(
  options: {
    bindings?: WorkerBindings;
    facts?: OwnerPlanTenantFacts;
    /** The providers whose port can be built, and whether each refunds. */
    ports?: Record<string, { refundsEnabled: boolean }>;
    record?: OwnerPlanRecord;
    refuse?: TenantAuthorizationError;
  } = {}
) {
  const capabilities: string[] = [];
  const requested: string[] = [];
  const ports = options.ports ?? {
    asaas: { refundsEnabled: true },
    woovi: { refundsEnabled: false },
  };
  const store = {
    close: vi.fn(() => Promise.resolve()),
    readOwnerPlan: vi.fn((_organizationId: string, _userId: string) =>
      Promise.resolve(options.record ?? freeRecord)
    ),
  };
  const createBillingStore = vi.fn((_connection: string) => store);
  const readOwnerPlanTenantFacts = vi.fn(
    (_transaction: unknown, _scope: { organizationId: string }) =>
      Promise.resolve(options.facts ?? tenantFacts())
  );
  const providerPortOf = vi.fn(
    (_bindings: WorkerBindings, provider: string) => {
      const port = ports[provider];
      if (!port) {
        throw new ProviderNotConfiguredError();
      }
      return { provider, ...port } as unknown as BillingProviderPort;
    }
  );
  const withTenantRequestContext = vi.fn(
    (input: TenantRequestContextInput<unknown>) => {
      capabilities.push(input.capability);
      requested.push(input.requestedOrganizationId);
      if (options.refuse) {
        return Promise.reject(options.refuse);
      }
      return input.operation({} as never, {
        capability: input.capability,
        organizationId: serverOrganizationId,
        role: "owner",
        userId: sessionUserId,
      });
    }
  );
  const router = createRpcRouter({
    billing: {
      createBillingStore,
      now: () => sp("2026-10-12T09:00:00"),
      providerPortOf,
      readOwnerPlanTenantFacts,
    },
    withTenantRequestContext,
  } as unknown as Overrides);
  const app = createServerApp({ rpcRouter: router });
  const workerBindings = options.bindings ?? bindings;
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, workerBindings)),
    headers: { origin: "https://polaris.example.invalid" },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  const raw = async (organizationId: string) => {
    const response = await app.fetch(
      new Request("https://polaris.example.invalid/rpc/billing/readPlan", {
        body: JSON.stringify({ json: { organizationId } }),
        headers: {
          "content-type": "application/json",
          origin: "https://polaris.example.invalid",
        },
        method: "POST",
      }),
      workerBindings
    );
    return { body: await response.text(), status: response.status };
  };
  return {
    capabilities,
    client: createORPCClient(link) as unknown as PlanClient,
    createBillingStore,
    providerPortOf,
    raw,
    readOwnerPlanTenantFacts,
    requested,
    store,
    withTenantRequestContext,
  };
}

const read = (fixture: ReturnType<typeof setup>) =>
  fixture.client.billing.readPlan({ organizationId: requestedOrganizationId });

describe("billing.readPlan: the flag", () => {
  it.each([undefined, "false", "TRUE", "1"])(
    "with BILLING_SELF_SERVICE_ENABLED %s answers NOT_FOUND billing_self_service_off before anything else",
    async (flag) => {
      const fixture = setup({
        bindings: withFlag(flag),
      });

      await expect(read(fixture)).rejects.toMatchObject({
        code: "NOT_FOUND",
        data: { reason: "billing_self_service_off" },
      });
      expect(fixture.withTenantRequestContext).not.toHaveBeenCalled();
      expect(fixture.createBillingStore).not.toHaveBeenCalled();
    }
  );

  it("with the flag off, the owner, someone who is not a member and an organization that does not exist get the same bytes", async () => {
    const off = { ...bindings, BILLING_SELF_SERVICE_ENABLED: "false" };
    const owner = await setup({ bindings: off }).raw(serverOrganizationId);
    const stranger = await setup({
      bindings: off,
      refuse: new TenantAuthorizationError("tenant_access_denied"),
    }).raw(serverOrganizationId);
    const missing = await setup({
      bindings: off,
      refuse: new TenantAuthorizationError("tenant_access_denied"),
    }).raw("00000000-0000-4000-8000-000000000000");

    expect(owner.status).toBe(404);
    expect(stranger).toEqual(owner);
    expect(missing).toEqual(owner);
  });
});

describe("billing.readPlan: authorization", () => {
  it("asks for billing:manage on the organization the client names, and reads the server's organization and person", async () => {
    const fixture = setup();

    await read(fixture);

    expect(fixture.capabilities).toEqual(["billing:manage"]);
    expect(fixture.requested).toEqual([requestedOrganizationId]);
    expect(fixture.readOwnerPlanTenantFacts.mock.calls[0]?.[1]).toEqual({
      organizationId: serverOrganizationId,
    });
    expect(fixture.store.readOwnerPlan).toHaveBeenCalledWith(
      serverOrganizationId,
      sessionUserId
    );
    expect(fixture.store.close).toHaveBeenCalledTimes(1);
  });

  it("refuses a member without the capability with FORBIDDEN billing_manage_required, reading nothing of billing", async () => {
    const fixture = setup({
      refuse: new TenantAuthorizationError("capability_denied"),
    });

    await expect(read(fixture)).rejects.toMatchObject({
      code: "FORBIDDEN",
      data: { reason: "billing_manage_required" },
    });
    expect(fixture.createBillingStore).not.toHaveBeenCalled();
  });

  it("gives someone who is not a member and an organization that does not exist the very same bytes", async () => {
    const refuse = new TenantAuthorizationError("tenant_access_denied");
    const stranger = await setup({ refuse }).raw(serverOrganizationId);
    const missing = await setup({ refuse }).raw(
      "00000000-0000-4000-8000-000000000000"
    );

    expect(stranger.status).toBe(404);
    expect(JSON.parse(stranger.body)).toMatchObject({
      json: { code: "NOT_FOUND", data: { reason: "organization_not_found" } },
    });
    expect(missing).toEqual(stranger);
  });

  it("tells the member of a closed organization so, as every tenant read does", async () => {
    const fixture = setup({
      refuse: new TenantAuthorizationError("organization_closed"),
    });

    await expect(read(fixture)).rejects.toMatchObject({
      code: "FORBIDDEN",
      data: { reason: "organization_closed" },
    });
  });

  it("without the billing role answers SERVICE_UNAVAILABLE billing_not_configured", async () => {
    const fixture = setup({
      bindings: withoutBillingRole(),
    });

    await expect(read(fixture)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      data: { reason: "billing_not_configured" },
    });
  });
});

describe("billing.readPlan: what it answers", () => {
  it("answers only the keys of the closed list, whatever the record carries (AS-2)", async () => {
    // a store that returned more than the read needs: the reference and the payer never leave
    const leaky = {
      ...activeRecord,
      cancelAtPeriodEnd: false,
      payerEmail: "pessoa@example.com",
      providerRef: "sub_123",
      providerSubscriptionId: "sub_123",
      refundRequestedAt: sp("2026-10-12T08:00:00"),
      state: "active",
    } as OwnerPlanRecord;
    const plan = await read(setup({ record: leaky }));

    expect(keysOf(plan).sort()).toEqual(PLAN_KEYS);
    const text = JSON.stringify(plan);
    for (const secret of ["sub_123", "pessoa@example.com", "asaas", "woovi"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("reads Free from no record: the catalog's limits, the usage, what is kept, the offer and the trial", async () => {
    await expect(read(setup())).resolves.toEqual({
      accessEndsAt: null,
      cycleMonths: null,
      kept: { historyMonths: 3, products: 12, sales: 140 },
      limits: { goals: 1, images: 50, variants: 50 },
      method: null,
      nextCharge: null,
      offer: {
        methods: ["card", "pix_automatic"],
        prices: [
          { amount: "24.90", cycleMonths: 1 },
          { amount: "249.00", cycleMonths: 12 },
        ],
      },
      recovery: null,
      refund: null,
      refundPending: false,
      renewalCancelled: false,
      resubscribeFrom: null,
      state: "free",
      trialAvailable: true,
      usage: { goals: 1, images: 9, variants: 31 },
    });
  });

  it("reads the effective limits, raised by a grant (AS-4)", async () => {
    const facts = tenantFacts({
      entitlements: resolveEntitlements({
        catalog: INITIAL_PLAN_CATALOG,
        facts: { accessEndsAt: null, state: "free" },
        grants: [
          {
            expiresAt: sp("2026-11-01T00:00:00"),
            key: "variants.active.max",
            value: 120,
          },
        ],
        now: sp("2026-10-12T09:00:00"),
      }),
    });

    await expect(read(setup({ facts }))).resolves.toMatchObject({
      limits: { goals: 1, images: 50, variants: 120 },
    });
  });

  it("offers the prices of the catalog as they are: a changed price or a cycle turned off shows at once (AS-5)", async () => {
    const facts = tenantFacts({
      prices: [
        { amount: "29.90", id: "pro-1", intervalMonths: 1, planId: "pro" },
        { amount: "9.90", id: "other", intervalMonths: 1, planId: "free" },
      ],
    });

    await expect(read(setup({ facts }))).resolves.toMatchObject({
      offer: { prices: [{ amount: "29.90", cycleMonths: 1 }] },
    });
  });

  it.each([
    [{ asaas: { refundsEnabled: true } }, bindings, ["card"]],
    [{ woovi: { refundsEnabled: false } }, bindings, ["pix_automatic"]],
    // Pix without its own payer key, or with the session's secret, cannot start: it is not offered
    [
      { woovi: { refundsEnabled: false } },
      { ...bindings, BILLING_PAYER_KEY: "short" },
      [],
    ],
    [
      { woovi: { refundsEnabled: false } },
      { ...bindings, BILLING_PAYER_KEY: "a".repeat(32) },
      [],
    ],
    [{}, bindings, []],
  ])(
    "offers the methods whose adapter is on (AS-6): %j",
    async (ports, workerBindings, methods) => {
      await expect(
        read(setup({ bindings: workerBindings, ports }))
      ).resolves.toMatchObject({ offer: { methods } });
    }
  );

  it("in a trial shows the day of the first charge set at the provider and the recorded price (AS-3)", async () => {
    const record: OwnerPlanRecord = {
      ...freeRecord,
      // a Pix approved on day 2: the end of the trial falls after the charge
      accessEndsAt: sp("2026-10-18T09:00:00"),
      cycleMonths: 1,
      firstChargeOn: "2026-10-17",
      priceAmount: "24.90",
      provider: "woovi",
      state: "trialing",
      trialAvailable: false,
    };

    await expect(read(setup({ record }))).resolves.toMatchObject({
      method: "pix_automatic",
      nextCharge: { amount: "24.90", on: "2026-10-17" },
      refund: null,
      state: "trialing",
      trialAvailable: false,
    });
  });

  it("while paid by card in the window offers the refund in the app, with the first charge's amount (AS-7, AS-30)", async () => {
    await expect(read(setup({ record: activeRecord }))).resolves.toMatchObject({
      method: "card",
      nextCharge: { amount: "24.90", on: "2026-11-10" },
      refund: {
        amount: "24.90",
        until: "2026-10-18T02:59:59.000Z",
        via: "app",
      },
      refundPending: false,
      state: "active",
    });
  });

  it("sends Pix to support with the very same window as the card (R-1, AS-44)", async () => {
    const card = await read(setup({ record: activeRecord }));
    const pix = await read(
      setup({ record: { ...activeRecord, provider: "woovi" } })
    );

    expect(pix.refund).toEqual({
      ...(card.refund as Record<string, unknown>),
      via: "suporte",
    });
  });

  it("sends the owner to support when the port of the record's provider cannot be built", async () => {
    const plan = await read(
      setup({
        ports: { woovi: { refundsEnabled: true } },
        record: activeRecord,
      })
    );

    expect(plan.refund).toMatchObject({ via: "suporte" });
  });

  it("refunds Pix in the app once the Woovi port refunds (WOOVI_REFUND_ENABLED)", async () => {
    const plan = await read(
      setup({
        ports: { woovi: { refundsEnabled: true } },
        record: { ...activeRecord, provider: "woovi" },
      })
    );

    expect(plan.refund).toMatchObject({ via: "app" });
  });

  it("shows a refund asked and not completed as pending, with the window still offered (AS-42)", async () => {
    const plan = await read(
      setup({
        record: {
          ...activeRecord,
          cancelAtPeriodEnd: true,
          refundRequestedAt: sp("2026-10-12T08:00:00"),
        },
      })
    );

    expect(plan).toMatchObject({
      nextCharge: null,
      refund: { via: "app" },
      refundPending: true,
      renewalCancelled: true,
    });
  });

  it("with the renewal cancelled, says from when a new subscription may start (AS-27)", async () => {
    await expect(
      read(setup({ record: { ...activeRecord, cancelAtPeriodEnd: true } }))
    ).resolves.toMatchObject({
      nextCharge: null,
      renewalCancelled: true,
      resubscribeFrom: "2026-11-11T03:00:00.000Z",
    });
  });

  it("after a completed refund has no date to wait for and no refund to offer (AS-27)", async () => {
    await expect(
      read(
        setup({
          record: {
            ...activeRecord,
            accessEndsAt: null,
            cycleMonths: null,
            revoked: { reason: "refund" },
            state: "free",
          },
        })
      )
    ).resolves.toMatchObject({
      method: null,
      refund: null,
      refundPending: false,
      resubscribeFrom: null,
      state: "free",
    });
  });

  it("offers no trial while a subscription runs, even if neither the store nor the person used one", async () => {
    await expect(
      read(setup({ record: { ...activeRecord, trialAvailable: true } }))
    ).resolves.toMatchObject({ trialAvailable: false });
  });

  it("offers the provider's page only in grace with the card (AS-43)", async () => {
    const grace = { ...activeRecord, state: "grace" as const };

    await expect(read(setup({ record: grace }))).resolves.toMatchObject({
      nextCharge: null,
      recovery: "provider_page",
    });
    await expect(
      read(setup({ record: { ...grace, provider: "woovi" } }))
    ).resolves.toMatchObject({ recovery: null });
  });
});
