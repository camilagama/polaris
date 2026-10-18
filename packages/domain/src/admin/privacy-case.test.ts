import { describe, expect, it } from "vitest";
import {
  assertActionAllowed,
  assertDecisionAllowed,
  dueDate,
  InvalidPrivacyStepError,
  isOverdue,
  normalizeActionStep,
  normalizeDecisionStep,
  normalizeIdentityStep,
  normalizePrivacyRequest,
  normalizeRoleStep,
  normalizeScopeStep,
  PRIVACY_CASE_RESPONSE_DAYS,
  PRIVACY_STAGES,
  stageAfter,
} from "./privacy-case";

const now = new Date("2026-10-17T12:00:00.000Z");
const subject = "0199a0a0-0000-7000-8000-0000000000aa";

function code(operation: () => unknown): string | undefined {
  try {
    operation();
  } catch (error) {
    return error instanceof InvalidPrivacyStepError ? error.code : "other";
  }
  return undefined;
}

describe("a request", () => {
  it("gets a due date counted from when it arrived, not from when it was typed in", () => {
    const arrived = new Date("2026-10-10T09:00:00.000Z");
    const request = normalizePrivacyRequest(
      {
        channel: "email",
        receivedAt: arrived,
        requestType: "deletion",
        requesterKind: "data_subject",
      },
      now
    );
    expect(request.receivedAt).toEqual(arrived);
    expect(request.dueAt).toEqual(dueDate(arrived));
    expect(request.dueAt.getTime() - arrived.getTime()).toBe(
      PRIVACY_CASE_RESPONSE_DAYS * 86_400_000
    );
  });

  it("may be typed in late, but not more than a year late", () => {
    const base = {
      channel: "email",
      requestType: "access",
      requesterKind: "data_subject",
    };
    const day = 86_400_000;
    expect(
      normalizePrivacyRequest(
        { ...base, receivedAt: new Date(now.getTime() - 364 * day) },
        now
      ).receivedAt
    ).toEqual(new Date(now.getTime() - 364 * day));
    expect(
      code(() =>
        normalizePrivacyRequest(
          { ...base, receivedAt: new Date(now.getTime() - 366 * day) },
          now
        )
      )
    ).toBe("invalid_privacy_request");
  });

  it("arrives now by default and never in the future", () => {
    const ok = normalizePrivacyRequest(
      {
        channel: "in_app",
        requestType: "access",
        requesterKind: "organization_owner",
      },
      now
    );
    expect(ok.receivedAt).toEqual(now);
    expect(
      code(() =>
        normalizePrivacyRequest(
          {
            channel: "in_app",
            receivedAt: new Date(now.getTime() + 1),
            requestType: "access",
            requesterKind: "other",
          },
          now
        )
      )
    ).toBe("invalid_privacy_request");
  });

  it("refuses an unknown kind, channel or type, and a note with control characters or too long", () => {
    const base = {
      channel: "email",
      requestType: "access",
      requesterKind: "data_subject",
    };
    for (const bad of [
      { ...base, channel: "carrier_pigeon" },
      { ...base, requestType: "sell" },
      { ...base, requesterKind: "friend" },
      { ...base, channel: 5 },
    ]) {
      expect(code(() => normalizePrivacyRequest(bad, now))).toBe(
        "invalid_privacy_request"
      );
    }
    expect(
      code(() => normalizePrivacyRequest({ ...base, note: "a\u0000b" }, now))
    ).toBe("invalid_privacy_step");
    expect(
      code(() =>
        normalizePrivacyRequest({ ...base, note: "x".repeat(501) }, now)
      )
    ).toBe("invalid_privacy_step");
    expect(
      normalizePrivacyRequest({ ...base, note: "  " }, now).note
    ).toBeNull();
  });
});

