import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type {
  DailySalesReadModel,
  PeriodSummaryReadModel,
} from "@polaris/contracts";
import { InvalidEconomicsPeriodError } from "@polaris/db/economics-repository";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "@polaris/db/tenant-transaction";
import { periodResult } from "@polaris/domain/economics/sale-economics";
import { logger } from "@polaris/observability/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import type { TenantRequestContextInput } from "../tenant-request-context";
import { createRpcRouter } from "./router";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const identity: TenantRequestIdentity = {
  capability: "report:read",
  organizationId,
  role: "owner",
  userId: "verified-session-user",
};

const testBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

interface ReportClient {
  report: {
    dailySales: (input: unknown) => Promise<DailySalesReadModel>;
    periodSummary: (input: unknown) => Promise<PeriodSummaryReadModel>;
  };
}

function client(router: ReturnType<typeof createRpcRouter>) {
  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    headers: { origin: "https://polaris.example.invalid" },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  return createORPCClient(link) as unknown as ReportClient;
}

function tenantStub(
  onCall?: (input: { capability: string; isolationLevel?: string }) => void
) {
  return async <T>(input: TenantRequestContextInput<T>): Promise<T> => {
    onCall?.({
      capability: input.capability,
      ...(input.isolationLevel ? { isolationLevel: input.isolationLevel } : {}),
    });
    return await input.operation({} as TenantRequestTransaction, identity);
  };
}

const result = periodResult(
  [
    {
      adjustments: [{ amount: "10.00", kind: "freight" }],
      anticipationFee: "0.00",
      cancelled: false,
      items: [
        {
          chargedUnitPrice: "100.00",
          position: 0,
          quantity: 2,
          unitCost: "30.00",
        },
      ],
      linkedExpenses: ["5.00"],
      processingFee: null,
      returnLines: [],
    },
  ],
  ["20.00"]
);

