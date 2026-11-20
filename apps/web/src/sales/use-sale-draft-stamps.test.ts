// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSaleDraft, writeSaleDraft } from "./sale-draft-storage";
import { createBlankSaleForm, updateItem } from "./sale-form-model";
import { useSaleDraftStamps } from "./use-sale-draft-stamps";

const ORG = "0199c2d0-0000-7000-8000-00000000a001";
const SAO_PAULO = "America/Sao_Paulo";
const VARIANT = "0199c2d0-0000-7000-8000-0000000000b1";
const PRODUCT = "0199c2d0-0000-7000-8000-0000000000f1";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

function cart() {
  return updateItem(
    createBlankSaleForm(() => "draft-1"),
    "draft-1",
    {
      chargedUnitPrice: "49,90",
      label: "Camiseta · Azul",
      listedUnitPrice: "49,90",
      productId: PRODUCT,
      quantity: "1",
      variantId: VARIANT,
    }
  );
}

const START = "2026-11-11T02:00:00.000Z";
// 23:50 in São Paulo
const CHANGED = "2026-11-11T02:50:00.000Z";
const OPENED = new Date("2026-11-11T08:40:00.000Z");

function restored() {
  const storage = memoryStorage();
  writeSaleDraft(storage, ORG, {
    form: cart(),
    startedAt: START,
    updatedAt: CHANGED,
  });
  const read = readSaleDraft(storage, ORG, OPENED, SAO_PAULO);
  if (read.kind !== "restored") {
    throw new Error("the cart must be restored at 05:40");
  }
  return { draft: read.draft, storage };
}

const kindAt = (
  storage: ReturnType<typeof memoryStorage>,
  iso: string
): string => readSaleDraft(storage, ORG, new Date(iso), SAO_PAULO).kind;

describe("the stamps of the cart in the tab", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: OPENED, toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps updatedAt when the cart is opened and written back again (prices read again)", () => {
    const { draft, storage } = restored();
    const { result } = renderHook(() => useSaleDraftStamps(draft));

    writeSaleDraft(storage, ORG, {
      form: draft.form,
      ...result.current.stamp(),
    });
    writeSaleDraft(storage, ORG, {
      form: draft.form,
      ...result.current.stamp(),
    });

    expect(kindAt(storage, "2026-11-11T08:50:00.000Z")).toBe("restored");
    expect(kindAt(storage, "2026-11-11T08:51:00.000Z")).toBe("expired");
  });

  it("moves updatedAt with the person's change: the cart then lasts six hours from it", () => {
    const { draft, storage } = restored();
    const { result } = renderHook(() => useSaleDraftStamps(draft));

    act(() => result.current.markEdited());
    writeSaleDraft(storage, ORG, {
      form: draft.form,
      ...result.current.stamp(),
    });

    expect(kindAt(storage, "2026-11-11T14:40:00.000Z")).toBe("restored");
    expect(kindAt(storage, "2026-11-11T14:41:00.000Z")).toBe("expired");
  });

  it("never moves startedAt, however many times the person changes the cart", () => {
    const { draft } = restored();
    const { result } = renderHook(() => useSaleDraftStamps(draft));

    act(() => result.current.markEdited());
    vi.setSystemTime(new Date("2026-11-11T09:30:00.000Z"));
    act(() => result.current.markEdited());

    expect(result.current.stamp()).toEqual({
      startedAt: START,
      updatedAt: "2026-11-11T09:30:00.000Z",
    });
  });

  it("starts a new cart with both instants at its first change, and forgets them on reset", () => {
    const { result } = renderHook(() => useSaleDraftStamps(null));

    act(() => result.current.markEdited());
    expect(result.current.stamp()).toEqual({
      startedAt: OPENED.toISOString(),
      updatedAt: OPENED.toISOString(),
    });
    act(() => result.current.reset());
    expect(result.current.startedAt.current).toBeNull();
  });

  it("gives a draft written without updatedAt the instant of its start", () => {
    const { result } = renderHook(() =>
      useSaleDraftStamps({ form: cart(), startedAt: START })
    );

    expect(result.current.stamp()).toEqual({
      startedAt: START,
      updatedAt: START,
    });
  });
});
