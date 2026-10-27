import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countLooseClock } from "./gate-clock-scan";

/**
 * No loose clock in the gates (t438; dreaming of 27/10: 5 times in 4 PRs, and the economics gate of PR 306 left the
 * main CI red). `Date.now()` and `new Date()` with no argument tell the time of the day the gate runs, so a day
 * worked out from them changes with the hour. A gate that needs a day takes it from `gate-clock.ts` (a clock fixed at
 * the start of the run, helpers that take the clock as an argument, tested on fixed clocks around midnight in São
 * Paulo); a gate that needs "now" for a row the database compares with its own clock (an expiry, a lease, an elapsed
 * time) says so in the list below.
 *
 * The test reads every `.ts` of `packages/db/scripts` and of its subfolders, tests included, not only
 * `verify-*-gate.ts`: a read moved to a support file or to a test would pass otherwise. A use that is not in the list fails, and so does a list that says more uses
 * than the file has: the list is exact, and each entry carries its reason. A new use is a decision, written here.
 */

const SCRIPTS_DIR = new URL("./", import.meta.url);
const IS_GATE = /^verify-.*-gate\.ts$/;

/** The list of what is allowed, per file: how many reads and why. */
type LooseClockList = Readonly<
  Record<string, { count: number; reason: string }>
>;

function looseClockProblems(
  sources: Readonly<Record<string, string>>,
  allowed: LooseClockList
): string[] {
  const problems: string[] = [];
  for (const [file, source] of Object.entries(sources)) {
    const found = countLooseClock(source);
    const entry = allowed[file];
    if (found > 0 && !entry) {
      problems.push(
        `${file}: ${found} loose clock read(s) and not in the list`
      );
    } else if (entry && entry.count !== found) {
      problems.push(
        `${file}: the list says ${entry.count}, the file has ${found}`
      );
    }
  }
  for (const file of Object.keys(allowed)) {
    if (!(file in sources)) {
      problems.push(`${file}: in the list and not a script of the package`);
    }
  }
  return problems;
}

function scriptSources(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(SCRIPTS_DIR, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .map((name) => [name, readFileSync(new URL(name, SCRIPTS_DIR), "utf8")])
  );
}

