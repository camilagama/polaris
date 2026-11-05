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
  MAX_PRIVACY_NOTE_LENGTH,
  MIN_LEGAL_RETENTION_NOTE_LENGTH,
  PRIVACY_STAGES,
} from "@polaris/domain/admin/privacy-case";
import { CLOSURE_NOTICE_DISMISSAL_REASONS } from "@polaris/domain/organization/closure-deadlines";
import {
  ORGANIZATION_PURGE_REFUSALS,
  ORGANIZATION_PURGE_REQUIRED_SCOPE,
} from "@polaris/domain/privacy/organization-purge";
import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  CATEGORIES,
  CHANNELS,
  CLOSURE_NOTICE_DISMISSALS,
  type Choices,
  DECISION_REASONS,
  DECISIONS,
  IDENTITY_METHODS,
  IDENTITY_STATUSES,
  REQUEST_TYPES,
  REQUESTER_KINDS,
  PURGE_SCOPE,
  ROLES,
  STAGES,
} from "../../ui/privacy";
import {
  MAX_NOTE_LENGTH,
  MIN_LEGAL_RETENTION_NOTE_LENGTH as PAGE_MIN_LEGAL_NOTE,
} from "../../ui/views/privacy-form";
import {
  PURGE_REFUSALS,
  purgeRefusalText,
  REFUSED_GENERIC,
  ROUTE_REFUSALS,
} from "../../ui/purge-words";
import { NOTICE_REFUSALS } from "../../ui/closure-notice-words";

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
  [
    "closure notice dismissal reason",
    CLOSURE_NOTICE_DISMISSALS,
    CLOSURE_NOTICE_DISMISSAL_REASONS,
  ],
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

/**
 * The two acts on the closure notice (corte admin-v2, Parte 12) are refused with the domain's named reasons, and the
 * page says each in its own words. A reason the page has no sentence for gets the generic one, so a new closure-notice
 * refusal in the domain fails here until the page says it.
 */
const CODE_LIKE = /[a-z]+_[a-z_]+/;
const ORGANIZATION_WORD = /organiza[çc][ãa]o/i;

describe("the note limits of the page and of the contract", () => {
  it("asks for the same length the domain and the database take", () => {
    expect(MAX_NOTE_LENGTH).toBe(MAX_PRIVACY_NOTE_LENGTH);
    expect(PAGE_MIN_LEGAL_NOTE).toBe(MIN_LEGAL_RETENTION_NOTE_LENGTH);
  });
});

describe("the closure notice refusals of the page and of the domain", () => {
  const domain: readonly string[] = ORGANIZATION_PURGE_REFUSALS;
  const privacyOfTheNotice = [
    "privacy_case_required",
    "privacy_case_not_deletion",
    "privacy_requester_not_owner",
    "privacy_case_not_accepted",
  ];

  it("says in words every refusal the domain names for these acts, and only refusals the domain names", () => {
    const named = Object.keys(NOTICE_REFUSALS);
    for (const code of named) {
      expect(domain).toContain(code);
    }
    const ofTheNotice = domain.filter(
      (code) =>
        code.startsWith("closure_notice_") ||
        code === "organization_mismatch" ||
        code === "organization_not_in_closure" ||
        privacyOfTheNotice.includes(code)
    );
    expect(ofTheNotice.length).toBeGreaterThanOrEqual(14);
    expect([...named].sort()).toEqual([...ofTheNotice].sort());
  });

  it("gives each refusal a sentence of its own, without a code in it", () => {
    const sentences = Object.values(NOTICE_REFUSALS);
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(CODE_LIKE);
      expect(sentence).not.toMatch(ORGANIZATION_WORD);
    }
  });
});

/**
 * The purge and the legal hold (corte admin-v2, Parte 7): the scope the page asks of the case is the domain's, and
 * every refusal the domain names for scheduling or cancelling a purge has a sentence of the page, as do the codes the
 * routes add (the billing read and the 400s that name a code). A new purge refusal in the domain fails here.
 */
describe("the purge refusals and scope of the page and of the domain", () => {
  const domain: readonly string[] = ORGANIZATION_PURGE_REFUSALS;
  const ofTheNotice = (code: string) =>
    code.startsWith("closure_notice_") ||
    code === "organization_not_in_closure";

  it("asks of the case exactly the scope the domain requires", () => {
    expect([...PURGE_SCOPE]).toEqual([...ORGANIZATION_PURGE_REQUIRED_SCOPE]);
  });

  it("says in words every purge refusal of the domain and each code a route adds, and nothing else", () => {
    const ofThePurge = domain.filter((code) => !ofTheNotice(code));
    expect(ofThePurge.length).toBeGreaterThanOrEqual(17);
    expect(Object.keys(PURGE_REFUSALS).sort()).toEqual(
      [...ofThePurge, ...ROUTE_REFUSALS].sort()
    );
  });

  it("gives each refusal a sentence of its own, without a code or the word organização, and a generic one to any other", () => {
    const sentences = Object.values(PURGE_REFUSALS);
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(CODE_LIKE);
      expect(sentence).not.toMatch(ORGANIZATION_WORD);
    }
    expect(purgeRefusalText("toString")).toBe(REFUSED_GENERIC);
    expect(purgeRefusalText("purge_something_new")).toBe(REFUSED_GENERIC);
  });
});
