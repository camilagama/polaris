import { describe, expect, it } from "vitest";
import {
  clearLegacyOrganizationId,
  LEGACY_ORGANIZATION_KEY,
  type Organization,
  organizationLoadAfterFailure,
  organizationLoadErrorMessage,
  organizationLoadFromList,
  PREFERRED_ORGANIZATION_KEY,
  type PreferenceStorage,
  readPreferredOrganizationId,
  resolveCurrentOrganization,
  selectOrganization,
  writePreferredOrganizationId,
} from "./current-organization-model";

function organization(id: string, name: string): Organization {
  return { id, name, role: "owner", timezone: "America/Sao_Paulo" };
}

const alpha = organization("a0000000-0000-4000-8000-000000000001", "Alfa");
const beta = organization("b0000000-0000-4000-8000-000000000002", "Beta");

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
    throw new Error("quota");
  },
};

describe("resolveCurrentOrganization", () => {
  it("is null when the server lists no organization", () => {
    expect(resolveCurrentOrganization([], null)).toBeNull();
    expect(resolveCurrentOrganization([], alpha.id)).toBeNull();
  });

  it("uses the preference only when the server still lists it", () => {
    expect(resolveCurrentOrganization([alpha, beta], beta.id)).toBe(beta);
    expect(resolveCurrentOrganization([alpha, beta], "c0000000-stale")).toBe(
      alpha
    );
    expect(resolveCurrentOrganization([alpha, beta], null)).toBe(alpha);
  });

  it("never trusts a remembered organization the user no longer belongs to", () => {
    expect(resolveCurrentOrganization([alpha], beta.id)).toBe(alpha);
  });
});

describe("organizationLoadFromList", () => {
  it("is empty without organizations, which opens the onboarding flow", () => {
    expect(organizationLoadFromList([], alpha.id)).toEqual({
      status: "empty",
    });
  });

  it("is ready with the resolved organization and the whole list", () => {
    expect(organizationLoadFromList([alpha, beta], beta.id)).toEqual({
      current: beta,
      organizations: [alpha, beta],
      status: "ready",
    });
  });
});

describe("selectOrganization", () => {
  const ready = organizationLoadFromList([alpha, beta], null);

  it("switches to a listed organization", () => {
    expect(selectOrganization(ready, beta.id)).toMatchObject({
      current: beta,
      status: "ready",
    });
  });

  it("ignores an organization the server did not list", () => {
    expect(selectOrganization(ready, "x")).toBe(ready);
  });

  it("does nothing before the list is ready", () => {
    expect(selectOrganization({ status: "loading" }, alpha.id)).toEqual({
      status: "loading",
    });
    expect(selectOrganization({ status: "empty" }, alpha.id)).toEqual({
      status: "empty",
    });
  });
});

describe("preference storage", () => {
  it("round-trips the preferred organization", () => {
    const { storage, values } = memoryStorage();
    expect(readPreferredOrganizationId(storage)).toBeNull();
    expect(writePreferredOrganizationId(storage, beta.id)).toBe(true);
    expect(values.get(PREFERRED_ORGANIZATION_KEY)).toBe(beta.id);
    expect(readPreferredOrganizationId(storage)).toBe(beta.id);
  });

  it("does not reuse the legacy key as a source of truth, and clears it", () => {
    const { storage, values } = memoryStorage({
      [LEGACY_ORGANIZATION_KEY]: "stale-id",
    });
    expect(readPreferredOrganizationId(storage)).toBeNull();
    clearLegacyOrganizationId(storage);
    expect(values.has(LEGACY_ORGANIZATION_KEY)).toBe(false);
  });

  it("keeps working without storage or when storage throws", () => {
    expect(readPreferredOrganizationId(null)).toBeNull();
    expect(writePreferredOrganizationId(null, alpha.id)).toBe(false);
    expect(readPreferredOrganizationId(brokenStorage)).toBeNull();
    expect(writePreferredOrganizationId(brokenStorage, alpha.id)).toBe(false);
    expect(() => clearLegacyOrganizationId(brokenStorage)).not.toThrow();
    expect(() => clearLegacyOrganizationId(null)).not.toThrow();
  });
});

describe("organizationLoadErrorMessage", () => {
  it("explains the session, availability and generic failures", () => {
    expect(organizationLoadErrorMessage({ code: "UNAUTHORIZED" })).toBe(
      "Não foi possível carregar suas lojas."
    );
    expect(
      organizationLoadErrorMessage({ code: "SERVICE_UNAVAILABLE" })
    ).toContain("indisponível");
    expect(organizationLoadErrorMessage(new TypeError("x"))).toContain(
      "conexão"
    );
  });
});

describe("organizationLoadAfterFailure and the legal acceptance", () => {
  const refusal = {
    code: "FORBIDDEN",
    data: { reason: "legal_acceptance_required" },
    status: 403,
  };
  const input = (error: unknown, atOpen: boolean) => ({
    atOpen,
    cached: [alpha, beta],
    error,
    offlineEnabled: true,
    preferredId: beta.id,
  });

  it("says the acceptance is missing, at open or later, and never opens from the cached copy", () => {
    for (const atOpen of [true, false]) {
      expect(organizationLoadAfterFailure(input(refusal, atOpen))).toEqual({
        fromCache: false,
        load: { atOpen, status: "legal_acceptance_required" },
      });
    }
  });

  it("does not use the copy even with the offline runtime off", () => {
    expect(
      organizationLoadAfterFailure({
        ...input(refusal, true),
        offlineEnabled: false,
      }).load.status
    ).toBe("legal_acceptance_required");
  });

  it("a FORBIDDEN without the reason is still an error", () => {
    const outcome = organizationLoadAfterFailure(
      input({ code: "FORBIDDEN" }, true)
    );
    expect(outcome.fromCache).toBe(false);
    expect(outcome.load.status).toBe("error");
  });

  it("a refused session is still a refused session, and a connection failure still opens the copy", () => {
    expect(
      organizationLoadAfterFailure(input({ code: "UNAUTHORIZED" }, true)).load
    ).toEqual({ atOpen: true, status: "session_ended" });
    const offline = organizationLoadAfterFailure(
      input(new TypeError("Failed to fetch"), true)
    );
    expect(offline.fromCache).toBe(true);
  });
});
