import { describe, expect, it } from "vitest";
import {
  readSaleAttempt,
  SALE_ATTEMPT_MAX_AGE_MS,
  writeSaleAttempt,
} from "./sale-attempt-storage";
import type { SaleAttempt } from "./sale-form-model";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
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

  it("lasts as long as the draft it was made from", () => {
    const storage = memoryStorage();
    writeSaleAttempt(storage, organizationId, attempt);
    expect(
      readSaleAttempt(storage, organizationId, later, "2026-10-13T14:50:00.000Z")
    ).toEqual(attempt);
  });

  it("an attempt older than the draft belongs to another cart and keeps its own limit", () => {
    const storage = memoryStorage();
    writeSaleAttempt(storage, organizationId, attempt);
    expect(
      readSaleAttempt(storage, organizationId, later, "2026-10-13T14:56:00.000Z")
    ).toBeNull();
  });
});