describe("the steps", () => {
  it("take only known codes", () => {
    expect(
      normalizeIdentityStep({
        method: "owner_confirmation",
        status: "verified",
      })
    ).toEqual({ method: "owner_confirmation", status: "verified" });
    expect(
      code(() => normalizeIdentityStep({ method: "x", status: "verified" }))
    ).toBe("invalid_privacy_step");
    expect(normalizeRoleStep("processor")).toBe("processor");
    expect(code(() => normalizeRoleStep("joint"))).toBe("invalid_privacy_step");
  });

  it("scope needs at least one distinct known category and may name an opaque subject", () => {
    expect(
      normalizeScopeStep({
        categories: ["customers", "sales"],
        subjectReference: subject,
      })
    ).toEqual({
      categories: ["customers", "sales"],
      subjectReference: subject,
    });
    for (const categories of [
      [],
      ["customers", "customers"],
      ["pictures"],
      "customers",
      undefined,
    ]) {
      expect(code(() => normalizeScopeStep({ categories }))).toBe(
        "invalid_privacy_step"
      );
    }
    expect(
      code(() =>
        normalizeScopeStep({
          categories: ["account"],
          subjectReference: "x".repeat(65),
        })
      )
    ).toBe("invalid_privacy_step");
    // an opaque reference is an identifier, not text a person wrote
    for (const subjectReference of [
      "maria@example.com",
      "Maria Souza",
      "+55 11 9",
    ]) {
      expect(
        code(() =>
          normalizeScopeStep({ categories: ["account"], subjectReference })
        )
      ).toBe("invalid_privacy_step");
    }
    expect(
      normalizeScopeStep({
        categories: ["account"],
        subjectReference: "user_17-b",
      }).subjectReference
    ).toBe("user_17-b");
  });

  it("an action may name the record it acted on, as a UUID and nothing else", () => {
    expect(
      normalizeActionStep({
        action: "customer_anonymized",
        entityId: subject.toUpperCase(),
      })
    ).toEqual({ action: "customer_anonymized", entityId: subject });
    expect(
      normalizeActionStep({ action: "no_action_required" }).entityId
    ).toBeNull();
    expect(
      code(() =>
        normalizeActionStep({ action: "other", entityId: "Maria Souza" })
      )
    ).toBe("invalid_privacy_step");
    expect(
      code(() => normalizeActionStep({ action: "erase_everything" }))
    ).toBe("invalid_privacy_step");
  });
});

describe("what may be decided", () => {
  const verified = {
    identityStatus: "verified",
    requesterKind: "data_subject",
  } as const;

  it("never accepts a request whose identity was not verified, and says why when it refuses", () => {
    const failed = {
      ...verified,
      identityStatus: "failed",
      polarisRole: "controller",
    } as const;
    for (const decision of [
      "accept",
      "partially_accept",
      "redirect_to_controller",
    ] as const) {
      expect(code(() => assertDecisionAllowed(failed, decision, null))).toBe(
        "privacy_decision_not_allowed"
      );
    }
    expect(
      code(() => assertDecisionAllowed(failed, "reject", "legal_retention"))
    ).toBe("privacy_decision_not_allowed");
    expect(() =>
      assertDecisionAllowed(failed, "reject", "identity_not_verified")
    ).not.toThrow();
  });

  it("does not accept, on its own authority, data it only processes, unless the owner of the organization asks", () => {
    const processor = { ...verified, polarisRole: "processor" } as const;
    expect(code(() => assertDecisionAllowed(processor, "accept", null))).toBe(
      "privacy_decision_not_allowed"
    );
    expect(
      code(() => assertDecisionAllowed(processor, "partially_accept", "other"))
    ).toBe("privacy_decision_not_allowed");
    expect(() =>
      assertDecisionAllowed(
        processor,
        "redirect_to_controller",
        "controller_is_reseller"
      )
    ).not.toThrow();
    expect(() =>
      assertDecisionAllowed(
        { ...processor, requesterKind: "organization_owner" },
        "accept",
        null
      )
    ).not.toThrow();
  });

  it("redirects only when Polaris is the processor, and a refusal needs a reason", () => {
    const controller = { ...verified, polarisRole: "controller" } as const;
    expect(
      code(() =>
        assertDecisionAllowed(
          controller,
          "redirect_to_controller",
          "controller_is_reseller"
        )
      )
    ).toBe("privacy_decision_not_allowed");
    expect(code(() => assertDecisionAllowed(controller, "reject", null))).toBe(
      "invalid_privacy_step"
    );
    expect(() =>
      assertDecisionAllowed(controller, "accept", null)
    ).not.toThrow();
    expect(() =>
      assertDecisionAllowed(controller, "reject", "manifestly_unfounded")
    ).not.toThrow();
    // that is a reason only for a failed check, whatever the decision
    for (const decision of ["accept", "partially_accept", "reject"] as const) {
      expect(
        code(() =>
          assertDecisionAllowed(controller, decision, "identity_not_verified")
        )
      ).toBe("privacy_decision_not_allowed");
    }
    // anything but a plain acceptance says why
    expect(
      code(() => assertDecisionAllowed(controller, "partially_accept", null))
    ).toBe("invalid_privacy_step");
  });

  it("takes only known decisions and reasons", () => {
    expect(normalizeDecisionStep({ decision: "accept" })).toEqual({
      decision: "accept",
      note: null,
      reason: null,
    });
    expect(code(() => normalizeDecisionStep({ decision: "maybe" }))).toBe(
      "invalid_privacy_step"
    );
    expect(
      code(() =>
        normalizeDecisionStep({ decision: "reject", reason: "dislike" })
      )
    ).toBe("invalid_privacy_step");
  });
});