const ALLOWED_LOOSE_CLOCK: LooseClockList = {
  "concurrency-support.ts": {
    count: 2,
    reason:
      "the deadline of a polling loop: elapsed time with a limit, no calendar day",
  },
  "gate-clock.ts": {
    count: 1,
    reason:
      "the one read of the wall clock: the instant the process starts, which runClock then repeats",
  },
  "measure-period-summary.ts": {
    count: 2,
    reason:
      "times the seeding of the measurement and prints the seconds; not a gate and no calendar day",
  },
  "run-gates.ts": {
    count: 2,
    reason: "times each gate for the report of the runner; elapsed time only",
  },
  "sales-gate-support.ts": {
    count: 1,
    reason:
      "recentInstant: an instant a few hours back for gates that need the sale to be recent and never assert its day (a gate that asserts a day uses storeNoon of gate-clock.ts)",
  },
  "seed-qa-store.ts": {
    count: 2,
    reason:
      "the seeder of a QA store lays its sales on the real days of the store and tags the seed with the time: it is not a gate and its output is meant to follow the real clock",
  },
  "verify-access-log-gate.ts": {
    count: 5,
    reason:
      "windows of the read set as offsets from one reading of the clock (31 days less or plus a minute, one reading so the window is exact), and the drift of a row time against the clock; no calendar day",
  },
  "verify-activation-funnel-gate.ts": {
    count: 3,
    reason:
      "a deleted_at stamp, the drift of generatedAt against the clock (an hour of margin) and the random seed (POLARIS_FUNNEL_SEED replays it); no calendar day",
  },
  "verify-admin-diagnostics-gate.ts": {
    count: 1,
    reason:
      "the drift of the instant the function answers against the clock, with one hour of margin; no calendar day",
  },
  "verify-admin-suspension-gate.ts": {
    count: 4,
    reason:
      "an expiry, lease or availability set at an offset from now, which the database compares with its own clock; the rule is in elapsed time, never in a calendar day",
  },
  "verify-audit-retention-gate.ts": {
    count: 3,
    reason:
      "an instant 30 days ahead, written to a column the database compares with its own clock; no calendar day",
  },
  "verify-auth-tables-row-security-gate.ts": {
    count: 2,
    reason:
      "an expiry, lease or availability set at an offset from now, which the database compares with its own clock; the rule is in elapsed time, never in a calendar day",
  },
  "verify-billing-lifecycle-gate.ts": {
    count: 3,
    reason:
      "the anchor of the billing facts (periods are given as instants, by offsets in days) and the instant of the sweep: hands the instant to the function under test, which compares it with rows the database stamps with its own now(); no calendar day",
  },
  "verify-billing-notices-gate.ts": {
    count: 1,
    reason:
      "hands the instant to the function under test, which compares it with rows the database stamps with its own now(); no calendar day",
  },
  "verify-billing-read-plan-gate.ts": {
    count: 1,
    reason:
      "the anchor of the billing records, set by offsets of days from now; the plan read is by instants, no calendar day",
  },
  "verify-billing-self-service-gate.ts": {
    count: 2,
    reason:
      "the anchor of the billing records, set by offsets of hours from now; the facts are instants, no calendar day",
  },
  "verify-billing-trial-claims-gate.ts": {
    count: 4,
    reason:
      "the anchor of the billing facts, offsets from it, and a timer of the refusal (5 s); instants and elapsed time, no calendar day",
  },
  "verify-closed-organization-readonly-gate.ts": {
    count: 10,
    reason:
      "a row aged by an offset in hours or days from now; the rules are in elapsed time and the gate keeps a margin of a day or more from every boundary (D is midnight in São Paulo, so the closest age is 88 days, not 89, whose margin goes down to 0 h), no calendar day is worked out (the closure ages of 40, 80, 88 and 91 days against the 90-day wait)",
  },
  "verify-daily-sales-gate.ts": {
    count: 1,
    reason:
      "the seed of a random run, printed in the notes so that a failure replays; not a date",
  },
  "verify-data-export-gate.ts": {
    count: 1,
    reason:
      "the hours left to a ready export, asserted between 23.5 and 24.01; elapsed time, no calendar day",
  },
  "verify-dead-letter-gate.ts": {
    count: 1,
    reason: "an instant written to a row as it is, never compared with a day",
  },
  "verify-deletion-ledger-gate.ts": {
    count: 2,
    reason:
      "the lower bound of an insert time (read before the command) and an instant one hour ahead; elapsed time, no calendar day",
  },
  "verify-device-sessions-gate.ts": {
    count: 2,
    reason:
      "the issue instant and the expiry of a session, an hour ahead, which the database compares with its own clock; no calendar day",
  },
  "verify-entitlement-grants-gate.ts": {
    count: 10,
    reason:
      "expiries set as offsets of days or seconds from now, and the sweeps of the function under test, which take the instant as an argument; no calendar day",
  },
  "verify-entitlements-gate.ts": {
    count: 1,
    reason:
      "a creation time one minute back, so it is never in the future of the server clock; no calendar day",
  },
  "verify-event-outbox-gate.ts": {
    count: 2,
    reason:
      "a lower bound read before the insert and the availability of the event within 60 seconds of now; elapsed time, no calendar day",
  },
  "verify-gate4-sales-core.ts": {
    count: 1,
    reason:
      "the default instant of a sale two hours back; the gate asserts days from storeDay and from explicit instants, never from this one",
  },
  "verify-offline-customer-gate.ts": {
    count: 1,
    reason:
      "a creation time one minute back, so it is never in the future of the server clock; no calendar day",
  },
  "verify-offline-devices-gate.ts": {
    count: 4,
    reason:
      "the instants of touch, revoke and issue handed to the code under test, a lease of 72 hours from the issue, and a bound of 5 minutes on a creation time; no calendar day",
  },
  "verify-offline-lease-gate.ts": {
    count: 1,
    reason:
      "the instant of the issue, handed to the function under test, which sets the lease from it; no calendar day",
  },
  "verify-offline-product-gate.ts": {
    count: 1,
    reason:
      "a creation time one minute back, so it is never in the future of the server clock; no calendar day",
  },
  "verify-offline-sale-gate.ts": {
    count: 4,
    reason:
      "instants 90 days back and one day ahead, far from the limits of the window, and an elapsed-time bound; the day it asserts comes from storeDay",
  },
  "verify-offline-stock-gate.ts": {
    count: 1,
    reason:
      "a creation time one minute back, so it is never in the future of the server clock; no calendar day",
  },
  "verify-operational-selection-gate.ts": {
    count: 9,
    reason:
      "hands the instant to the function under test, which compares it with rows the database stamps with its own now(); no calendar day; the window of adaptation is read in elapsed time",
  },
  "verify-organization-closure-gate.ts": {
    count: 1,
    reason:
      "a recovery deadline the function sets: the gate asserts it lies more than the window minus one minute ahead of now; no calendar day",
  },
  "verify-privacy-cases-gate.ts": {
    count: 4,
    reason:
      "the arrival of a request 400, 20 and 3 days back and one hour ahead (the refusal of the future), with the deadlines worked out by the database from that instant; margins of days apart from the hour, which is the point of that case",
  },
  "verify-public-catalog-gate.ts": {
    count: 1,
    reason:
      "hands the instant to the function under test, which compares it with rows the database stamps with its own now(); no calendar day",
  },
  "verify-renewal-cancellation-gate.ts": {
    count: 3,
    reason:
      "hands the instant to the function under test, which compares it with rows the database stamps with its own now(); no calendar day; the re-arm is checked with a second of margin",
  },
  "verify-review-hardening-gate.ts": {
    count: 4,
    reason:
      "one instant before and one after a command, and the wait of a lock: elapsed time with margins; the days it asserts come from storeDay",
  },
  "verify-sale-cancellation-gate.ts": {
    count: 2,
    reason:
      "reads the store day before and after the cancellation and accepts either, so a run that crosses midnight passes; the one reading of a day that must be real, because the database stamps it",
  },
  "verify-sale-dates-gate.ts": {
    count: 8,
    reason:
      "instants a few hours back or minutes ahead that the sale keeps as the commercial instant, plus the before and after of the command; every day it asserts comes from storeDay or from explicit instants",
  },
  "verify-scheduled-jobs-gate.ts": {
    count: 2,
    reason:
      "the windows missed between two instants, counted by the database and by the domain on the same pair; elapsed time in whole hours",
  },
  "verify-sync-push-gate.ts": {
    count: 8,
    reason:
      "instants hours or days back and ahead, set against the limits of the sync window with margins of hours; no calendar day",
  },
  "verify-web-worker-gate.ts": {
    count: 1,
    reason:
      "one reading of the clock for the request time of the export event; no calendar day",
  },
};

