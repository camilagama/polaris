import { describe, expect, it } from "vitest";
import {
  ACTIVATION_NOTICE_REREAD_REASONS,
  ACTIVATION_NOTICE_SKIP_REASONS,
  type ActivationNoticeSkipReason,
} from "./notices";

// the CHECK of `activation_notices.skipped_reason` (migration 0124)
const SKIPPED_REASON_FORMAT = /^[a-z][a-z0-9_]{0,63}$/;

describe("the skip codes of the activation series", () => {
  it("fit the column's check and are unique", () => {
    for (const code of ACTIVATION_NOTICE_SKIP_REASONS) {
      expect(code).toMatch(SKIPPED_REASON_FORMAT);
    }
    expect(new Set(ACTIVATION_NOTICE_SKIP_REASONS).size).toBe(
      ACTIVATION_NOTICE_SKIP_REASONS.length
    );
  });

  it("check the switch before the database's rules, and those in the database's order", () => {
    const first: ActivationNoticeSkipReason = "switched_off";
    expect(ACTIVATION_NOTICE_SKIP_REASONS[0]).toBe(first);
    expect(
      ACTIVATION_NOTICE_SKIP_REASONS.slice(
        1,
        1 + ACTIVATION_NOTICE_REREAD_REASONS.length
      )
    ).toEqual([...ACTIVATION_NOTICE_REREAD_REASONS]);
  });

  it("keep the codes the sweep and the billing series also record, and the hour of a late retry", () => {
    expect(ACTIVATION_NOTICE_SKIP_REASONS).toEqual(
      expect.arrayContaining([
        "expired",
        "email_not_verified",
        "outside_send_hours",
      ])
    );
  });
});
