import { describe, expect, it } from "vitest";
import {
  approvedRetention,
  isRetentionClass,
  RETENTION_CLASSES,
  RETENTION_POLICIES,
  RETENTION_PURGE_JOBS,
  RetentionNotApprovedError,
  retentionExpiry,
  retentionPolicy,
} from "./retention";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

describe("the retention registry", () => {
  it("declares every class once, in one place", () => {
    expect(RETENTION_POLICIES.map((policy) => policy.class)).toEqual([
      ...RETENTION_CLASSES,
    ]);
    expect(new Set(RETENTION_CLASSES).size).toBe(RETENTION_CLASSES.length);
  });

  it("does not use one period for everything", () => {
    const approvedDurations = RETENTION_POLICIES.flatMap((policy) =>
      policy.status === "aprovada" && policy.period.kind === "duration"
        ? [policy.period.ms]
        : []
    );
    expect(new Set(approvedDurations).size).toBeGreaterThan(1);
    expect(
      RETENTION_POLICIES.some((policy) => policy.status === "proposta")
    ).toBe(true);
  });

  it("says where each policy comes from and what it covers", () => {
    for (const policy of RETENTION_POLICIES) {
      expect(["lei", "contrato", "decisao"]).toContain(policy.basis);
      expect(policy.data.length).toBeGreaterThan(0);
      expect(policy.sources.length).toBeGreaterThan(0);
      expect(policy.rule.trim()).not.toBe("");
    }
  });

  it("approves a legal period only with the decision's date and the norm it rests on", () => {
    for (const policy of RETENTION_POLICIES) {
      if (policy.basis === "lei" && policy.status === "aprovada") {
        expect(policy.approvedOn, policy.class).toMatch(ISO_DATE);
        expect(policy.legalSources?.length, policy.class).toBeGreaterThan(0);
      }
    }
  });

  it("never approves a period without saying when, outside the classes decided earlier", () => {
    const decidedBefore = new Set<string>([
      "media_staging_marker",
      "media_removed_image",
      "queue_processing",
    ]);
    for (const policy of RETENTION_POLICIES) {
      if (policy.status === "aprovada" && !decidedBefore.has(policy.class)) {
        expect(policy.approvedOn, policy.class).toBeDefined();
      }
    }
  });
});

describe("purge jobs", () => {
  it("exist only for approved classes with a period", () => {
    for (const job of RETENTION_PURGE_JOBS) {
      const policy = retentionPolicy(job.class);
      expect(policy.status).toBe("aprovada");
      expect(policy.period.kind).toBe("duration");
    }
  });

  it("are the jobs the approved policies point to, and only those", () => {
    const pointed = RETENTION_POLICIES.flatMap((policy) =>
      "job" in policy && policy.job ? [policy.job] : []
    ).sort();
    expect(RETENTION_PURGE_JOBS.map((job) => job.id).sort()).toEqual(pointed);
  });
});

describe("approved periods", () => {
  it("keep a staging marker 24 hours and a removed image one hour", () => {
    expect(approvedRetention("media_staging_marker")).toBe(24 * HOUR_MS);
    expect(approvedRetention("media_removed_image")).toBe(HOUR_MS);
  });

  it("keep a data export 24 hours, as ADR 0078 decided", () => {
    expect(approvedRetention("data_exports")).toBe(24 * HOUR_MS);
  });

  it("refuse a class whose policy is only proposed", () => {
    expect(() => approvedRetention("sync_change_log")).toThrow(
      RetentionNotApprovedError
    );
    expect(() => approvedRetention("sales_records")).toThrow(
      "retention_not_approved"
    );
  });

  it("keep the offline command log 90 days, the age the server refuses", () => {
    expect(approvedRetention("sync_commands")).toBe(90 * DAY_MS);
  });

  it("keep sessions 30 days after they end and a verification token one day after it expires", () => {
    expect(approvedRetention("auth_sessions")).toBe(30 * DAY_MS);
    expect(approvedRetention("auth_verification")).toBe(DAY_MS);
  });

  it("keep the access record six calendar months, as the Marco Civil asks", () => {
    const policy = retentionPolicy("auth_security_audit");
    expect(policy.status).toBe("aprovada");
    expect(policy.period).toEqual({ kind: "calendar_months", months: 6 });
    expect(() => approvedRetention("auth_security_audit")).toThrow(
      RetentionNotApprovedError
    );
    expect(
      retentionExpiry(
        "auth_security_audit",
        new Date("2026-08-31T10:00:00.000Z")
      ).toISOString()
    ).toBe("2027-03-03T10:00:00.000Z");
    expect(
      retentionExpiry(
        "auth_security_audit",
        new Date("2026-10-18T10:00:00.000Z")
      ).toISOString()
    ).toBe("2027-04-18T10:00:00.000Z");
  });

  it("leave the provider backups to the provider's own rotation", () => {
    const policy = retentionPolicy("provider_backups");
    expect(policy.status).toBe("aprovada");
    expect(policy.period).toEqual({ kind: "provider_rotation" });
    expect(() => retentionExpiry("provider_backups", new Date())).toThrow(
      RetentionNotApprovedError
    );
  });

  it("count an expiry from a moment for a duration and refuse a proposed class", () => {
    expect(
      retentionExpiry(
        "sync_commands",
        new Date("2026-01-01T00:00:00.000Z")
      ).toISOString()
    ).toBe("2026-04-01T00:00:00.000Z");
    expect(() => retentionExpiry("sync_change_log", new Date())).toThrow(
      RetentionNotApprovedError
    );
  });

  it("treat the tenant audit as proposed while its legal period is open", () => {
    expect(retentionPolicy("tenant_audit_events").status).toBe("proposta");
    expect(() => approvedRetention("tenant_audit_events")).toThrow(
      RetentionNotApprovedError
    );
  });
});

describe("class names", () => {
  it("recognizes only declared classes", () => {
    expect(isRetentionClass("sync_commands")).toBe(true);
    expect(isRetentionClass("everything")).toBe(false);
  });
});
