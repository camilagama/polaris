// @vitest-environment happy-dom
import type { BillingPlanView } from "@polaris/contracts";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaticOrganizationProvider } from "../lib/current-organization";
import { planRead } from "../lib/plan-read";
import { SubscriptionPage } from "./subscription-page";

const readPlan = vi.fn();

vi.mock("../lib/orpc", () => ({
  orpcClient: {
    billing: { readPlan: (input: unknown) => readPlan(input) },
  },
}));

const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};

function planWith(variants: number): BillingPlanView {
  return {
    accessEndsAt: null,
    cycleMonths: null,
    kept: { historyMonths: 3, products: 18, sales: 47 },
    limits: { goals: 1, images: 30, variants: 50 },
    method: null,
    nextCharge: null,
    offer: {
      methods: ["card", "pix_automatic"],
      prices: [{ amount: "24.90", cycleMonths: 1 }],
    },
    recovery: null,
    refund: null,
    refundPending: false,
    refundWindowEndedOn: null,
    renewalCancelled: false,
    resubscribeFrom: null,
    state: "free",
    trialAvailable: true,
    usage: { goals: 1, images: 12, variants },
  } as BillingPlanView;
}

const flush = () =>
  act(async () => {
    for (let tick = 0; tick < 8; tick += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each microtask turn must finish before the next
      await Promise.resolve();
    }
  });

beforeEach(() => {
  readPlan.mockReset();
  planRead.clear();
});

afterEach(cleanup);

describe("a Assinatura e a memória de 10 s do plano", () => {
  it("lê na hora mesmo com a memória cheia, e a leitura dela vira a mais nova para os avisos", async () => {
    readPlan.mockResolvedValueOnce(planWith(10));
    await planRead.get(ORGANIZATION.id);

    readPlan.mockResolvedValueOnce(planWith(40));
    render(
      <StaticOrganizationProvider
        billingSelfService
        organization={ORGANIZATION}
      >
        <SubscriptionPage />
      </StaticOrganizationProvider>
    );
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(2);

    const shared = await planRead.get(ORGANIZATION.id);
    expect(shared.usage.variants).toBe(40);
    expect(readPlan).toHaveBeenCalledTimes(2);
  });
});
