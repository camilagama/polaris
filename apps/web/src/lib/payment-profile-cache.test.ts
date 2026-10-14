import type { PaymentProfileReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import type { PreferenceStorage } from "./current-organization-model";
import {
  clearPaymentProfileCaches,
  readPaymentProfileCache,
  writePaymentProfileCache,
} from "./payment-profile-cache";

const ORG = "0199c2d0-0000-7000-8000-00000000a001";
const OTHER = "0199c2d0-0000-7000-8000-00000000a002";
const AT = "2026-10-14T12:00:00.000Z";
const profile = (
  n: number,
  overrides: Partial<PaymentProfileReadModel> = {}
): PaymentProfileReadModel => ({
  archivedAt: null,
  createdAt: AT,
  id: `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  name: `Maquininha ${n}`,
  organizationId: ORG,
  rules: [],
  status: "active",
  updatedAt: AT,
  version: 2,
  ...overrides,
});

function memoryStorage() {
  const values = new Map<string, string>();
  const storage: PreferenceStorage & Pick<Storage, "key" | "length"> = {
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  return { storage, values };
}

describe("the payment profiles kept for selling without a connection", () => {
  it("reads back what was written, per organization", () => {
    const { storage } = memoryStorage();
    writePaymentProfileCache(storage, ORG, [profile(1), profile(2)]);
    expect(readPaymentProfileCache(storage, ORG).map((p) => p.id)).toEqual([
      profile(1).id,
      profile(2).id,
    ]);
    expect(readPaymentProfileCache(storage, OTHER)).toEqual([]);
  });

  it("offers only active profiles of the contract's shape, and nothing from a corrupt copy", () => {
    const { storage, values } = memoryStorage();
    writePaymentProfileCache(storage, ORG, [
      profile(1),
      profile(2, { status: "archived" }),
    ]);
    expect(readPaymentProfileCache(storage, ORG)).toHaveLength(1);

    values.set(
      `polaris.offline.paymentProfiles.${ORG}`,
      JSON.stringify([{ id: "x" }])
    );
    expect(readPaymentProfileCache(storage, ORG)).toEqual([]);
    values.set(`polaris.offline.paymentProfiles.${ORG}`, "not json");
    expect(readPaymentProfileCache(storage, ORG)).toEqual([]);
    expect(readPaymentProfileCache(null, ORG)).toEqual([]);
  });

  it("forgets every organization's profiles and nothing else when the session ends", () => {
    const { storage, values } = memoryStorage();
    writePaymentProfileCache(storage, ORG, [profile(1)]);
    writePaymentProfileCache(storage, OTHER, [profile(2)]);
    storage.setItem("polaris.preferredOrganizationId", ORG);
    clearPaymentProfileCaches(storage);
    expect([...values.keys()]).toEqual(["polaris.preferredOrganizationId"]);
    expect(() => clearPaymentProfileCaches(null)).not.toThrow();
  });
});
