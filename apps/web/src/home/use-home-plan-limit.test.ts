// @vitest-environment happy-dom
import { act, type RenderHookResult, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHomePlanLimit } from "./use-home-plan-limit";

const store = { id: "org-a", online: true };
const readPlan = vi.fn();

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

const planWith = (variants: number) => ({
  limits: { goals: 1, images: 50, variants: 50 },
  state: "free",
  usage: { goals: 0, images: 0, variants },
});

let view: RenderHookResult<ReturnType<typeof useHomePlanLimit>, void> | null =
  null;

const shown = () => view?.result.current ?? null;

const render = () =>
  act(() => {
    view?.rerender();
  });

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

function switchTo(id: string) {
  store.id = id;
  render();
}

function mount() {
  view = renderHook(() => useHomePlanLimit());
}

afterEach(() => {
  view?.unmount();
  view = null;
});

beforeEach(() => {
  store.id = "org-a";
  store.online = true;
  readPlan.mockReset();
});

describe("useHomePlanLimit: a linha por loja", () => {
  it("A → B → A sem remontar: a linha de A volta, lida de novo, e nunca com o número de outra loja", async () => {
    readPlan.mockImplementation(
      ({ organizationId }: { organizationId: string }) =>
        Promise.resolve(planWith(organizationId === "org-a" ? 47 : 12))
    );
    mount();
    await flush();
    expect(shown()?.usage.used).toBe(47);

    switchTo("org-b");
    expect(shown()).toBeNull();
    await flush();
    expect(shown()).toBeNull();

    switchTo("org-a");
    expect(shown()).toBeNull();
    await flush();
    expect(shown()?.usage.used).toBe(47);
    expect(readPlan.mock.calls.map(([input]) => input.organizationId)).toEqual([
      "org-a",
      "org-b",
      "org-a",
    ]);
  });

  it("a resposta de A que chega quando a tela já é de B não aparece em B", async () => {
    let answerA: (plan: unknown) => void = () => undefined;
    readPlan.mockImplementation(
      ({ organizationId }: { organizationId: string }) =>
        organizationId === "org-a"
          ? new Promise((resolve) => {
              answerA = resolve;
            })
          : new Promise(() => undefined)
    );
    mount();
    switchTo("org-b");
    answerA(planWith(47));
    await flush();
    expect(shown()).toBeNull();
  });

  it("a resposta lenta de A que chega depois da de B não apaga a linha de B", async () => {
    let answerA: (plan: unknown) => void = () => undefined;
    readPlan.mockImplementation(
      ({ organizationId }: { organizationId: string }) =>
        organizationId === "org-a"
          ? new Promise((resolve) => {
              answerA = resolve;
            })
          : Promise.resolve(planWith(46))
    );
    mount();
    switchTo("org-b");
    await flush();
    expect(shown()?.usage.used).toBe(46);

    answerA(planWith(47));
    await flush();
    expect(shown()?.usage.used).toBe(46);
  });

  it("limite conhecido, não requisito: A → B → A com a 1ª resposta de A atrasada, ela chega por último e é aceita no lugar da 2ª", async () => {
    const answersA: Array<(plan: unknown) => void> = [];
    readPlan.mockImplementation(
      ({ organizationId }: { organizationId: string }) =>
        organizationId === "org-a"
          ? new Promise((resolve) => {
              answersA.push(resolve);
            })
          : new Promise(() => undefined)
    );
    mount();
    switchTo("org-b");
    switchTo("org-a");
    expect(answersA).toHaveLength(2);

    answersA[1]?.(planWith(46));
    await flush();
    expect(shown()?.usage.used).toBe(46);

    answersA[0]?.(planWith(47));
    await flush();
    expect(shown()?.usage.used).toBe(47);
  });

  it("A lida, a conexão cai, A → B → A sem conexão e ela volta: não relê A e a linha some, sem o número de outra loja em nenhum passo", async () => {
    readPlan.mockImplementation(
      ({ organizationId }: { organizationId: string }) =>
        Promise.resolve(planWith(organizationId === "org-a" ? 47 : 46))
    );
    mount();
    await flush();
    expect(shown()?.usage.used).toBe(47);

    store.online = false;
    render();
    expect(shown()).toBeNull();
    switchTo("org-b");
    expect(shown()).toBeNull();
    switchTo("org-a");
    expect(shown()).toBeNull();

    store.online = true;
    render();
    await flush();
    expect(shown()).toBeNull();
    switchTo("org-b");
    await flush();
    expect(shown()?.usage.used).toBe(46);
    expect(readPlan.mock.calls.map(([input]) => input.organizationId)).toEqual([
      "org-a",
      "org-b",
    ]);
  });

  it("a conexão que cai e volta na mesma loja não lê de novo", async () => {
    readPlan.mockResolvedValue(planWith(47));
    mount();
    await flush();
    expect(shown()?.usage.used).toBe(47);

    store.online = false;
    render();
    expect(shown()).toBeNull();
    store.online = true;
    render();
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(1);
    expect(shown()).toBeNull();
  });

  it("aberto sem conexão não lê; a conexão que chega faz a leitura e traz a linha", async () => {
    store.online = false;
    readPlan.mockResolvedValue(planWith(47));
    mount();
    await flush();
    expect(readPlan).not.toHaveBeenCalled();
    expect(shown()).toBeNull();

    store.online = true;
    render();
    await flush();
    expect(readPlan).toHaveBeenCalledTimes(1);
    expect(shown()?.usage.used).toBe(47);
  });
});