const reads = {
  adjustments: 1,
  cancellations: 0,
  items: 1,
  linkedExpenses: 1,
  operatingExpenses: 1,
  payments: 1,
  returnLines: 0,
  sales: 1,
};
const daily = [
  {
    costs: "95.00",
    date: "2026-10-01",
    netSales: "200.00",
    operatingExpenses: "0.00",
    operatingResult: "115.00",
    salesCount: 1,
  },
  {
    costs: null,
    date: "2026-10-02",
    netSales: "0.00",
    operatingExpenses: "50.00",
    operatingResult: null,
    salesCount: 0,
  },
];
const PRODUCT = "0192a000-0000-7000-8000-0000000000aa";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("report.periodSummary", () => {
  it("reads in one repeatable-read snapshot with report:read and returns the cards, the chain and the quality", async () => {
    const seen: { capability: string; isolationLevel?: string }[] = [];
    const read = vi.fn(async () => ({
      daily,
      reads: { ...reads, products: 0 },
      result,
    }));
    const summary = await client(
      createRpcRouter({
        readPeriodSummary: read,
        withTenantRequestContext: tenantStub((input) => seen.push(input)),
      })
    ).report.periodSummary({
      from: "2026-10-01",
      organizationId: "requested-org",
      to: "2026-10-31",
    });

    expect(seen).toEqual([
      { capability: "report:read", isolationLevel: "repeatable read" },
    ]);
    expect(read).toHaveBeenCalledWith(
      {},
      identity,
      { from: "2026-10-01", to: "2026-10-31" },
      { topProducts: undefined }
    );
    expect(summary.daily).toEqual(daily);
    // the Result page does not ask for the ranking and does not get it
    expect(summary).not.toHaveProperty("topProducts");
    // gross 200 + freight 10 ; cogs 60 ; linked 5 ; fee unknown
    expect(summary.cards).toEqual({
      items: 2,
      marginPercent: "72.50",
      netSales: "200.00",
      operatingResult: "125.00",
      salesCount: 1,
      ticket: "200.00",
    });
    expect(summary.chain).toMatchObject({
      contributionMargin: "145.00",
      grossProfit: "140.00",
      linkedExpenses: "5.00",
      operatingExpenses: "20.00",
    });
    expect(summary.period).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    // the server clock says how recent the confirmed records read are
    expect(Math.abs(Date.parse(summary.generatedAt) - Date.now())).toBeLessThan(
      60_000
    );
    expect(summary.quality).toMatchObject({
      level: "partial",
      missing: ["unknown_processing_fee"],
      processingFeesUnknown: 1,
    });
  });

  it("maps an invalid period to a bad request, and refuses malformed dates before opening a tenant context", async () => {
    const failing = client(
      createRpcRouter({
        readPeriodSummary: () =>
          Promise.reject(new InvalidEconomicsPeriodError()),
        withTenantRequestContext: tenantStub(),
      })
    );
    await expect(
      failing.report.periodSummary({
        from: "2026-10-31",
        organizationId,
        to: "2026-10-01",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const withTenantRequestContext = vi.fn(tenantStub());
    const strict = client(
      createRpcRouter({
        withTenantRequestContext:
          withTenantRequestContext as unknown as NonNullable<
            NonNullable<
              Parameters<typeof createRpcRouter>[0]
            >["withTenantRequestContext"]
          >,
      })
    );
    await expect(
      strict.report.periodSummary({
        from: "01/10/2026",
        organizationId,
        to: "2026-10-31",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(withTenantRequestContext).not.toHaveBeenCalled();
  });

  it.each([
    ["2026-01-01", "2026-12-31", 365],
    ["2026-01-01", "2027-01-01", 366],
    ["2028-01-01", "2028-12-31", 366],
  ])(
    "reads a period of %s to %s (%s days, the longest allowed is 366)",
    async (from, to) => {
      const read = vi.fn(async () => ({
        daily,
        reads: { ...reads, products: 0 },
        result,
      }));
      await client(
        createRpcRouter({
          readPeriodSummary: read,
          withTenantRequestContext: tenantStub(),
        })
      ).report.periodSummary({ from, organizationId, to });
      expect(read).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ["2026-01-01", "2027-01-02"],
    ["2028-01-01", "2029-01-01"],
    ["2020-01-01", "2026-10-31"],
  ])(
    "refuses a period of %s to %s (367 days or more) before opening a tenant context",
    async (from, to) => {
      const withTenantRequestContext = vi.fn(tenantStub());
      await expect(
        client(
          createRpcRouter({
            withTenantRequestContext:
              withTenantRequestContext as unknown as NonNullable<
                NonNullable<
                  Parameters<typeof createRpcRouter>[0]
                >["withTenantRequestContext"]
              >,
          })
        ).report.periodSummary({ from, organizationId, to })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(withTenantRequestContext).not.toHaveBeenCalled();
    }
  );

  it("returns the costs and the result of each day as the read gave them, null staying null", async () => {
    const summary = await client(
      createRpcRouter({
        readPeriodSummary: async () => ({
          daily,
          reads: { ...reads, products: 0 },
          result,
        }),
        withTenantRequestContext: tenantStub(),
      })
    ).report.periodSummary({
      from: "2026-10-01",
      organizationId,
      to: "2026-10-02",
    });
    expect(summary.daily[0]).toMatchObject({
      costs: "95.00",
      operatingExpenses: "0.00",
      operatingResult: "115.00",
    });
    expect(summary.daily[1]).toMatchObject({
      costs: null,
      operatingExpenses: "50.00",
      operatingResult: null,
    });
  });

  it("asks for the ranking only when the input does, and returns the products with their current name", async () => {
    const read = vi.fn(async () => ({
      daily,
      reads: { ...reads, products: 1 },
      result,
      topProducts: [
        {
          deleted: true,
          name: "Camiseta",
          netSales: "200.00",
          productId: PRODUCT,
          quantity: 2,
        },
      ],
    }));
    const summary = await client(
      createRpcRouter({
        readPeriodSummary: read,
        withTenantRequestContext: tenantStub(),
      })
    ).report.periodSummary({
      from: "2026-10-01",
      organizationId,
      to: "2026-10-31",
      topProducts: 3,
    });
    expect(read).toHaveBeenCalledWith(
      {},
      identity,
      { from: "2026-10-01", to: "2026-10-31" },
      { topProducts: 3 }
    );
    expect(summary.topProducts).toEqual([
      {
        deleted: true,
        name: "Camiseta",
        netSales: "200.00",
        productId: PRODUCT,
        quantity: 2,
      },
    ]);
  });

  it.each([0, 11, 2.5])(
    "refuses topProducts %s before opening a tenant context",
    async (topProducts) => {
      const withTenantRequestContext = vi.fn(tenantStub());
      await expect(
        client(
          createRpcRouter({
            withTenantRequestContext:
              withTenantRequestContext as unknown as NonNullable<
                NonNullable<
                  Parameters<typeof createRpcRouter>[0]
                >["withTenantRequestContext"]
              >,
          })
        ).report.periodSummary({
          from: "2026-10-01",
          organizationId,
          to: "2026-10-31",
          topProducts,
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(withTenantRequestContext).not.toHaveBeenCalled();
    }
  );

  it("records each read with counts, size and the opaque organization only: no amount and no name", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    await client(
      createRpcRouter({
        readPeriodSummary: async () => ({
          daily,
          reads: { ...reads, products: 1 },
          result,
          topProducts: [
            {
              deleted: false,
              name: "Camiseta secreta",
              netSales: "200.00",
              productId: PRODUCT,
              quantity: 2,
            },
          ],
        }),
        withTenantRequestContext: tenantStub(),
      })
    ).report.periodSummary({
      from: "2026-10-01",
      organizationId,
      to: "2026-10-31",
      topProducts: 3,
    });
    const calls = info.mock.calls.filter(
      ([event]) => event === "report_period_summary_read"
    );
    expect(calls).toHaveLength(1);
    const fields = calls[0]?.[1] as Record<string, unknown>;
    expect(fields).toMatchObject({
      days: 2,
      organizationId,
      reads: { ...reads, products: 1 },
      topProducts: 3,
    });
    expect(fields.responseBytes).toBeGreaterThan(0);
    expect(typeof fields.durationMs).toBe("number");
    expect(typeof fields.requestId).toBe("string");
    const text = JSON.stringify(fields);
    expect(text).not.toContain("200.00");
    expect(text).not.toContain("Camiseta");
    expect(text).not.toContain(PRODUCT);
    expect(Object.keys(fields).sort()).toEqual([
      "days",
      "durationMs",
      "organizationId",
      "reads",
      "requestId",
      "responseBytes",
      "topProducts",
    ]);
  });
});

type TenantOverride = NonNullable<
  NonNullable<Parameters<typeof createRpcRouter>[0]>["withTenantRequestContext"]
>;

describe("report.dailySales", () => {
  const series = {
    count: [3, 0, 1],
    from: "2026-10-01",
    net: ["310.50", "0.00", "89.90"],
  };

  it("reads with report:read in the organization the server resolves and returns the compact series as read", async () => {
    const seen: { capability: string; isolationLevel?: string }[] = [];
    const read = vi.fn(async () => series);
    const answer = await client(
      createRpcRouter({
        readDailySales: read,
        withTenantRequestContext: tenantStub((input) => seen.push(input)),
      })
    ).report.dailySales({
      from: "2026-10-01",
      organizationId: "requested-org",
      to: "2026-10-03",
    });
    // one statement is one snapshot: no repeatable read needed
    expect(seen).toEqual([{ capability: "report:read" }]);
    expect(read).toHaveBeenCalledWith({}, identity, {
      from: "2026-10-01",
      to: "2026-10-03",
    });
    expect(answer).toEqual(series);
  });

  it("maps an invalid period to a bad request", async () => {
    await expect(
      client(
        createRpcRouter({
          readDailySales: () =>
            Promise.reject(new InvalidEconomicsPeriodError()),
          withTenantRequestContext: tenantStub(),
        })
      ).report.dailySales({
        from: "2026-10-31",
        organizationId,
        to: "2026-10-01",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it.each([
    ["2026-04-26", "2026-10-25"],
    ["2025-10-25", "2026-10-25"],
    ["25/10/2026", "2026-10-25"],
  ])(
    "refuses %s to %s (183 dates or a malformed date) before opening a tenant context",
    async (from, to) => {
      const withTenantRequestContext = vi.fn(tenantStub());
      await expect(
        client(
          createRpcRouter({
            withTenantRequestContext:
              withTenantRequestContext as unknown as TenantOverride,
          })
        ).report.dailySales({ from, organizationId, to })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(withTenantRequestContext).not.toHaveBeenCalled();
    }
  );

  it("reads 182 dates, the longest allowed", async () => {
    const read = vi.fn(async () => series);
    await client(
      createRpcRouter({
        readDailySales: read,
        withTenantRequestContext: tenantStub(),
      })
    ).report.dailySales({
      from: "2026-04-27",
      organizationId,
      to: "2026-10-25",
    });
    expect(read).toHaveBeenCalledOnce();
  });

  it("records each read with the days, the size and the opaque organization only: no amount", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    await client(
      createRpcRouter({
        readDailySales: async () => series,
        withTenantRequestContext: tenantStub(),
      })
    ).report.dailySales({
      from: "2026-10-01",
      organizationId,
      to: "2026-10-03",
    });
    const calls = info.mock.calls.filter(
      ([event]) => event === "report_daily_sales_read"
    );
    expect(calls).toHaveLength(1);
    const fields = calls[0]?.[1] as Record<string, unknown>;
    expect(fields).toMatchObject({ days: 3, organizationId });
    expect(fields.responseBytes).toBeGreaterThan(0);
    expect(JSON.stringify(fields)).not.toContain("310.50");
    expect(Object.keys(fields).sort()).toEqual([
      "days",
      "durationMs",
      "organizationId",
      "requestId",
      "responseBytes",
    ]);
  });
});
