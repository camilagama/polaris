import { describe, expect, it } from "vitest";
import { PRIVACY_DATA_CATEGORIES } from "../admin/privacy-case";
import {
  automaticPurgeSchedulingAllowed,
  ORGANIZATION_PURGE_LEASE_SECONDS,
  ORGANIZATION_PURGE_REFUSALS,
  ORGANIZATION_PURGE_REQUIRED_SCOPE,
  ORGANIZATION_PURGE_STEPS,
  OrganizationPurgeRefusedError,
  organizationExportPrefix,
  organizationMediaPrefix,
  organizationPurgeRefusalFromMessage,
  purgeDelayAfterWindowMs,
} from "./organization-purge";
import { RETENTION_POLICIES, type RetentionPolicy } from "./retention";

const DAY_MS = 86_400_000;

const withClosedOrganization = (
  policy: RetentionPolicy
): readonly RetentionPolicy[] =>
  RETENTION_POLICIES.map((candidate) =>
    candidate.class === "closed_organization" ? policy : candidate
  );

const approvedClosedOrganization: RetentionPolicy = {
  basis: "decisao",
  class: "closed_organization",
  data: ["todos os dados de uma organização closed"],
  period: { kind: "duration", ms: 15 * DAY_MS },
  rule: "Purge 15 dias depois do fim da janela.",
  sources: ["ADR de exemplo"],
  status: "aprovada",
};

describe("the delay between the end of the recovery window and the purge", () => {
  it("adds nothing while the closed organization class is only proposed", () => {
    expect(purgeDelayAfterWindowMs()).toBe(0);
  });

  it("is read from the registry, never from a constant of its own", () => {
    expect(
      purgeDelayAfterWindowMs(
        withClosedOrganization(approvedClosedOrganization)
      )
    ).toBe(15 * DAY_MS);
  });
});

describe("automatic scheduling", () => {
  it("is not allowed while the closed organization class is proposed", () => {
    expect(automaticPurgeSchedulingAllowed()).toBe(false);
  });

  it("would need the class approved with a period", () => {
    expect(
      automaticPurgeSchedulingAllowed(
        withClosedOrganization(approvedClosedOrganization)
      )
    ).toBe(true);
  });
});

describe("the storage prefixes of an organization", () => {
  it("hold the exports and the image masters under the organization's ID", () => {
    expect(organizationExportPrefix("org_1")).toBe("exports/v1/org_1/");
    expect(organizationMediaPrefix("org_1")).toBe("media/v2/org_1/");
  });

  it("refuse an ID that could reach outside the organization's prefix", () => {
    for (const bad of ["", "a/b", "..", "org 1", "x".repeat(65)]) {
      expect(() => organizationExportPrefix(bad)).toThrow(
        "invalid_organization_id"
      );
      expect(() => organizationMediaPrefix(bad)).toThrow(
        "invalid_organization_id"
      );
    }
  });
});

describe("the purge workflow", () => {
  it("removes the storage before the rows and sweeps it again after", () => {
    expect(ORGANIZATION_PURGE_STEPS).toEqual([
      "exports_storage",
      "media_storage",
      "database",
      "second_sweep",
    ]);
  });

  it("holds a purge longer than an export holds its lease", () => {
    expect(ORGANIZATION_PURGE_LEASE_SECONDS).toBeGreaterThan(10 * 60);
  });
});

describe("refusals to schedule or cancel a purge", () => {
  it("are named from the database message, and nothing else is", () => {
    expect(organizationPurgeRefusalFromMessage("recovery_window_open")).toBe(
      "recovery_window_open"
    );
    expect(organizationPurgeRefusalFromMessage("paid_access_running")).toBe(
      "paid_access_running"
    );
    expect(organizationPurgeRefusalFromMessage("syntax error")).toBeNull();
    expect(new OrganizationPurgeRefusedError("tenant_access_active").code).toBe(
      "tenant_access_active"
    );
  });

  it("name the case rules and the cancellation, and each one maps back from its message", () => {
    for (const code of [
      "privacy_case_required",
      "privacy_case_not_deletion",
      "privacy_requester_not_owner",
      "privacy_case_not_accepted",
      "privacy_scope_incomplete",
      "purge_not_scheduled",
      "purge_in_progress",
      "purge_already_done",
    ]) {
      expect(ORGANIZATION_PURGE_REFUSALS).toContain(code);
      expect(organizationPurgeRefusalFromMessage(code)).toBe(code);
    }
  });
});

describe("the scope a privacy case needs to start a purge", () => {
  it("is every tenant category the purge removes, and none of the data it keeps", () => {
    expect([...ORGANIZATION_PURGE_REQUIRED_SCOPE].sort()).toEqual([
      "audit_logs",
      "customers",
      "inventory_catalog",
      "media",
      "organization_profile",
      "sales",
    ]);
    for (const kept of ["account", "authentication", "billing"]) {
      expect(ORGANIZATION_PURGE_REQUIRED_SCOPE).not.toContain(kept);
      expect(PRIVACY_DATA_CATEGORIES).toContain(kept);
    }
  });
});
