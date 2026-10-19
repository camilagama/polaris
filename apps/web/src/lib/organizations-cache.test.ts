import { describe, expect, it } from "vitest";
import {
  canUseCachedOrganizations,
  clearOrganizationsCache,
  ORGANIZATIONS_CACHE_KEY,
  type Organization,
  organizationLoadAfterFailure,
  type PreferenceStorage,
  readOrganizationsCache,
  writeOrganizationsCache,
} from "./current-organization-model";

const alpha: Organization = {
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Alfa",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const beta: Organization = {
  id: "b0000000-0000-4000-8000-000000000002",
  name: "Beta",
  role: "seller",
  timezone: "America/Sao_Paulo",
};

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: PreferenceStorage = {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  return { storage, values };
}

const brokenStorage: PreferenceStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

const rpcError = (code: string) => Object.assign(new Error(code), { code });

describe("the organizations kept for opening offline", () => {
  it("keeps only the four fields of each organization and reads them back", () => {
    const { storage, values } = memoryStorage();
    writeOrganizationsCache(storage, [
      { ...alpha, extra: "not kept" } as Organization,
      beta,
    ]);
    expect(readOrganizationsCache(storage)).toEqual([alpha, beta]);
    expect(values.get(ORGANIZATIONS_CACHE_KEY)).not.toContain("extra");
  });

  it("reads nothing from a missing, corrupt or malformed copy, and drops the bad rows", () => {
    expect(readOrganizationsCache(memoryStorage().storage)).toEqual([]);
    for (const text of ["not json", "{}", "[1,null,{}]"]) {
      expect(
        readOrganizationsCache(
          memoryStorage({ [ORGANIZATIONS_CACHE_KEY]: text }).storage
        )
      ).toEqual([]);
    }
    const mixed = JSON.stringify([alpha, { id: "x" }, beta]);
    expect(
      readOrganizationsCache(
        memoryStorage({ [ORGANIZATIONS_CACHE_KEY]: mixed }).storage
      )
    ).toEqual([alpha, beta]);
  });

  it("clears the copy, and blocked storage never throws", () => {
    const { storage, values } = memoryStorage();
    writeOrganizationsCache(storage, [alpha]);
    clearOrganizationsCache(storage);
    expect(values.has(ORGANIZATIONS_CACHE_KEY)).toBe(false);
    expect(() => writeOrganizationsCache(brokenStorage, [alpha])).not.toThrow();
    expect(readOrganizationsCache(brokenStorage)).toEqual([]);
    expect(() => clearOrganizationsCache(brokenStorage)).not.toThrow();
    expect(() => writeOrganizationsCache(null, [alpha])).not.toThrow();
  });
});

describe("answering a failed read from the device's copy", () => {
  it("answers from the copy only for a connection or server failure", () => {
    expect(canUseCachedOrganizations(new TypeError("Failed to fetch"))).toBe(
      true
    );
    expect(canUseCachedOrganizations(rpcError("SERVICE_UNAVAILABLE"))).toBe(
      true
    );
    expect(canUseCachedOrganizations(rpcError("INTERNAL_SERVER_ERROR"))).toBe(
      true
    );
    expect(canUseCachedOrganizations(rpcError("TOO_MANY_REQUESTS"))).toBe(true);
    for (const code of ["UNAUTHORIZED", "FORBIDDEN", "BAD_REQUEST"]) {
      expect(canUseCachedOrganizations(rpcError(code))).toBe(false);
    }
  });

  it("opens the preferred organization from the copy when offline", () => {
    const outcome = organizationLoadAfterFailure({
      atOpen: true,
      cached: [alpha, beta],
      error: new TypeError("Failed to fetch"),
      offlineEnabled: true,
      preferredId: beta.id,
    });
    expect(outcome.fromCache).toBe(true);
    expect(outcome.load).toMatchObject({
      current: beta,
      status: "ready",
    });
  });

  it("shows the error when the runtime is off or the copy is empty", () => {
    const network = new TypeError("Failed to fetch");
    for (const input of [
      { cached: [alpha], error: network, offlineEnabled: false },
      { cached: [], error: network, offlineEnabled: true },
    ]) {
      const outcome = organizationLoadAfterFailure({
        ...input,
        atOpen: true,
        preferredId: null,
      });
      expect(outcome.fromCache).toBe(false);
      expect(outcome.load.status).toBe("error");
    }
  });

  it("says the session ended, never from the copy, and whether it was the read that opens the app", () => {
    for (const atOpen of [true, false]) {
      const outcome = organizationLoadAfterFailure({
        atOpen,
        cached: [alpha],
        error: rpcError("UNAUTHORIZED"),
        offlineEnabled: true,
        preferredId: null,
      });
      expect(outcome.fromCache).toBe(false);
      expect(outcome.load).toEqual({ atOpen, status: "session_ended" });
    }
  });

  it("opens from the copy on a 429 or a 5xx, never taking them for a refusal of the session (AC-11)", () => {
    for (const error of [
      rpcError("TOO_MANY_REQUESTS"),
      rpcError("SERVICE_UNAVAILABLE"),
      rpcError("INTERNAL_SERVER_ERROR"),
    ]) {
      const outcome = organizationLoadAfterFailure({
        atOpen: true,
        cached: [alpha],
        error,
        offlineEnabled: true,
        preferredId: null,
      });
      expect(outcome.fromCache).toBe(true);
      expect(outcome.load.status).toBe("ready");
    }
  });
});
