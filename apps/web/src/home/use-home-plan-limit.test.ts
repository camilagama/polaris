import { beforeEach, describe, expect, it, vi } from "vitest";

interface Slot {
  deps?: readonly unknown[] | undefined;
  value?: unknown;
}

const runtime = {
  dirty: false,
  effects: [] as Array<() => void>,
  index: 0,
  slots: [] as Slot[],
};

function nextSlot(): Slot {
  const slot = runtime.slots[runtime.index] ?? {};
  runtime.slots[runtime.index] = slot;
  runtime.index += 1;
  return slot;
}

vi.mock("react", () => ({
  useEffect: (effect: () => void, deps: readonly unknown[]) => {
    const slot = nextSlot();
    const changed =
      slot.deps === undefined ||
      deps.some((dep, at) => !Object.is(dep, slot.deps?.[at]));
    if (changed) {
      slot.deps = deps;
      runtime.effects.push(effect);
    }
  },
  useRef: <T>(initial: T) => {
    const slot = nextSlot();
    slot.value ??= { current: initial };
    return slot.value as { current: T };
  },
  useState: <T>(initial: T) => {
    const slot = nextSlot();
    if (!("value" in slot)) {
      slot.value = initial;
    }
    const set = (next: T) => {
      if (!Object.is(slot.value, next)) {
        slot.value = next;
        runtime.dirty = true;
      }
    };
    return [slot.value as T, set];
  },
}));

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

const { useHomePlanLimit } = await import("./use-home-plan-limit");

const planWith = (variants: number) => ({
  limits: { goals: 1, images: 50, variants: 50 },
  state: "free",
  usage: { goals: 0, images: 0, variants },
});

let shown: ReturnType<typeof useHomePlanLimit> = null;

function isDirty(): boolean {
  return runtime.dirty;
}

function render() {
  do {
    runtime.dirty = false;
    runtime.effects = [];
    runtime.index = 0;
    shown = useHomePlanLimit();
    for (const effect of runtime.effects) {
      effect();
    }
  } while (isDirty());
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function switchTo(id: string) {
  store.id = id;
  render();
}

beforeEach(() => {
  runtime.slots = [];
  store.id = "org-a";
  store.online = true;
  readPlan.mockReset();
  shown = null;
});

describe("useHomePlanLimit: a linha por loja", () => {
  it("A → B → A sem remontar: a linha de A volta, lida de novo, e nunca com o número de outra loja", async () => {
    readPlan.mockImplementation(
      ({ organizationId }: { organizationId: string }) =>
        Promise.resolve(planWith(organizationId === "org-a" ? 47 : 12))
    );
    render();
    await flush();
    render();
    expect(shown?.usage.used).toBe(47);

    switchTo("org-b");
    expect(shown).toBeNull();
    await flush();
    render();
    expect(shown).toBeNull();

    switchTo("org-a");
    expect(shown).toBeNull();
    await flush();
    render();
    expect(shown?.usage.used).toBe(47);
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
    render();
    switchTo("org-b");
    answerA(planWith(47));
    await flush();
    render();
    expect(shown).toBeNull();
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
    render();
    switchTo("org-b");
    await flush();
    render();
    expect(shown?.usage.used).toBe(46);

    answerA(planWith(47));
    await flush();
    render();
    expect(shown?.usage.used).toBe(46);
  });

  it("A lida, a conexão cai, A → B → A sem conexão e ela volta: não relê A e a linha some, sem o número de outra loja em nenhum passo", async () => {
    readPlan.mockImplementation(
      ({ organizationId }: { organizationId: string }) =>
        Promise.resolve(planWith(organizationId === "org-a" ? 47 : 46))
    );
    render();
    await flush();
    render();
    expect(shown?.usage.used).toBe(47);

    store.online = false;
    render();
    expect(shown).toBeNull();
    switchTo("org-b");
    expect(shown).toBeNull();
    switchTo("org-a");
    expect(shown).toBeNull();

    store.online = true;
    render();
    await flush();
    render();
    expect(shown).toBeNull();
    switchTo("org-b");
    await flush();
    render();
    expect(shown?.usage.used).toBe(46);
    expect(readPlan.mock.calls.map(([input]) => input.organizationId)).toEqual([
      "org-a",
      "org-b",
    ]);
  });

  it("a conexão que cai e volta na mesma loja não lê de novo", async () => {
    readPlan.mockResolvedValue(planWith(47));
    render();
    await flush();
    render();
    expect(shown?.usage.used).toBe(47);

    store.online = false;
    render();
    expect(shown).toBeNull();
    store.online = true;
    render();
    await flush();
    render();
    expect(readPlan).toHaveBeenCalledTimes(1);
    expect(shown).toBeNull();
  });

  it("aberto sem conexão não lê; a conexão que chega faz a leitura e traz a linha", async () => {
    store.online = false;
    readPlan.mockResolvedValue(planWith(47));
    render();
    await flush();
    expect(readPlan).not.toHaveBeenCalled();
    expect(shown).toBeNull();

    store.online = true;
    render();
    await flush();
    render();
    expect(readPlan).toHaveBeenCalledTimes(1);
    expect(shown?.usage.used).toBe(47);
  });
});
