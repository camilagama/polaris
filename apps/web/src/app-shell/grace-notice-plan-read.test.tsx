// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHomePlanLimit } from "../home/use-home-plan-limit";
import { planRead } from "../lib/plan-read";
import { notifyPlanUsageChanged } from "../lib/plan-usage-changes";
import {
  clearPlanNotice,
  rememberedPlanNotice,
} from "../subscription/plan-notice";
import { usePlanNoticeFacts } from "./grace-notice";

const store = { id: "org-a", online: true };
const readPlan = vi.fn();
const session = { over: false };

vi.mock("../offline/runtime/session-ended", () => ({
  isSessionOver: () => session.over,
}));

vi.mock("../lib/current-organization", () => ({
  useCurrentOrganization: () => ({
    billingSelfService: true,
    organization: { role: "owner" },
    organizationId: store.id,
  }),
}));
vi.mock("../lib/browser-connection", () => ({
  useConnectionOnline: () => store.online,
}));
vi.mock("../lib/orpc", () => ({
  orpcClient: {
    billing: { readPlan: (input: unknown) => readPlan(input) },
  },
}));

const plan = (state: string) => ({
  accessEndsAt: null,
  limits: { goals: 1, images: 50, variants: 50 },
  nextCharge: null,
  state,
  usage: { goals: 0, images: 0, variants: 47 },
});

const flush = () =>
  act(async () => {
    for (let tick = 0; tick < 6; tick += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each microtask turn must finish before the next
      await Promise.resolve();
    }
  });

function Both() {
  return {
    facts: usePlanNoticeFacts(store.id, true, true),
    home: useHomePlanLimit(),
  };
}

beforeEach(() => {
  store.id = "org-a";
  store.online = true;
  session.over = false;
  readPlan.mockReset();
  readPlan.mockResolvedValue(plan("free"));
  clearPlanNotice();
  planRead.clear();
});

afterEach(cleanup);

describe("o aviso do shell lê o plano pela memória compartilhada", () => {
  it("o aviso e o Início abertos juntos fazem 1 chamada billing/readPlan", async () => {
    const view = renderHook(() => Both());
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(1);
    expect(readPlan).toHaveBeenCalledWith({ organizationId: "org-a" });
    expect(view.result.current.facts?.state).toBe("free");
    expect(view.result.current.home?.usage.used).toBe(47);
  });

  it("o Início aberto logo depois de o aviso ler usa a cópia de 10 s", async () => {
    renderHook(() => usePlanNoticeFacts("org-a", true, true));
    await flush();
    const home = renderHook(() => useHomePlanLimit());
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(1);
    expect(home.result.current?.usage.used).toBe(47);
  });

  it("uma gravação que muda o uso limpa a memória: o aviso lê de novo", async () => {
    clearPlanNotice();
    renderHook(() => usePlanNoticeFacts("org-a", true, true));
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(1);
    notifyPlanUsageChanged();
    clearPlanNotice();
    renderHook(() => usePlanNoticeFacts("org-a", true, true));
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(2);
  });

  it("a troca de loja não mistura lojas: cada uma tem sua leitura", async () => {
    readPlan.mockImplementation(
      ({ organizationId }: { organizationId: string }) =>
        Promise.resolve(plan(organizationId === "org-a" ? "free" : "pro"))
    );
    const view = renderHook(() => usePlanNoticeFacts(store.id, true, true));
    await flush();
    expect(view.result.current?.state).toBe("free");
    store.id = "org-b";
    view.rerender();
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(2);
    expect(readPlan).toHaveBeenLastCalledWith({ organizationId: "org-b" });
    expect(view.result.current?.state).toBe("pro");
  });

  it("a resposta que chega depois de a sessão acabar não é gravada", async () => {
    let answer: (value: unknown) => void = () => undefined;
    readPlan.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    renderHook(() => usePlanNoticeFacts("org-a", true, true));
    await flush();
    session.over = true;
    answer(plan("free"));
    await flush();
    expect(rememberedPlanNotice("org-a")).toBeNull();
  });
});
