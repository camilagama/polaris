import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { PeriodSummaryReadModel } from "@polaris/contracts";
import { InvalidEconomicsPeriodError } from "@polaris/db/economics-repository";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "@polaris/db/tenant-transaction";
import { periodResult } from "@polaris/domain/economics/sale-economics";
import { describe, expect, it, vi } from "vitest";
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

describe("report.periodSummary", () => {
  it("reads in one repeatable-read snapshot with report:read and returns the cards, the chain and the quality", async () => {
    const seen: { capability: string; isolationLevel?: string }[] = [];
    const read = vi.fn(async () => result);
    const summary = await client(
      createRpcRouter({
        readPeriodResult: read,
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
    expect(read).toHaveBeenCalledWith({}, identity, {
      from: "2026-10-01",
      to: "2026-10-31",
    });
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
        readPeriodResult: () =>
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
});