describe("the loose clock in the scripts of packages/db", () => {
  const sources = scriptSources();

  it("reads every script, the gates and the tests among them", () => {
    const names = Object.keys(sources);
    expect(names.length).toBeGreaterThan(60);
    expect(names).toContain("verify-economics-gate.ts");
    expect(names).toContain("gate-clock.ts");
    expect(names).toContain("gate-loose-clock.test.ts");
    expect(names.filter((name) => IS_GATE.test(name)).length).toBeGreaterThan(
      50
    );
  });

  it("finds no read of the time of day that the list does not name, with its count", () => {
    expect(looseClockProblems(sources, ALLOWED_LOOSE_CLOCK)).toEqual([]);
  });

  it("gives every entry of the list a reason", () => {
    for (const [file, { count, reason }] of Object.entries(
      ALLOWED_LOOSE_CLOCK
    )) {
      expect(count, file).toBeGreaterThan(0);
      expect(reason.length, file).toBeGreaterThan(25);
    }
  });
});

// the backtick and the opening of a placeholder, apart, so the planted sources can be strings
const TICK = "`";
const OPEN = String.fromCharCode(36, 123);

describe("the control cases, planted: the rule refuses them", () => {
  const forbidden: Record<string, string> = {
    "a read after a block in a template": [
      "const s = ",
      TICK,
      OPEN,
      "[1].map((n) => { return n; })} ",
      OPEN,
      "new Date()}",
      TICK,
      ";",
    ].join(""),
    "a read after a division": "const h = a / b; const t = Date.now() / c;",
    "a read after a regex with a quote": "const r = /'/; const t = Date.now();",
    "a read after a string with slashes":
      "const p = '//'; const t = Date.now();",
    "a read in the code of a template": [
      "const s = ",
      TICK,
      "at ",
      OPEN,
      "Date.now()}",
      TICK,
      ";",
    ].join(""),
    "Date.now as a value": "const clock = Date.now;",
    "Date.now()": "const t = Date.now();",
    "Date.now() inside an expression":
      "const t = new Date(Date.now() + 3600000);",
    "Date() without new": "const d = Date();",
    'Date["now"]': 'const t = Date["now"]();',
    "globalThis.Date.now()": "const t = globalThis.Date.now();",
    "new Date without parentheses": "const d = new Date;",
    "new Date()": "const d = new Date();",
    "new Date() split in two lines": "const d = new Date(\n);",
    "new Date(undefined)": "const d = new Date(undefined);",
    "Temporal.Now": "const t = Temporal.Now.instant();",
    "the alias of Date": "const D = Date;",
    "Date?.now()": "const t = Date?.now();",
    "new globalThis.Date()": "const d = new globalThis.Date();",
    "new (Date)()": "const d = new (Date)();",
    "Reflect.construct(Date, [])": "const d = Reflect.construct(Date, []);",
    "Date passed as a value": "run(Date);",
    "Date passed as the second argument": "run(clock, Date);",
    "Date taken apart": "let { now } = Date;",
    "new Date(void 0)": "const d = new Date(void 0);",
    "performance.timeOrigin": "const o = performance.timeOrigin;",
  };
  const harmless: Record<string, string> = {
    "a block comment": "/* new Date() */ const a = 1;",
    "a line comment": "// Date.now() and new Date() are loose\nconst a = 1;",
    "a regex": "const r = /new Date\\(\\)/;",
    "a string": "const s = 'new Date() and Date.now()';",
    "a template text": "const s = `use Date.now() or new Date()`;",
    "Date.parse": "const t = Date.parse('2026-10-27T00:00:00Z');",
    "new Date(0)": "const d = new Date(0);",
    "new Date(Date.UTC(...))": "const d = new Date(Date.UTC(2026, 9, 27));",
    "new Date(value)": "const d = new Date(value);",
    "the type": "const d: Date = value;",
    "an array of Date": "const xs: Date[] = [];",
    "a type alias of Date": "type Clock = Date;",
    "a method of another object": "const t = faker.Date.now();",
    "a division": "const q = a / b; const r = c / d;",
    "Date.UTC in a condition": "const { UTC } = Date.UTC ? Date : null;",
  };

  for (const [name, source] of Object.entries(forbidden)) {
    it(`refuses ${name}`, () => {
      expect(
        looseClockProblems({ "verify-planted-gate.ts": source }, {})
      ).toEqual([expect.stringContaining("not in the list")]);
    });
  }

  for (const [name, source] of Object.entries(harmless)) {
    it(`lets ${name} through`, () => {
      expect(countLooseClock(source)).toBe(0);
    });
  }

  const planted = {
    "verify-planted-gate.ts": {
      count: 1,
      reason: "a planted reason that is long enough",
    },
  };

  it("refuses one more use in a file of the list (the list is exact)", () => {
    expect(
      looseClockProblems(
        { "verify-planted-gate.ts": "const a = Date.now();" },
        planted
      )
    ).toEqual([]);
    expect(
      looseClockProblems(
        {
          "verify-planted-gate.ts":
            "const a = Date.now(); const b = new Date();",
        },
        planted
      )
    ).toEqual(["verify-planted-gate.ts: the list says 1, the file has 2"]);
  });

  it("refuses an entry that is left in the list after its cause is gone", () => {
    expect(
      looseClockProblems({ "verify-planted-gate.ts": "const a = 1;" }, planted)
    ).toEqual(["verify-planted-gate.ts: the list says 1, the file has 0"]);
    expect(looseClockProblems({}, planted)).toEqual([
      "verify-planted-gate.ts: in the list and not a script of the package",
    ]);
  });

  it("refuses a read moved to a support file", () => {
    expect(
      looseClockProblems(
        {
          "support.ts": "export const now = () => Date.now();",
          "verify-planted-gate.ts": "import { now } from './support';",
        },
        {}
      )
    ).toEqual(["support.ts: 1 loose clock read(s) and not in the list"]);
  });
});
