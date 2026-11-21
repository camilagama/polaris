// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNearLimitRead } from "../subscription/limit-help";
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

const plan = (state: string, variants = 47) => ({
  accessEndsAt: null,
  limits: { goals: 1, images: 50, variants: 50 },
  nextCharge: null,
  state,
  usage: { goals: 0, images: 0, variants },
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
    variants: useNearLimitRead("variants"),
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
  it("o aviso do shell e o aviso de um cadastro abertos juntos fazem 1 chamada billing/readPlan", async () => {
    const view = renderHook(() => Both());
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(1);
    expect(readPlan).toHaveBeenCalledWith({ organizationId: "org-a" });
    expect(view.result.current.facts?.state).toBe("free");
    expect(view.result.current.variants.view?.usage.used).toBe(47);
  });

  it("um cadastro aberto logo depois de o aviso ler usa a cópia de 10 s", async () => {
    renderHook(() => usePlanNoticeFacts("org-a", true, true));
    await flush();
    const screen = renderHook(() => useNearLimitRead("variants"));
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(1);
    expect(screen.result.current.view?.usage.used).toBe(47);
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

  it("o uso do cartão é o da loja da tela: A → B → A nunca mostra o número de outra loja", async () => {
    readPlan.mockImplementation(
      ({ organizationId }: { organizationId: string }) =>
        Promise.resolve(plan("free", organizationId === "org-a" ? 12 : 31))
    );
    const view = renderHook(() => usePlanNoticeFacts(store.id, true, true));
    await flush();
    expect(view.result.current?.variants).toEqual({ max: 50, used: 12 });
    store.id = "org-b";
    view.rerender();
    expect(view.result.current).toBeNull();
    await flush();
    expect(view.result.current?.variants).toEqual({ max: 50, used: 31 });
    store.id = "org-a";
    view.rerender();
    expect(view.result.current?.variants).not.toEqual({ max: 50, used: 31 });
    await flush();
    expect(view.result.current?.variants).toEqual({ max: 50, used: 12 });
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
