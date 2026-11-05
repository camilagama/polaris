import { beforeEach, describe, expect, it, vi } from "vitest";

interface Slot {
  value?: unknown;
}

const runtime = {
  cursor: 0,
  slots: [] as Slot[],
};

function nextSlot(): Slot {
  const index = runtime.cursor;
  runtime.cursor = index + 1;
  const slot = runtime.slots[index] ?? {};
  runtime.slots[index] = slot;
  return slot;
}

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useEffect: (effect: () => void) => {
    const slot = nextSlot();
    if (!("value" in slot)) {
      slot.value = true;
      effect();
    }
  },
  useRef: <T>(initial: T) => {
    const slot = nextSlot();
    if (!("value" in slot)) {
      slot.value = { current: initial };
    }
    return slot.value as { current: T };
  },
  useState: <T>(initial: T) => {
    const slot = nextSlot();
    if (!("value" in slot)) {
      slot.value = initial;
    }
    const set = (next: T | ((previous: T) => T)) => {
      slot.value =
        typeof next === "function"
          ? (next as (previous: T) => T)(slot.value as T)
          : next;
    };
    return [slot.value as T, set];
  },
}));

const flag = { withCover: false };
const listBalances = vi.fn();

vi.mock("../lib/media-thumbs-flag", () => ({
  useMediaThumbsEnabled: () => flag.withCover,
}));
vi.mock("../lib/orpc", () => ({
  orpcClient: {
    inventory: { listBalances: (input: unknown) => listBalances(input) },
    paymentProfile: { list: () => new Promise(() => undefined) },
  },
}));
vi.mock("../lib/read-with-retry", () => ({
  readWithRetry: <T>(read: () => Promise<T>) => read(),
}));
vi.mock("../lib/current-organization-model", () => ({
  browserStorage: () => null,
}));
vi.mock("../lib/payment-profile-cache", () => ({
  readPaymentProfileCache: () => [],
  writePaymentProfileCache: () => undefined,
}));
vi.mock("../lib/sign-out", () => ({ isSigningOut: () => false }));
vi.mock("../offline/runtime/enabled", () => ({
  OFFLINE_RUNTIME_ENABLED: false,
}));

const { useSaleCatalog } = await import("./use-sale-catalog");

const variantId = "22222222-2222-4222-8222-222222222222";
const coverAssetId = "33333333-3333-4333-8333-333333333333";

function entry(withCover: boolean, quantity: number) {
  return {
    ...(withCover ? { coverAssetId } : {}),
    movingAverageCost: null,
    quantity,
    variantId,
    version: 1,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function render() {
  runtime.cursor = 0;
  return useSaleCatalog("org", () => undefined);
}

beforeEach(() => {
  runtime.slots = [];
  runtime.cursor = 0;
  flag.withCover = false;
  listBalances.mockReset();
});

describe("useSaleCatalog readLines", () => {
  it("an older read that answers after a newer one does not write over its lines", async () => {
    const older = deferred<{ entries: unknown[] }>();
    const newer = deferred<{ entries: unknown[] }>();
    listBalances
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    const first = render();
    const olderRead = first.readLines([variantId]);
    flag.withCover = true;
    const newerRead = render().readLines([variantId]);

    newer.resolve({ entries: [entry(true, 4)] });
    await newerRead;
    older.resolve({ entries: [entry(false, 3)] });
    await olderRead;

    expect(render().stock[variantId]).toEqual({
      status: "ready",
      value: {
        coverAssetId,
        movingAverageCost: null,
        quantity: 4,
        variantId,
        version: 1,
      },
    });
  });

  it("a refresh in flight does not write over the lines read after it", async () => {
    const refreshing = deferred<{ entries: unknown[] }>();
    const reading = deferred<{ entries: unknown[] }>();
    listBalances
      .mockReturnValueOnce(refreshing.promise)
      .mockReturnValueOnce(reading.promise);

    render().refresh([variantId]);
    flag.withCover = true;
    const read = render().readLines([variantId]);

    reading.resolve({ entries: [entry(true, 4)] });
    await read;
    refreshing.resolve({ entries: [entry(false, 3)] });
    await refreshing.promise;
    await Promise.resolve();

    expect(render().stock[variantId]).toMatchObject({
      status: "ready",
      value: { coverAssetId, quantity: 4 },
    });
  });

  it("a read that fails after replacing a refresh in flight does not leave its lines loading", async () => {
    const refreshing = deferred<{ entries: unknown[] }>();
    listBalances
      .mockReturnValueOnce(refreshing.promise)
      .mockRejectedValueOnce(new Error("offline"));

    render().refresh([variantId]);
    expect(render().stock[variantId]).toEqual({ status: "loading" });
    const entries = await render().readLines([variantId]);
    refreshing.resolve({ entries: [entry(false, 3)] });
    await refreshing.promise;
    await Promise.resolve();

    expect(entries).toBeNull();
    expect(render().stock[variantId]?.status).toBe("error");
  });
});
