// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planRead } from "../lib/plan-read";
import { notifyPlanUsageChanged } from "../lib/plan-usage-changes";
import { clearSessionCaches } from "../offline/runtime/leave-browser";
import { useLimitHelp, useNearLimitRead } from "./limit-help";

const connection = { online: true };
const readPlan = vi.fn();

vi.mock("../lib/current-organization", () => ({
  useCurrentOrganization: () => ({
    billingSelfService: true,
    organization: { role: "owner" },
    organizationId: "org-a",
  }),
}));
vi.mock("../lib/browser-connection", () => ({
  useConnectionOnline: () => connection.online,
}));
vi.mock("../lib/orpc", () => ({
  orpcClient: {
    billing: { readPlan: (input: unknown) => readPlan(input) },
  },
}));

const planWith = (variants: number) => ({
  limits: { goals: 1, images: 50, variants: 50 },
  state: "free",
  usage: { goals: 0, images: 0, variants },
});

const flush = () =>
  act(async () => {
    for (let tick = 0; tick < 6; tick += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each microtask turn must finish before the next
      await Promise.resolve();
    }
  });

function Both({ version = 0 }: { version?: number }) {
  return {
    images: useNearLimitRead("images", version),
    variants: useNearLimitRead("variants", version),
  };
}

beforeEach(() => {
  connection.online = true;
  readPlan.mockReset();
  readPlan.mockResolvedValue(planWith(47));
  planRead.clear();
});

afterEach(cleanup);

describe("a memória de 10 s do plano entre as telas", () => {
  it("dois avisos montados juntos fazem 1 leitura", async () => {
    const view = renderHook(() => Both({}));
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(1);
    expect(view.result.current.variants.view?.usage.used).toBe(47);
    expect(view.result.current.images.settled).toBe(true);
  });

  it("uma tela aberta logo depois lê da memória, sem nova leitura", async () => {
    renderHook(() => useNearLimitRead("variants"));
    await flush();
    const second = renderHook(() => useNearLimitRead("variants"));
    await flush();
    expect(second.result.current.view?.usage.used).toBe(47);
    expect(readPlan).toHaveBeenCalledTimes(1);
  });

  it("o version da tela que mudou pede leitura fresca, e a resposta velha em voo não sobrescreve a nova", async () => {
    const answers: Array<(plan: unknown) => void> = [];
    readPlan.mockImplementation(
      () =>
        new Promise((resolve) => {
          answers.push(resolve);
        })
    );
    const view = renderHook(
      ({ version }) => useNearLimitRead("variants", version),
      {
        initialProps: { version: 0 },
      }
    );
    view.rerender({ version: 1 });
    expect(readPlan).toHaveBeenCalledTimes(2);

    answers[1]?.(planWith(48));
    await flush();
    answers[0]?.(planWith(45));
    await flush();
    expect(view.result.current.view?.usage.used).toBe(48);

    const later = renderHook(() => useNearLimitRead("variants"));
    await flush();
    expect(later.result.current.view?.usage.used).toBe(48);
    expect(readPlan).toHaveBeenCalledTimes(2);
  });

  it("gravação rastreada com o version subindo na página e no painel de Produtos faz 1 leitura", async () => {
    const view = renderHook(
      ({ version }) => ({
        page: useNearLimitRead("variants", version),
        panel: useNearLimitRead("variants", version),
      }),
      { initialProps: { version: 0 } }
    );
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(1);

    readPlan.mockResolvedValue(planWith(48));
    notifyPlanUsageChanged();
    view.rerender({ version: 1 });
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(2);
    expect(view.result.current.page.view?.usage.used).toBe(48);
    expect(view.result.current.panel.view?.usage.used).toBe(48);
  });

  it("o version subindo sem clear() faz 2 leituras", async () => {
    const view = renderHook(
      ({ version }) => ({
        page: useNearLimitRead("variants", version),
        panel: useNearLimitRead("variants", version),
      }),
      { initialProps: { version: 0 } }
    );
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(1);

    readPlan.mockResolvedValue(planWith(48));
    view.rerender({ version: 1 });
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(3);
  });

  it("a mesma tela remontada sem o version mudar não pede leitura fresca", async () => {
    const view = renderHook(
      ({ version }) => useNearLimitRead("variants", version),
      {
        initialProps: { version: 3 },
      }
    );
    await flush();
    view.rerender({ version: 3 });
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(1);
  });

  it("a troca de sessão apaga a memória", async () => {
    renderHook(() => useNearLimitRead("variants"));
    await flush();
    clearSessionCaches();
    renderHook(() => useNearLimitRead("variants"));
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(2);
  });

  it("a queda de conexão apaga a memória: ao voltar, a leitura vai ao servidor e a linha some enquanto isso", async () => {
    const view = renderHook(() => useNearLimitRead("variants"));
    await flush();
    connection.online = false;
    view.rerender();
    expect(view.result.current.view).toBeNull();
    expect(view.result.current.settled).toBe(false);

    connection.online = true;
    view.rerender();
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(2);
    expect(view.result.current.view?.usage.used).toBe(47);
  });

  it("a leitura que falha tira a linha, e a falha não fica na memória", async () => {
    readPlan.mockRejectedValueOnce(new Error("rede"));
    const view = renderHook(() => useNearLimitRead("variants"));
    await flush();
    expect(view.result.current.view).toBeNull();
    expect(view.result.current.settled).toBe(true);

    const again = renderHook(() => useNearLimitRead("variants"));
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(2);
    expect(again.result.current.view?.usage.used).toBe(47);
  });

  it("a recusa por limite lê na hora, mesmo com a memória cheia", async () => {
    renderHook(() => useNearLimitRead("variants"));
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(1);

    const refusal = renderHook(() => useLimitHelp());
    act(() => {
      refusal.result.current.show("variants");
    });
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(2);
    act(() => {
      refusal.result.current.show("variants");
    });
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(3);
  });
});
