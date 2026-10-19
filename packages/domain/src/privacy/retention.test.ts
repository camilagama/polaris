import { describe, expect, it } from "vitest";
import {
  ADMIN_TRIGGERED_REMOVALS,
  activeRetentionBlocker,
  approvedRetention,
  blockedPurgeJobs,
  isRetentionClass,
  legalReviewDefects,
  pendingLegalReviews,
  RETENTION_CLASSES,
  RETENTION_POLICIES,
  RESOLVED_RETENTION_BLOCKERS,
  RETENTION_PURGE_JOBS,
  type RetentionClass,
  RetentionNotApprovedError,
  type RetentionPolicy,
  TENANT_AUDIT_RETENTION,
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

const withPolicy = (
  retentionClass: RetentionClass,
  change: Partial<RetentionPolicy>
): readonly RetentionPolicy[] =>
  RETENTION_POLICIES.map((policy) =>
    policy.class === retentionClass
      ? ({ ...policy, ...change } as RetentionPolicy)
      : policy
  );

describe("legal review", () => {
  it("is declared for every class whose basis is the law, pending until validated", () => {
    expect(legalReviewDefects()).toEqual([]);
    for (const policy of RETENTION_POLICIES) {
      if (policy.basis === "lei") {
        expect(policy.legalReview, policy.class).toBeDefined();
      }
    }
    // a legal class is pending until a named reviewer validates it; none may be reviewed by default
    const legal = RETENTION_POLICIES.filter(
      (policy) => policy.basis === "lei"
    ).map((policy) => policy.class);
    expect(legal.length).toBeGreaterThan(0);
    for (const policy of RETENTION_POLICIES) {
      if (
        policy.legalReview !== undefined &&
        policy.legalReview !== "pending"
      ) {
        expect(policy.legalReview.reviewedBy.trim(), policy.class).not.toBe("");
      }
    }
    expect(pendingLegalReviews()).toEqual(
      expect.arrayContaining(
        legal.filter(
          (retentionClass) =>
            retentionPolicy(retentionClass).legalReview === "pending"
        )
      )
    );
  });

  it("fails a legal class marked reviewed without reviewedBy or reviewedAt", () => {
    for (const review of [
      { reviewedAt: "2026-11-01", reviewedBy: "" },
      { reviewedAt: "", reviewedBy: "Contador" },
      { reviewedAt: "01/11/2026", reviewedBy: "Contador" },
      { reviewedAt: "2026-13-45", reviewedBy: "Contador" },
      {},
      true,
    ]) {
      expect(
        legalReviewDefects(
          withPolicy("auth_security_audit", {
            legalReview: review as never,
          })
        ),
        JSON.stringify(review)
      ).toEqual(["auth_security_audit"]);
    }
  });

  it("fails a legal class that says nothing about its review", () => {
    expect(
      legalReviewDefects(
        withPolicy("billing_events", { legalReview: undefined as never })
      )
    ).toEqual(["billing_events"]);
  });

  it("accepts a review with who and when, and stops listing it as pending", () => {
    const reviewed = withPolicy("auth_security_audit", {
      legalReview: { reviewedAt: "2026-11-01", reviewedBy: "Contador" },
    });
    expect(legalReviewDefects(reviewed)).toEqual([]);
    expect(pendingLegalReviews(reviewed)).not.toContain("auth_security_audit");
  });
});

describe("purge blockers", () => {
  it("lifted the sessions' block now that the access record has its own table", () => {
    const sessions = retentionPolicy("auth_sessions");
    // the policy still names what it waited for; the registry says it exists
    expect(sessions.blockedUntil).toBe("access_record_table");
    expect(RESOLVED_RETENTION_BLOCKERS).toContain("access_record_table");
    expect(activeRetentionBlocker(sessions)).toBeUndefined();
  });

  it("keeps the access log without a purge job until the precautionary hold of art. 15 par. 2 exists", () => {
    const log = retentionPolicy("auth_access_log");
    expect(log.blockedUntil).toBe("access_log_hold");
    expect(activeRetentionBlocker(log)).toBe("access_log_hold");
    expect(RESOLVED_RETENTION_BLOCKERS).not.toContain("access_log_hold");
    expect("job" in log).toBe(false);
    expect(blockedPurgeJobs()).toEqual([]);
  });

  it("fail when an access log purge job is registered while the hold is missing", () => {
    expect(blockedPurgeJobs([{ class: "auth_access_log" }])).toEqual([
      "auth_access_log",
    ]);
    expect(
      blockedPurgeJobs([], withPolicy("auth_access_log", { job: "x" } as never))
    ).toEqual(["auth_access_log"]);
  });

  it("let the sessions job exist now, and the access log job once the hold exists", () => {
    expect(blockedPurgeJobs([{ class: "auth_sessions" }])).toEqual([]);
    expect(
      blockedPurgeJobs([{ class: "auth_access_log" }], RETENTION_POLICIES, [
        ...RESOLVED_RETENTION_BLOCKERS,
        "access_log_hold",
      ])
    ).toEqual([]);
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

describe("proposed classes", () => {
  it("have no job and no cron, so nothing expires them on its own", () => {
    const scheduled = new Set(RETENTION_PURGE_JOBS.map((job) => job.class));
    for (const policy of RETENTION_POLICIES) {
      if (policy.status === "proposta") {
        expect("job" in policy, policy.class).toBe(false);
        expect(scheduled.has(policy.class), policy.class).toBe(false);
      }
    }
  });

  it("are removed only after an explicit administrative command, never by a job", () => {
    const scheduledIds = new Set<string>(
      RETENTION_PURGE_JOBS.map((job) => job.id)
    );
    for (const removal of ADMIN_TRIGGERED_REMOVALS) {
      expect(scheduledIds.has(removal.id)).toBe(false);
    }
    expect(ADMIN_TRIGGERED_REMOVALS.map((removal) => removal.class)).toEqual([
      "closed_organization",
    ]);
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
    expect(() => approvedRetention("deletion_ledger")).toThrow(
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

  it("count calendar months, moving a day that does not exist to the next month", () => {
    const expiry = (from: string) =>
      retentionExpiry("auth_security_audit", new Date(from)).toISOString();
    // 31/08 + 6 months: February has no 31st, so it ends in March, never earlier than six months
    expect(expiry("2026-08-31T10:00:00.000Z")).toBe("2027-03-03T10:00:00.000Z");
    // in a leap year February has 29 days
    expect(expiry("2027-08-31T10:00:00.000Z")).toBe("2028-03-02T10:00:00.000Z");
    // an ordinary day keeps its day and its time; the year rolls over
    expect(expiry("2026-10-18T23:59:59.000Z")).toBe("2027-04-18T23:59:59.000Z");
    expect(expiry("2026-12-31T00:00:00.000Z")).toBe("2027-07-01T00:00:00.000Z");
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

  it("keep the access log six calendar months on the law, pending its legal review", () => {
    const policy = retentionPolicy("auth_access_log");
    expect(policy.status).toBe("aprovada");
    expect(policy.basis).toBe("lei");
    expect(policy.approvedOn).toBe("2026-10-18");
    expect(policy.period).toEqual({ kind: "calendar_months", months: 6 });
    expect(policy.legalReview).toBe("pending");
    expect(pendingLegalReviews()).toContain("auth_access_log");
    expect(() => approvedRetention("auth_access_log")).toThrow(
      RetentionNotApprovedError
    );
    expect(
      retentionExpiry(
        "auth_access_log",
        new Date("2026-08-31T10:00:00.000Z")
      ).toISOString()
    ).toBe("2027-03-03T10:00:00.000Z");
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

  it("keep the tenant's operational data until the purge, which no job expires", () => {
    // decision of 18/10/2026 (ADR 0081): Polaris is the processor, the purge removes them after 30 days
    for (const retentionClass of [
      "sales_records",
      "inventory_ledger",
      "expenses_and_goals",
      "product_media",
    ] as const) {
      const policy = retentionPolicy(retentionClass);
      expect(policy.status, retentionClass).toBe("aprovada");
      expect(policy.period.kind, retentionClass).toBe(
        "until_organization_purge"
      );
      expect(() => approvedRetention(retentionClass)).toThrow(
        RetentionNotApprovedError
      );
    }
  });

  it("keep the tenant's audit past the purge, proposed by class, with the legal review pending", () => {
    // decision of 19/10/2026 (ADR 0081 amended): no row of the audit leaves in the purge; only a period removes it
    expect(TENANT_AUDIT_RETENTION.security).toEqual({
      from: "event",
      months: 60,
    });
    expect(TENANT_AUDIT_RETENTION.operational).toEqual({
      from: "organization_purge",
      months: 6,
    });
    for (const retentionClass of [
      "tenant_audit_security",
      "tenant_audit_operational",
    ] as const) {
      const policy = retentionPolicy(retentionClass);
      expect(policy.status, retentionClass).toBe("proposta");
      expect(policy.period.kind, retentionClass).not.toBe(
        "until_organization_purge"
      );
      expect(policy.legalReview, retentionClass).toBe("pending");
      expect(pendingLegalReviews()).toContain(retentionClass);
      expect(() => approvedRetention(retentionClass)).toThrow(
        RetentionNotApprovedError
      );
      expect(() => retentionExpiry(retentionClass, new Date())).toThrow(
        RetentionNotApprovedError
      );
    }
    for (const retentionClass of [
      "platform_audit_and_support",
      "privacy_cases",
      "deletion_ledger",
    ] as const) {
      const policy = retentionPolicy(retentionClass);
      expect(policy.status, retentionClass).toBe("proposta");
      expect(policy.legalReview, retentionClass).toBe("pending");
      if (policy.status === "proposta") {
        expect(policy.proposed, retentionClass).toContain("5 anos");
      }
    }
  });

  it("keep the billing events proposed until the fiscal period is decided", () => {
    expect(retentionPolicy("billing_events").status).toBe("proposta");
    expect(() => approvedRetention("billing_events")).toThrow(
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
