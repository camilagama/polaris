import { describe, expect, it } from "vitest";
import {
  approvedRetention,
  isRetentionClass,
  RETENTION_CLASSES,
  RETENTION_POLICIES,
  RETENTION_PURGE_JOBS,
  RetentionNotApprovedError,
  retentionPolicy,
} from "./retention";

const HOUR_MS = 3_600_000;

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

  it("leaves a legal period to the person responsible, never to the code", () => {
    for (const policy of RETENTION_POLICIES) {
      if (policy.basis === "lei") {
        expect(policy.status).toBe("proposta");
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
    expect(() => approvedRetention("sync_commands")).toThrow(
      RetentionNotApprovedError
    );
    expect(() => approvedRetention("sales_records")).toThrow(
      "retention_not_approved"
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
