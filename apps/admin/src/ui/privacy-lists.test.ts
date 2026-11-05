import {
  PRIVACY_ACTIONS,
  PRIVACY_CHANNELS,
  PRIVACY_DATA_CATEGORIES,
  PRIVACY_DECISION_REASONS,
  PRIVACY_DECISIONS,
  PRIVACY_IDENTITY_METHODS,
  PRIVACY_IDENTITY_STATUSES,
  PRIVACY_POLARIS_ROLES,
  PRIVACY_REQUEST_TYPES,
  PRIVACY_REQUESTER_KINDS,
  PRIVACY_STAGES,
} from "@polaris/domain/admin/privacy-case";
import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  CATEGORIES,
  CHANNELS,
  type Choices,
  DECISION_REASONS,
  DECISIONS,
  IDENTITY_METHODS,
  IDENTITY_STATUSES,
  REQUEST_TYPES,
  REQUESTER_KINDS,
  ROLES,
  STAGES,
} from "../../ui/privacy";

/**
 * The page's script imports nothing of the domain, so the closed lists it offers are written in `ui/privacy.ts`.
 * This test is what ties them to the contract (corte admin-v2, AC-P11.1, D-3 f): every list of the page holds
 * exactly the domain's codes, in the domain's order, each with words of its own. A code added, removed or reordered
 * in `@polaris/domain/admin/privacy-case` fails here until the page says it.
 */

const PAIRS: readonly [string, Choices, readonly string[]][] = [
  ["channel", CHANNELS, PRIVACY_CHANNELS],
  ["request type", REQUEST_TYPES, PRIVACY_REQUEST_TYPES],
  ["requester kind", REQUESTER_KINDS, PRIVACY_REQUESTER_KINDS],
  ["identity status", IDENTITY_STATUSES, PRIVACY_IDENTITY_STATUSES],
  ["identity method", IDENTITY_METHODS, PRIVACY_IDENTITY_METHODS],
  ["Polaris role", ROLES, PRIVACY_POLARIS_ROLES],
  ["data category", CATEGORIES, PRIVACY_DATA_CATEGORIES],
  ["decision", DECISIONS, PRIVACY_DECISIONS],
  ["decision reason", DECISION_REASONS, PRIVACY_DECISION_REASONS],
  ["action", ACTIONS, PRIVACY_ACTIONS],
  ["stage", STAGES, PRIVACY_STAGES],
];

/** The page's list and the domain's hold the same codes, in the same order. */
function sameCodes(page: Choices, domain: readonly string[]): boolean {
  const codes = page.map(([code]) => code);
  return (
    codes.length === domain.length &&
    codes.every((code, index) => code === domain[index])
  );
}

describe("the privacy lists of the page and of the contract", () => {
  it.each(PAIRS)(
    "offers exactly the domain's %s codes, in its order",
    (_name, page, domain) => {
      expect(sameCodes(page, domain)).toBe(true);
    }
  );

  it.each(PAIRS)("gives each %s its own words", (_name, page) => {
    const words = page.map(([, label]) => label);
    expect(new Set(words).size).toBe(words.length);
    for (const label of words) {
      expect(label.trim()).not.toBe("");
    }
  });

  it("refuses a list with a code missing, one more, or the order changed (the comparison is not blind)", () => {
    const domain = [...PRIVACY_CHANNELS];
    expect(sameCodes(CHANNELS.slice(1), domain)).toBe(false);
    expect(sameCodes([...CHANNELS, ["fax", "Fax"]], domain)).toBe(false);
    expect(sameCodes([...CHANNELS].reverse(), domain)).toBe(false);
    expect(sameCodes(CHANNELS, domain)).toBe(true);
  });
});
