import { describe, expect, it } from "vitest";
import {
  ACTIVATION_NOTICE_REREAD_REASONS,
  ACTIVATION_NOTICE_SKIP_REASONS,
  type ActivationNoticeSkipReason,
  normalizeActivationAddress,
  STOP_ENFORCED,
  withinActivationSendHours,
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

describe("the brake before the stop on a complaint", () => {
  it("keeps every tip from going out until the stop is in force", () => {
    expect(STOP_ENFORCED).toBe(false);
  });
});

describe("the hours a tip goes out in", () => {
  // São Paulo has no daylight saving time: 08:00 there is 11:00 UTC, 20:00 is 23:00 UTC
  it.each([
    ["2026-11-12T10:59:59.999Z", false],
    ["2026-11-12T11:00:00.000Z", true],
    ["2026-11-12T22:59:59.999Z", true],
    ["2026-11-12T23:00:00.000Z", false],
    ["2026-11-13T02:59:59.999Z", false],
    ["2026-11-13T03:00:00.000Z", false],
  ])("at %s: %s", (instant, within) => {
    expect(withinActivationSendHours(new Date(instant))).toBe(within);
  });
});

describe("the address the suppression is keyed by", () => {
  it.each([
    "Nome <A@B.com>",
    "a@b.com ",
    "A@B.COM",
    " <a@b.com> ",
    '"Loja, da Ana" <a@B.com>',
  ])("%s is a@b.com", (raw) => {
    expect(normalizeActivationAddress(raw)).toBe("a@b.com");
  });

  it.each(["", "  ", "Nome", "a@b", "a b@c.com", "<>", "a@b.com, c@d.com"])(
    "%j is no address",
    (raw) => {
      expect(normalizeActivationAddress(raw)).toBeNull();
    }
  );
});
