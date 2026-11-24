// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

async function loadFresh() {
  vi.resetModules();
  const [{ planRead }, { useNearLimitRead }, notice, signOut, sessionEnded] =
    await Promise.all([
      import("../lib/plan-read"),
      import("./limit-help"),
      import("./plan-notice"),
      import("../lib/sign-out"),
      import("../offline/runtime/session-ended"),
    ]);
  planRead.clear();
  notice.clearPlanNotice();
  return { notice, sessionEnded, signOut, useNearLimitRead };
}

beforeEach(() => {
  readPlan.mockReset();
  readPlan.mockResolvedValue({
    accessEndsAt: null,
    limits: { goals: 1, images: 50, variants: 50 },
    nextCharge: null,
    state: "free",
    usage: { goals: 0, images: 0, variants: 47 },
  });
});

afterEach(() => {
  cleanup();
});

describe("a leitura do aviso depois que a sessão acabou", () => {
  it.each([
    [
      "o Sair",
      (m: Awaited<ReturnType<typeof loadFresh>>) => m.signOut.markSigningOut(),
    ],
    [
      "a sessão encerrada pelo servidor",
      (m: Awaited<ReturnType<typeof loadFresh>>) =>
        m.sessionEnded.markSessionOver(),
    ],
  ])(
    "a resposta que chega depois de %s não volta a gravar o plano da sessão que acabou",
    async (_name, end) => {
      const loaded = await loadFresh();
      end(loaded);
      renderHook(() => loaded.useNearLimitRead("variants"));
      await act(async () => {
        for (let tick = 0; tick < 6; tick += 1) {
          // biome-ignore lint/performance/noAwaitInLoops: each microtask turn must finish before the next
          await Promise.resolve();
        }
      });
      expect(readPlan).toHaveBeenCalledTimes(1);
      expect(loaded.notice.rememberedPlanNotice("org-a")).toBeNull();
    }
  );

  it("com a sessão de pé a mesma resposta grava o plano", async () => {
    const loaded = await loadFresh();
    renderHook(() => loaded.useNearLimitRead("variants"));
    await act(async () => {
      for (let tick = 0; tick < 6; tick += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: each microtask turn must finish before the next
        await Promise.resolve();
      }
    });
    expect(loaded.notice.rememberedPlanNotice("org-a")).not.toBeNull();
  });
});
