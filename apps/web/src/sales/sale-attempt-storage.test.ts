import { describe, expect, it } from "vitest";
import {
  clearSaleAttempts,
  readSaleAttempt,
  readSaleAttemptState,
  SALE_ATTEMPT_MAX_AGE_MS,
  saleMayBeOnServer,
  writeSaleAttempt,
} from "./sale-attempt-storage";
import type { SaleAttempt } from "./sale-form-model";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

const organizationId = "0198e5f0-0000-7000-8000-000000000001";
const now = new Date("2026-10-13T15:00:00.000Z");
const attempt: SaleAttempt = {
  commandId: "0198e5f0-0000-7000-8000-0000000000aa",
  occurredAt: "2026-10-13T14:55:00.000Z",
  recordedAt: "2026-10-13T14:55:00.000Z",
  signature: '{"body":{}}',
};

describe("pending sale attempt storage", () => {
  it("knows a command was sent before with no answer only from its second send on, and keeps it after a refusal settles", () => {
    const storage = memoryStorage();
    const sentBefore = () =>
      saleMayBeOnServer(storage, organizationId, attempt.commandId);
    writeSaleAttempt(storage, organizationId, attempt, true, true);
    expect(sentBefore()).toBe(false);
    writeSaleAttempt(storage, organizationId, attempt, true);
    expect(sentBefore()).toBe(false);
    writeSaleAttempt(storage, organizationId, attempt, true, true);
    expect(sentBefore()).toBe(true);
    writeSaleAttempt(storage, organizationId, attempt, false);
    expect(sentBefore()).toBe(true);
    writeSaleAttempt(storage, organizationId, attempt, true, true);
    expect(sentBefore()).toBe(true);
    expect(saleMayBeOnServer(storage, organizationId, "outro")).toBe(true);
  });

  it("cannot rule out the sale when the storage is blocked or holds no attempt of the command", () => {
    expect(saleMayBeOnServer(null, organizationId, attempt.commandId)).toBe(
      true
    );
    expect(
      saleMayBeOnServer(memoryStorage(), organizationId, attempt.commandId)
    ).toBe(true);
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => undefined,
      setItem: () => undefined,
    };
    expect(saleMayBeOnServer(throwing, organizationId, attempt.commandId)).toBe(
      true
    );
  });

  it("does not carry the mark to another command, nor from a first try refused for good", () => {
    const storage = memoryStorage();
    writeSaleAttempt(storage, organizationId, attempt, true, true);
    writeSaleAttempt(storage, organizationId, attempt, false);
    writeSaleAttempt(storage, organizationId, attempt, true, true);
    expect(saleMayBeOnServer(storage, organizationId, attempt.commandId)).toBe(
      false
    );
    writeSaleAttempt(storage, organizationId, attempt, true);
    const other = { ...attempt, commandId: "novo" };
    writeSaleAttempt(storage, organizationId, other, true, true);
    expect(saleMayBeOnServer(storage, organizationId, "novo")).toBe(false);
  });

  it("keeps the profile and version of the send, and reads an older attempt without them", () => {
    const storage = memoryStorage();
    const sent = {
      ...attempt,
      paymentProfile: { expectedVersion: 3, id: "profile-1" },
    };
    writeSaleAttempt(storage, organizationId, sent, true);
    expect(readSaleAttempt(storage, organizationId, now)).toEqual(sent);

    storage.setItem(
      `polaris.sale.attempt.v1:${organizationId}`,
      JSON.stringify({ ...attempt, paymentProfile: { id: "p" } })
    );
    expect(
      readSaleAttempt(storage, organizationId, now)?.paymentProfile
    ).toBeUndefined();
  });

  it("returns the stored attempt after a reload", () => {
    const storage = memoryStorage();
    writeSaleAttempt(storage, organizationId, attempt);
    expect(readSaleAttempt(storage, organizationId, now)).toEqual(attempt);
  });

  it("keeps attempts apart per organization", () => {
    const storage = memoryStorage();
    writeSaleAttempt(storage, organizationId, attempt);
    expect(readSaleAttempt(storage, "other-organization", now)).toBeNull();
  });

  it("forgets an attempt written as null", () => {
    const storage = memoryStorage();
    writeSaleAttempt(storage, organizationId, attempt);
    writeSaleAttempt(storage, organizationId, null);
    expect(readSaleAttempt(storage, organizationId, now)).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it("drops an old attempt so it cannot swallow a new identical sale", () => {
    const storage = memoryStorage();
    writeSaleAttempt(storage, organizationId, attempt);
    const later = new Date(
      new Date(attempt.recordedAt).getTime() + SALE_ATTEMPT_MAX_AGE_MS + 1
    );
    expect(readSaleAttempt(storage, organizationId, later)).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it("ignores unreadable or malformed content", () => {
    const storage = memoryStorage();
    storage.setItem(`polaris.sale.attempt.v1:${organizationId}`, "{not json");
    expect(readSaleAttempt(storage, organizationId, now)).toBeNull();
    storage.setItem(
      `polaris.sale.attempt.v1:${organizationId}`,
      JSON.stringify({ commandId: 1 })
    );
    expect(readSaleAttempt(storage, organizationId, now)).toBeNull();
  });

  it("works without storage", () => {
    expect(readSaleAttempt(null, organizationId, now)).toBeNull();
    expect(() => writeSaleAttempt(null, organizationId, attempt)).not.toThrow();
  });
});

describe("the attempt of a cart that came back from the tab's draft", () => {
  const later = new Date(
    new Date(attempt.recordedAt).getTime() + SALE_ATTEMPT_MAX_AGE_MS + 60_000
  );

  it("lasts as long as the draft it was made from, while its outcome is unknown", () => {
    const storage = memoryStorage();
    writeSaleAttempt(storage, organizationId, attempt, true);
    expect(
      readSaleAttempt(
        storage,
        organizationId,
        later,
        "2026-10-13T14:50:00.000Z"
      )
    ).toEqual(attempt);
  });

  it("after a definite refusal it keeps its own limit: a retry hours later is a new instant", () => {
    const storage = memoryStorage();
    writeSaleAttempt(storage, organizationId, attempt, false);
    expect(
      readSaleAttempt(
        storage,
        organizationId,
        later,
        "2026-10-13T14:50:00.000Z"
      )
    ).toBeNull();
  });

  it("an attempt older than the draft belongs to another cart and keeps its own limit", () => {
    const storage = memoryStorage();
    writeSaleAttempt(storage, organizationId, attempt, true);
    expect(
      readSaleAttempt(
        storage,
        organizationId,
        later,
        "2026-10-13T14:56:00.000Z"
      )
    ).toBeNull();
  });
});

describe("whether the outcome of the attempt is unknown", () => {
  const draftStartedAt = "2026-10-13T14:50:00.000Z";

  it("is unknown only for an unsettled attempt made for the cart that came back", () => {
    const storage = memoryStorage();
    writeSaleAttempt(storage, organizationId, attempt, true);
    expect(
      readSaleAttemptState(storage, organizationId, now, draftStartedAt)
    ).toEqual({ attempt, outcomeUnknown: true, unsettled: true });
    expect(readSaleAttemptState(storage, organizationId, now)).toEqual({
      attempt,
      outcomeUnknown: false,
      unsettled: true,
    });
    expect(
      readSaleAttemptState(
        storage,
        organizationId,
        now,
        "2026-10-13T14:56:00.000Z"
      )?.outcomeUnknown
    ).toBe(false);

    writeSaleAttempt(storage, organizationId, attempt, false);
    expect(
      readSaleAttemptState(storage, organizationId, now, draftStartedAt)
    ).toMatchObject({ outcomeUnknown: false, unsettled: false });
  });
});

describe("clearing the attempts of the tab", () => {
  const other = "0198e5f0-0000-7000-8000-000000000002";

  it("forgets every store's attempt, or all but the store just chosen, and nothing else of the tab", () => {
    const storage = memoryStorage();
    writeSaleAttempt(storage, organizationId, attempt, true);
    writeSaleAttempt(storage, other, attempt, true);
    storage.setItem(`polaris.sale.draft.v1:${organizationId}`, "{}");

    clearSaleAttempts(storage, other);
    expect([...storage.data.keys()].sort()).toEqual([
      `polaris.sale.attempt.v1:${other}`,
      `polaris.sale.draft.v1:${organizationId}`,
    ]);

    clearSaleAttempts(storage);
    expect([...storage.data.keys()]).toEqual([
      `polaris.sale.draft.v1:${organizationId}`,
    ]);
  });

  it("keeps the attempts sent with no answer when asked, and forgets the settled ones", () => {
    const storage = memoryStorage();
    const third = "0198e5f0-0000-7000-8000-000000000003";
    writeSaleAttempt(storage, organizationId, attempt, true);
    writeSaleAttempt(storage, other, attempt, false);
    storage.setItem(`polaris.sale.attempt.v1:${third}`, "{}");

    clearSaleAttempts(storage, third, true);
    expect([...storage.data.keys()].sort()).toEqual([
      `polaris.sale.attempt.v1:${organizationId}`,
      `polaris.sale.attempt.v1:${third}`,
    ]);
    expect(readSaleAttempt(storage, organizationId, now)?.commandId).toBe(
      attempt.commandId
    );

    clearSaleAttempts(storage, third);
    expect([...storage.data.keys()]).toEqual([
      `polaris.sale.attempt.v1:${third}`,
    ]);
  });

  it("a storage that refuses or cannot list its keys does not break the page", () => {
    const blocked = {
      getItem: () => null,
      key: () => {
        throw new Error("blocked");
      },
      length: 1,
      removeItem: () => undefined,
      setItem: () => undefined,
    };
    expect(() => clearSaleAttempts(blocked)).not.toThrow();
    expect(() => clearSaleAttempts(null)).not.toThrow();
  });
});
