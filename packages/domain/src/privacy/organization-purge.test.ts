import { describe, expect, it } from "vitest";
import {
  automaticPurgeSchedulingAllowed,
  ORGANIZATION_PURGE_LEASE_SECONDS,
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

describe("refusals to schedule a purge", () => {
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
});
