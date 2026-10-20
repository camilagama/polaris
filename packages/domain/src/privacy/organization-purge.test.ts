import { describe, expect, it } from "vitest";
import { PRIVACY_DATA_CATEGORIES } from "../admin/privacy-case";
import { CLOSURE_RECOVERY_WINDOW_DAYS } from "../organization/closure";
import {
  automaticPurgeSchedulingAllowed,
  ORGANIZATION_PURGE_CLOSURE_PERIOD_DAYS,
  ORGANIZATION_PURGE_LEASE_SECONDS,
  ORGANIZATION_PURGE_REFUSALS,
  ORGANIZATION_PURGE_REQUIRED_SCOPE,
  ORGANIZATION_PURGE_STEPS,
  OrganizationPurgeRefusedError,
  organizationExportPrefix,
  organizationMediaPrefix,
  organizationPurgeRefusalFromMessage,
  organizationPurgeRefusalMessage,
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
  review: { state: "pendente_juridica" },
  rule: "Purge 15 dias depois do fim da janela.",
  sources: ["ADR de exemplo"],
  status: "aprovada",
};

describe("the delay the Admin's schedule adds after the closure period", () => {
  it("adds nothing: the closure period is approved in calendar days, not as a delay", () => {
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

describe("automatic scheduling (ADR 0102)", () => {
  it("is allowed: the class is approved with the closure period and its job", () => {
    expect(automaticPurgeSchedulingAllowed()).toBe(true);
    const policy = RETENTION_POLICIES.find(
      (candidate) => candidate.class === "closed_organization"
    );
    expect(policy?.status).toBe("aprovada");
    expect(policy?.period).toEqual({
      days: ORGANIZATION_PURGE_CLOSURE_PERIOD_DAYS,
      kind: "closure_calendar_days",
    });
  });

  it("is turned off by a class put back to proposed, or by a period other than the database's", () => {
    expect(
      automaticPurgeSchedulingAllowed(
        withClosedOrganization(approvedClosedOrganization)
      )
    ).toBe(false);
    expect(
      automaticPurgeSchedulingAllowed(
        withClosedOrganization({
          basis: "decisao",
          class: "closed_organization",
          data: ["x"],
          period: { kind: "undecided" },
          proposed: "x",
          review: { state: "pendente_juridica" },
          rule: "x",
          sources: ["x"],
          status: "proposta",
        })
      )
    ).toBe(false);
    expect(
      automaticPurgeSchedulingAllowed(
        withClosedOrganization({
          basis: "decisao",
          class: "closed_organization",
          data: ["x"],
          job: "privacy.closure_purge_schedule",
          period: { days: 60, kind: "closure_calendar_days" },
          review: { state: "pendente_juridica" },
          rule: "x",
          sources: ["x"],
          status: "aprovada",
        })
      )
    ).toBe(false);
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
      "mark_storage",
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
      "privacy_scope_covers_kept_data",
      "purge_not_scheduled",
      "purge_in_progress",
      "purge_storage_touched",
      "purge_already_done",
      "closure_period_not_elapsed",
      "legal_hold_active",
    ]) {
      expect(ORGANIZATION_PURGE_REFUSALS).toContain(code);
      expect(organizationPurgeRefusalFromMessage(code)).toBe(code);
    }
  });
});

describe("the closure period before a purge", () => {
  it("is 90 days (decision of 19/10/2026), never shorter than the recovery window of a closure", () => {
    expect(ORGANIZATION_PURGE_CLOSURE_PERIOD_DAYS).toBe(90);
    expect(ORGANIZATION_PURGE_CLOSURE_PERIOD_DAYS).toBeGreaterThanOrEqual(
      CLOSURE_RECOVERY_WINDOW_DAYS
    );
  });

  it("is told to the operator with the period and the export, and so is a legal hold", () => {
    expect(
      organizationPurgeRefusalMessage("closure_period_not_elapsed")
    ).toContain("90 dias");
    expect(
      organizationPurgeRefusalMessage("closure_period_not_elapsed")
    ).toContain("exportar");
    expect(organizationPurgeRefusalMessage("legal_hold_active")).toContain(
      "trava legal"
    );
  });
});

describe("the scope a privacy case needs to start a purge", () => {
  it("is every tenant category the purge removes, and none of the data it keeps", () => {
    expect([...ORGANIZATION_PURGE_REQUIRED_SCOPE].sort()).toEqual([
      "customers",
      "inventory_catalog",
      "media",
      "organization_profile",
      "sales",
    ]);
    for (const kept of ["account", "authentication", "billing", "audit_logs"]) {
      expect(ORGANIZATION_PURGE_REQUIRED_SCOPE).not.toContain(kept);
      expect(PRIVACY_DATA_CATEGORIES).toContain(kept);
    }
  });
});

describe("what an operator reads for a refusal", () => {
  it("is a sentence for every refusal, and the ones about the scope and the cancellation say what to do or why", () => {
    for (const code of ORGANIZATION_PURGE_REFUSALS) {
      const message = organizationPurgeRefusalMessage(code);
      expect(message.length, code).toBeGreaterThan(20);
      expect(message, code).not.toContain(code);
    }
    expect(
      organizationPurgeRefusalMessage("privacy_scope_covers_kept_data")
    ).toContain("conta, autenticação, cobrança ou registros de auditoria");
    expect(organizationPurgeRefusalMessage("purge_storage_touched")).toContain(
      "armazenamento"
    );
  });
});
