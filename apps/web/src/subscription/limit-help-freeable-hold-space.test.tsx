import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NearLimitView } from "./limit-help-model";

interface Slot {
  value?: unknown;
}

const runtime = { index: 0, slots: [] as Slot[] };

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
      slot.value = next;
    };
    return [slot.value as T, set];
  },
}));
vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const { NearLimitNotice } = await import("./limit-help");

const FREEABLE_TEXT = "Você tem 3 produtos arquivados sem estoque.";

const withFreeable: NearLimitView = {
  freeableProducts: 3,
  kind: "near",
  proMax: null,
  usage: { max: 50, subject: "images", used: 47 },
};

function draw(view: NearLimitView | null, holdSpace: boolean) {
  runtime.index = 0;
  return NearLimitNotice({
    freeable: "link",
    holdSpace,
    view,
  }) as ReactElement | null;
}

beforeEach(() => {
  runtime.slots = [];
  runtime.index = 0;
});

describe("o segundo parágrafo fora do vão do holdSpace", () => {
  it("com a view à mostra o parágrafo dos arquivados aparece; sem conexão a linha do Pro fica invisível e o parágrafo sai", () => {
    const visible = draw(withFreeable, true);
    const visibleMarkup = renderToStaticMarkup(visible);
    expect(visibleMarkup).toContain(FREEABLE_TEXT);
    expect(visibleMarkup).toContain("data-near-limit-freeable");

    const held = draw(null, true);
    expect(held).not.toBeNull();
    const heldMarkup = renderToStaticMarkup(held);
    expect(heldMarkup).not.toContain(FREEABLE_TEXT);
    expect(heldMarkup).not.toContain("Ver arquivados");
    expect(heldMarkup).toContain('aria-hidden="true"');
    expect(heldMarkup).toContain("invisible");
    expect(heldMarkup).toContain("Conhecer o Pro");
    expect(heldMarkup).not.toContain("data-near-limit=");
    expect(heldMarkup.match(/<p /g)).toHaveLength(1);
  });

  it("controle: sem holdSpace, view null depois de uma view à mostra não renderiza nada", () => {
    draw(withFreeable, false);
    expect(draw(null, false)).toBeNull();
  });
});
