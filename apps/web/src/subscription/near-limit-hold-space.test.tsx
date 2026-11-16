import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NearLimitView } from "./limit-help-model";

interface Slot {
  deps?: readonly unknown[] | undefined;
  value?: unknown;
}

const runtime = {
  dirty: false,
  effects: [] as Array<() => (() => void) | undefined>,
  index: 0,
  slots: [] as Slot[],
};

function nextSlot(): Slot {
  const slot = runtime.slots[runtime.index] ?? {};
  runtime.slots[runtime.index] = slot;
  runtime.index += 1;
  return slot;
}

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T,>(callback: T) => callback,
  useContext: () => null,
  useEffect: (
    effect: () => (() => void) | undefined,
    deps: readonly unknown[]
  ) => {
    const slot = nextSlot();
    const changed =
      slot.deps === undefined ||
      deps.some((dep, at) => !Object.is(dep, slot.deps?.[at]));
    if (changed) {
      slot.deps = deps;
      runtime.effects.push(() => {
        const cleanup = (slot.value as (() => void) | undefined) ?? undefined;
        cleanup?.();
        const next = effect();
        slot.value = next;
        return next;
      });
    }
  },
  useRef: <T,>(initial: T) => {
    const slot = nextSlot();
    slot.value ??= { current: initial };
    return slot.value as { current: T };
  },
  useState: <T,>(initial: T) => {
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

const { NearLimitNotice, useNearLimitRead } = await import("./limit-help");

const planWith = (images: number) => ({
  limits: { goals: 1, images: 50, variants: 50 },
  state: "free",
  usage: { goals: 0, images, variants: 0 },
});

const near: NearLimitView = {
  kind: "near",
  proMax: null,
  usage: { max: 50, subject: "images", used: 47 },
};

interface NoticeProps {
  "aria-hidden"?: boolean;
  className: string;
  "data-near-limit"?: string;
}

let noticeOf: ReactElement<NoticeProps> | null = null;
let settledNow = false;

function isDirty(): boolean {
  return runtime.dirty;
}

function renderScreen(version = 0) {
  do {
    runtime.dirty = false;
    runtime.effects = [];
    runtime.index = 0;
    const read = useNearLimitRead("images", version);
    settledNow = read.settled;
    noticeOf = NearLimitNotice({
      holdSpace: !read.settled,
      view: read.view,
    }) as ReactElement<NoticeProps> | null;
    for (const effect of runtime.effects) {
      effect();
    }
  } while (isDirty());
}

const flush = async () => {
  for (let tick = 0; tick < 6; tick += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each microtask turn must finish before the next
    await Promise.resolve();
  }
};

async function settle(version = 0) {
  renderScreen(version);
  await flush();
  renderScreen(version);
}

beforeEach(() => {
  runtime.slots = [];
  connection.online = true;
  readPlan.mockReset();
  noticeOf = null;
});

describe("NearLimitNotice com holdSpace", () => {
  const renderNotice = (
    view: NearLimitView | null,
    holdSpace: boolean,
    hidden = false
  ) => {
    runtime.slots = [];
    runtime.index = 0;
    NearLimitNotice({ hidden, holdSpace, view: near });
    runtime.index = 0;
    return NearLimitNotice({
      hidden,
      holdSpace,
      view,
    }) as ReactElement<NoticeProps> | null;
  };

  it("com o vão, a linha que já apareceu fica invisível, fora da leitura e sem data-near-limit", () => {
    const held = renderNotice(null, true);
    expect(held).not.toBeNull();
    expect(held?.props["aria-hidden"]).toBe(true);
    expect(held?.props.className).toContain("invisible");
    expect(held?.props["data-near-limit"]).toBeUndefined();
  });

  it("sem o vão, nada é renderizado", () => {
    expect(renderNotice(null, false)).toBeNull();
  });

  it("com o vão, mas com a recusa na tela (hidden), nada é renderizado", () => {
    expect(renderNotice(null, true, true)).toBeNull();
  });

  it("a linha à mostra não leva aria-hidden nem invisible, e ganha data-near-limit", () => {
    const visible = renderNotice(near, true);
    expect(visible?.props["aria-hidden"]).toBeUndefined();
    expect(visible?.props.className).not.toContain("invisible");
    expect(visible?.props["data-near-limit"]).toBe("near");
  });
});

describe("a linha que sai por leitura não volta como vão", () => {
  it("de 45 a 44: a leitura tira a linha e, depois, a conexão que cai não devolve o número velho", async () => {
    readPlan.mockResolvedValue(planWith(45));
    await settle();
    expect(noticeOf?.props["data-near-limit"]).toBe("near");

    readPlan.mockResolvedValue(planWith(44));
    await settle(1);
    expect(settledNow).toBe(true);
    expect(noticeOf).toBeNull();

    connection.online = false;
    renderScreen(1);
    expect(settledNow).toBe(false);
    expect(noticeOf).toBeNull();
  });

  it("a linha que sai pela conexão deixa o vão, e só até a leitura responder", async () => {
    readPlan.mockResolvedValue(planWith(47));
    await settle();
    expect(noticeOf?.props["data-near-limit"]).toBe("near");

    connection.online = false;
    renderScreen();
    expect(noticeOf?.props["aria-hidden"]).toBe(true);
    expect(noticeOf?.props["data-near-limit"]).toBeUndefined();
  });
});

describe("a leitura do plano que falha online", () => {
  it("conta como resposta sem linha: some a linha e o vão se solta", async () => {
    readPlan.mockResolvedValue(planWith(47));
    await settle();
    expect(noticeOf?.props["data-near-limit"]).toBe("near");

    readPlan.mockRejectedValue(new Error("rede"));
    await settle(1);
    expect(settledNow).toBe(true);
    expect(noticeOf).toBeNull();
  });

  it("depois de ficar sem conexão, a leitura que falha ao voltar solta o vão guardado", async () => {
    readPlan.mockResolvedValue(planWith(47));
    await settle();

    connection.online = false;
    renderScreen();
    expect(noticeOf?.props["aria-hidden"]).toBe(true);

    connection.online = true;
    readPlan.mockRejectedValue(new Error("rede"));
    await settle();
    expect(settledNow).toBe(true);
    expect(noticeOf).toBeNull();
  });
});