describe("what may be recorded as carried out", () => {
  it("fits the decision: a refusal has nothing, a redirect tells the controller, an acceptance does not redirect", () => {
    expect(code(() => assertActionAllowed("reject", "other"))).toBe(
      "privacy_stage_conflict"
    );
    for (const action of [
      "redirected_to_reseller",
      "no_action_required",
      "other",
    ] as const) {
      expect(() =>
        assertActionAllowed("redirect_to_controller", action)
      ).not.toThrow();
    }
    expect(
      code(() =>
        assertActionAllowed("redirect_to_controller", "customer_anonymized")
      )
    ).toBe("privacy_decision_not_allowed");
    for (const decision of ["accept", "partially_accept"] as const) {
      expect(() =>
        assertActionAllowed(decision, "customer_anonymized")
      ).not.toThrow();
      expect(() => assertActionAllowed(decision, "other")).not.toThrow();
      // an acceptance is carried out by doing something, not by doing nothing
      expect(
        code(() => assertActionAllowed(decision, "no_action_required"))
      ).toBe("privacy_decision_not_allowed");
      expect(
        code(() => assertActionAllowed(decision, "redirected_to_reseller"))
      ).toBe("privacy_decision_not_allowed");
    }
  });
});

describe("the order of the steps", () => {
  it("goes request, identity, role, scope, decision, action, resolution", () => {
    expect(PRIVACY_STAGES).toEqual([
      "requested",
      "identity_checked",
      "role_determined",
      "scoped",
      "decided",
      "executed",
      "resolved",
    ]);
    expect(stageAfter("requested", "identity")).toBe("identity_checked");
    expect(stageAfter("identity_checked", "role")).toBe("role_determined");
    expect(stageAfter("role_determined", "scope")).toBe("scoped");
    expect(stageAfter("scoped", "decision")).toBe("decided");
    expect(stageAfter("decided", "action")).toBe("executed");
    expect(stageAfter("executed", "action")).toBe("executed");
    expect(stageAfter("executed", "resolve")).toBe("resolved");
  });

  it("refuses a step out of order, and a step on a resolved case", () => {
    expect(code(() => stageAfter("requested", "scope"))).toBe(
      "privacy_stage_conflict"
    );
    expect(code(() => stageAfter("scoped", "identity"))).toBe(
      "privacy_stage_conflict"
    );
    expect(code(() => stageAfter("decided", "decision"))).toBe(
      "privacy_stage_conflict"
    );
    for (const step of [
      "identity",
      "role",
      "scope",
      "decision",
      "action",
      "resolve",
    ] as const) {
      expect(code(() => stageAfter("resolved", step))).toBe(
        "privacy_stage_conflict"
      );
    }
  });

  it("a refusal or a redirect can be resolved without execution; an acceptance cannot", () => {
    expect(stageAfter("decided", "resolve", "reject")).toBe("resolved");
    expect(stageAfter("decided", "resolve", "redirect_to_controller")).toBe(
      "resolved"
    );
    expect(code(() => stageAfter("decided", "resolve", "accept"))).toBe(
      "privacy_stage_conflict"
    );
    expect(
      code(() => stageAfter("decided", "resolve", "partially_accept"))
    ).toBe("privacy_stage_conflict");
  });
});

describe("being late", () => {
  const due = new Date("2026-10-20T00:00:00.000Z");
  it("is being open past the due date", () => {
    expect(isOverdue(due, "scoped", new Date("2026-10-19T23:59:59.000Z"))).toBe(
      false
    );
    expect(isOverdue(due, "scoped", new Date("2026-10-20T00:00:01.000Z"))).toBe(
      true
    );
    expect(
      isOverdue(due, "resolved", new Date("2026-12-01T00:00:00.000Z"))
    ).toBe(false);
  });
});
