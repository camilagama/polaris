// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planRead } from "../lib/plan-read";
import { markSigningOut } from "../lib/sign-out";
import { useNearLimitRead } from "./limit-help";
import { clearPlanNotice, rememberedPlanNotice } from "./plan-notice";

const readPlan = vi.fn();

vi.mock("../lib/current-organization", () => ({
  useCurrentOrganization: () => ({
    billingSelfService: true,
    organization: { role: "owner" },
    organizationId: "org-a",
  }),
}));
vi.mock("../lib/browser-connection", () => ({
  useConnectionOnline: () => true,
}));
vi.mock("../lib/orpc", () => ({
  orpcClient: {
    billing: { readPlan: (input: unknown) => readPlan(input) },
  },
}));

beforeEach(() => {
  readPlan.mockReset();
  readPlan.mockResolvedValue({
    accessEndsAt: null,
    limits: { goals: 1, images: 50, variants: 50 },
    nextCharge: null,
    state: "free",
    usage: { goals: 0, images: 0, variants: 47 },
  });
  planRead.clear();
  clearPlanNotice();
});

afterEach(() => {
  cleanup();
  clearPlanNotice();
});

describe("a leitura do aviso depois do Sair", () => {
  it("a resposta que chega depois do Sair não volta a gravar o plano da sessão que acabou", async () => {
    markSigningOut();
    renderHook(() => useNearLimitRead("variants"));
    await act(async () => {
      for (let tick = 0; tick < 6; tick += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: each microtask turn must finish before the next
        await Promise.resolve();
      }
    });
    expect(readPlan).toHaveBeenCalledTimes(1);
    expect(rememberedPlanNotice("org-a")).toBeNull();
  });
});
