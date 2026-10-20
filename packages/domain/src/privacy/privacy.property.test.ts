// biome-ignore-all lint/suspicious/noBitwiseOperators: the ZIP oracle reads and checks bit-level fields (CRC-32, little-endian headers).
import {
  array,
  constantFrom,
  constant,
  integer,
  oneof,
  property,
  record,
  string,
  stringMatching,
  uint8Array,
  uniqueArray,
  uuid,
} from "fast-check";
import { describe, expect, it } from "vitest";
import { assertProperty, minimumSeen } from "../testing/property";
import { csvCell, toCsv } from "./csv";
import {
  DELETION_LEDGER_KINDS,
  type DeletionLedgerEntryInput,
  deletionLedgerEntry,
  InvalidDeletionLedgerEntryError,
} from "./deletion-ledger";
import {
  blockedPurgeJobs,
  RETENTION_CLASSES,
  RETENTION_POLICIES,
  RETENTION_PURGE_JOBS,
  RETENTION_BLOCKERS,
  type RetentionBlocker,
  RetentionNotApprovedError,
  type RetentionPolicy,
  retentionExpiry,
  retentionPolicy,
} from "./retention";
import { ZipBuilder } from "./zip";

/*
 * Invariants of the privacy area (docs/testing/property-invariants.md, PRV-1 to PRV-14). Each oracle
 * is a model written here, not a call to the function under test: an RFC 4180 reader for the CSV, a
 * ZIP reader and a bitwise CRC-32 for the archive, civil-calendar arithmetic for the retention
 * period, and character loops for the identifier rules.
 */

const BYTE_ORDER_MARK = "﻿";
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// CSV: an RFC 4180 reader as the oracle
// ---------------------------------------------------------------------------------------------

/** Reads CSV text into records of cells (quotes, doubled quotes, CRLF inside quotes). */
function readCsv(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 2;
        continue;
      }
      if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\r" && text[index + 1] === "\n") {
      row.push(cell);
      records.push(row);
      row = [];
      cell = "";
      index += 1;
    } else {
      cell += char;
    }
    index += 1;
  }
  expect(quoted).toBe(false);
  expect(cell).toBe("");
  expect(row).toEqual([]);
  return records;
}

function isDigits(text: string): boolean {
  return (
    text.length > 0 && [...text].every((char) => char >= "0" && char <= "9")
  );
}

/** `[-+]?digits(.digits)?`, by splitting, as the oracle of "this text is a plain number". */
function isPlainNumber(text: string): boolean {
  const unsigned =
    text.startsWith("-") || text.startsWith("+") ? text.slice(1) : text;
  const parts = unsigned.split(".");
  return (
    (parts.length === 1 && isDigits(parts[0] as string)) ||
    (parts.length === 2 &&
      isDigits(parts[0] as string) &&
      isDigits(parts[1] as string))
  );
}

const FORMULA_CHARACTERS = ["=", "+", "-", "@", "\t", "\r"];

/** What a text cell must read back as: the same text, with an apostrophe if a spreadsheet would run it. */
function expectedCell(text: string): string {
  const first = text.charAt(0);
  return FORMULA_CHARACTERS.includes(first) && !isPlainNumber(text)
    ? `'${text}`
    : text;
}

// Text full of what breaks CSV: separators, quotes, line breaks, formula starters, accents and emoji.
const awkwardChar = constantFrom(
  ",",
  '"',
  "\n",
  "\r",
  "=",
  "+",
  "-",
  "@",
  "\t",
  " ",
  "'",
  "0",
  "9",
  ".",
  "a",
  "ç",
  "é",
  "😀",
  "\u0000"
);
const awkwardText = array(awkwardChar, { maxLength: 12 }).map((chars) =>
  chars.join("")
);
const textCell = oneof(awkwardText, string({ maxLength: 20 }));

describe("CSV export (PRV-1 to PRV-3)", () => {
  it("PRV-1: reading the file back gives every cell as written, one record per row, after the BOM", () => {
    assertProperty(
      property(
        array(array(textCell, { maxLength: 5, minLength: 5 }), {
          maxLength: 8,
        }),
        (rows) => {
          const columns = ["a", "b", "c", "d", "e"];
          const text = toCsv(columns, rows);
          expect(text.startsWith(BYTE_ORDER_MARK)).toBe(true);
          expect(text.endsWith("\r\n")).toBe(true);
          const read = readCsv(text.slice(BYTE_ORDER_MARK.length));
          expect(read).toEqual([
            columns,
            ...rows.map((row) => row.map(expectedCell)),
          ]);
        }
      )
    );
  });

  it("PRV-2: no cell reads back as a formula unless it is a plain number", () => {
    assertProperty(
      property(textCell, (text) => {
        const [[cell]] = readCsv(`${csvCell(text)}\r\n`) as [[string]];
        const startsFormula = FORMULA_CHARACTERS.includes(cell.charAt(0));
        expect(!startsFormula || isPlainNumber(cell)).toBe(true);
        // and the original is never lost: the guard only adds one apostrophe
        expect(cell === text || cell === `'${text}`).toBe(true);
      })
    );
  });

  it("PRV-3: numbers, booleans, dates and absent values are written as themselves, never guarded", () => {
    assertProperty(
      property(
        integer({ max: 1_000_000, min: -1_000_000 }),
        integer({ max: 4_102_444_800_000, min: 0 }),
        (number, time) => {
          expect(csvCell(number)).toBe(String(number));
          expect(csvCell(new Date(time))).toBe(new Date(time).toISOString());
          expect(csvCell(null)).toBe("");
          expect(csvCell(undefined)).toBe("");
          expect(csvCell(true)).toBe("true");
          expect(csvCell(false)).toBe("false");
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------------------------
// ZIP: a bitwise CRC-32 and an archive reader as the oracle
// ---------------------------------------------------------------------------------------------

function crc32Bitwise(data: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xed_b8_83_20 : crc >>> 1;
    }
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

interface ReadEntry {
  crc: number;
  data: Uint8Array;
  name: string;
}

/** Reads a STORED archive through its central directory, the way an unzip tool does. */
function readZip(bytes: Uint8Array): ReadEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06_05_4b_50);
  const count = view.getUint16(end + 10, true);
  expect(view.getUint16(end + 8, true)).toBe(count);
  let at = view.getUint32(end + 16, true);
  expect(view.getUint32(end + 12, true)).toBe(end - at);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ReadEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(at, true)).toBe(0x02_01_4b_50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    expect(view.getUint32(at + 20, true)).toBe(size);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    // the local header repeats the name, the CRC and the size, and the data follows it
    expect(view.getUint32(local, true)).toBe(0x04_03_4b_50);
    expect(view.getUint32(local + 14, true)).toBe(crc);
    expect(view.getUint32(local + 22, true)).toBe(size);
    const localNameLength = view.getUint16(local + 26, true);
    expect(
      decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength))
    ).toBe(name);
    const start = local + 30 + localNameLength;
    entries.push({ crc, data: bytes.slice(start, start + size), name });
    at += 46 + nameLength;
  }
  expect(at).toBe(end);
  return entries;
}

const NAME_INVALID = /^zip_entry_name_invalid$/;
const NAME_REPEATED = /^zip_entry_name_repeated$/;
const SEGMENT = stringMatching(/^[a-z0-9_-]{1,8}$/);
const entryName = array(oneof(SEGMENT, constant("é-ção"), constant("日本")), {
  maxLength: 3,
  minLength: 1,
}).map((parts) => parts.join("/"));
const archiveEntries = uniqueArray(
  record({ data: uint8Array({ maxLength: 64 }), name: entryName }),
  { maxLength: 8, selector: (entry) => entry.name }
);

describe("ZIP writer (PRV-4 to PRV-6)", () => {
  it("PRV-4: an unzip reader finds every entry, in order, with its bytes and its CRC-32", () => {
    assertProperty(
      property(archiveEntries, (entries) => {
        const builder = new ZipBuilder();
        for (const entry of entries) {
          builder.add(entry.name, entry.data);
        }
        const read = readZip(builder.finish());
        expect(read.map((entry) => entry.name)).toEqual(
          entries.map((entry) => entry.name)
        );
        for (const [index, entry] of read.entries()) {
          expect(Array.from(entry.data)).toEqual(
            Array.from(entries[index]?.data ?? [])
          );
          expect(entry.crc).toBe(
            crc32Bitwise(entries[index]?.data ?? new Uint8Array())
          );
        }
      })
    );
  });

  it("PRV-5: `size` is the exact length of the archive after every add, and the same input gives the same bytes", () => {
    assertProperty(
      property(archiveEntries, (entries) => {
        const build = () => {
          const builder = new ZipBuilder();
          for (const [index, entry] of entries.entries()) {
            builder.add(entry.name, entry.data);
            expect(builder.count).toBe(index + 1);
          }
          return builder;
        };
        const first = build();
        const bytes = first.finish();
        expect(bytes.length).toBe(first.size);
        expect(Array.from(build().finish())).toEqual(Array.from(bytes));
      })
    );
  });

  it("PRV-6: a name that could climb out of the folder or repeat an entry is refused and changes nothing", () => {
    const unsafe = oneof(
      constant(""),
      constant(".."),
      constant("/etc/passwd"),
      constantFrom("a/../b", "a//b", "a\\b", "../a", "a/", "/"),
      SEGMENT.map((segment) => `/${segment}`),
      SEGMENT.map((segment) => `${segment}/../x`)
    );
    assertProperty(
      property(archiveEntries, unsafe, (entries, bad) => {
        const builder = new ZipBuilder();
        for (const entry of entries) {
          builder.add(entry.name, entry.data);
        }
        const before = { count: builder.count, size: builder.size };
        expect(() => builder.add(bad, new Uint8Array(1))).toThrow(NAME_INVALID);
        const [first] = entries;
        if (first) {
          expect(() => builder.add(first.name, new Uint8Array(1))).toThrow(
            NAME_REPEATED
          );
        }
        expect({ count: builder.count, size: builder.size }).toEqual(before);
      })
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Retention: civil-calendar arithmetic as the oracle
// ---------------------------------------------------------------------------------------------

/** Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm), for any month number, even out of 1 to 12. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y0 = year + Math.floor((month - 1) / 12);
  const m = ((((month - 1) % 12) + 12) % 12) + 1;
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear =
    Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/**
 * `months` calendar months after `from`, same day and same time of the day; a day that the target month
 * does not have goes into the next month (never earlier, so a legal minimum is never shortened); then
 * `graceDays` more.
 */
function addCalendarMonths(
  from: Date,
  months: number,
  graceDays: number
): number {
  const timeOfDay =
    from.getTime() - Math.floor(from.getTime() / DAY_MS) * DAY_MS;
  const day =
    daysFromCivil(from.getUTCFullYear(), from.getUTCMonth() + 1 + months, 1) +
    (from.getUTCDate() - 1) +
    graceDays;
  return day * DAY_MS + timeOfDay;
}

const instant = integer({ max: 4_102_444_800_000, min: 0 }).map(
  (ms) => new Date(ms)
);

describe("retention periods (PRV-7 to PRV-10)", () => {
  it("PRV-7: a class with an approved period expires exactly when the calendar says; any other class refuses", () => {
    assertProperty(
      property(
        constantFrom(...RETENTION_CLASSES),
        instant,
        (retentionClass, from) => {
          const policy = retentionPolicy(retentionClass);
          const before = from.getTime();
          if (
            policy.status === "aprovada" &&
            policy.period.kind === "duration"
          ) {
            expect(retentionExpiry(retentionClass, from).getTime()).toBe(
              before + policy.period.ms
            );
          } else if (
            policy.status === "aprovada" &&
            policy.period.kind === "calendar_months"
          ) {
            expect(retentionExpiry(retentionClass, from).getTime()).toBe(
              addCalendarMonths(
                from,
                policy.period.months,
                policy.period.graceDays ?? 0
              )
            );
          } else {
            expect(() => retentionExpiry(retentionClass, from)).toThrow(
              RetentionNotApprovedError
            );
          }
          // the moment given is not touched
          expect(from.getTime()).toBe(before);
        }
      )
    );
  });

  it("PRV-8: a month period lasts between 28 and 31 days a month, plus the grace days", () => {
    const months = RETENTION_POLICIES.flatMap((policy) =>
      policy.status === "aprovada" && policy.period.kind === "calendar_months"
        ? [{ class: policy.class, ...policy.period }]
        : []
    );
    expect(months.length).toBeGreaterThan(0);
    assertProperty(
      property(constantFrom(...months), instant, (period, from) => {
        const expiry = retentionExpiry(period.class, from).getTime();
        const elapsedDays = (expiry - from.getTime()) / DAY_MS;
        expect(elapsedDays).toBeGreaterThanOrEqual(
          28 * period.months + (period.graceDays ?? 0)
        );
        expect(elapsedDays).toBeLessThanOrEqual(
          31 * period.months + (period.graceDays ?? 0)
        );
      })
    );
  });

  it("PRV-9: a later start moves the expiry by the same gap (a duration), or by the gap minus the 3 days a short month can roll over (calendar months)", () => {
    const withPeriod = RETENTION_CLASSES.flatMap((retentionClass) => {
      const policy = retentionPolicy(retentionClass);
      return policy.status === "aprovada" &&
        (policy.period.kind === "duration" ||
          policy.period.kind === "calendar_months")
        ? [{ class: retentionClass, kind: policy.period.kind }]
        : [];
    });
    assertProperty(
      property(
        constantFrom(...withPeriod),
        instant,
        integer({ max: 3 * 366 * DAY_MS, min: 0 }),
        (period, from, gap) => {
          const first = retentionExpiry(period.class, from).getTime();
          const second = retentionExpiry(
            period.class,
            new Date(from.getTime() + gap)
          ).getTime();
          if (period.kind === "duration") {
            expect(second - first).toBe(gap);
          } else {
            // 31 January + 1 month is 3 March, later than 1 February + 1 month (1 March): by the documented rule
            expect(second - first).toBeGreaterThanOrEqual(gap - 3 * DAY_MS);
            expect(second - first).toBeLessThanOrEqual(gap + 3 * DAY_MS);
          }
        }
      )
    );
  });

  it("PRV-10: the classes with a purge job and a blocker still active are exactly the model's, and resolving more blockers never adds one", () => {
    const blockers = Object.keys(RETENTION_BLOCKERS) as RetentionBlocker[];
    const policies: readonly RetentionPolicy[] = RETENTION_POLICIES;
    assertProperty(
      property(
        array(constantFrom(...blockers), { maxLength: blockers.length }),
        array(constantFrom(...blockers), { maxLength: blockers.length }),
        array(constantFrom(...RETENTION_CLASSES), { maxLength: 6 }),
        (resolvedA, extraResolved, jobClasses) => {
          const jobs = [
            ...RETENTION_PURGE_JOBS,
            ...jobClasses.map((retentionClass) => ({ class: retentionClass })),
          ];
          const resolvedMore = [...resolvedA, ...extraResolved];
          // model: blocked iff the policy waits for a blocker not yet resolved and a job (its own or a listed one) would purge it
          const model = (resolved: readonly RetentionBlocker[]) =>
            policies
              .filter((policy) => {
                const waiting =
                  policy.blockedUntil !== undefined &&
                  !resolved.includes(policy.blockedUntil);
                const ownJob = "job" in policy && policy.job !== undefined;
                return (
                  waiting &&
                  (ownJob || jobs.some((job) => job.class === policy.class))
                );
              })
              .map((policy) => policy.class);
          const result = blockedPurgeJobs(jobs, policies, resolvedA);
          expect(new Set(result)).toEqual(new Set(model(resolvedA)));
          const looser = blockedPurgeJobs(jobs, policies, resolvedMore);
          expect(
            looser.every((retentionClass) => result.includes(retentionClass))
          ).toBe(true);
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Deletion ledger: character loops as the oracle of the identifier rules
// ---------------------------------------------------------------------------------------------

const ID_CHARACTERS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const LOWER_HEX = "0123456789abcdef";

function isOpaqueId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 64 &&
    [...value].every((char) => ID_CHARACTERS.includes(char))
  );
}

/** 8-4-4-4-12 lowercase hex, version 1 to 8 and variant 8, 9, a or b, checked by position. */
function isLowerUuid(value: unknown): boolean {
  if (typeof value !== "string" || value.length !== 36) {
    return false;
  }
  return [...value].every((char, index) => {
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      return char === "-";
    }
    if (index === 14) {
      return "12345678".includes(char);
    }
    if (index === 19) {
      return "89ab".includes(char);
    }
    return LOWER_HEX.includes(char);
  });
}

const looseId = oneof(
  stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
  uuid(),
  uuid().map((value) => value.toUpperCase()),
  string({ maxLength: 70 }),
  constant("")
);

const ORG_SLUG = /^[a-z0-9]{1,40}$/;
const EXTRA_KEY = /^[a-z][A-Za-z]{0,12}$/;

const looseInput = record(
  {
    entityId: looseId,
    entityType: constantFrom("customer", "organization", "order", "user"),
    operation: constantFrom("anonymize", "purge", "delete"),
    organizationId: looseId,
    privacyCaseId: oneof(constant(undefined), constant(null), looseId),
  },
  { requiredKeys: ["entityId", "entityType", "operation", "organizationId"] }
);

function ledgerEntityId(input: {
  customerId: string;
  mismatch: boolean;
  organizationId: string;
  purge: boolean;
}): string {
  if (!input.purge) {
    return input.customerId;
  }
  return input.mismatch ? `${input.organizationId}x` : input.organizationId;
}

// Inputs that are valid, or valid but for one field, so both branches of the model get exercised.
const nearlyValidInput = record({
  customerId: oneof(uuid(), looseId),
  mismatch: constantFrom(false, true),
  organizationId: oneof(stringMatching(/^[a-z0-9]{1,20}$/), looseId),
  privacyCaseId: oneof(constant(null), uuid(), looseId),
  purge: constantFrom(false, true),
}).map(({ customerId, mismatch, organizationId, privacyCaseId, purge }) => ({
  entityId: ledgerEntityId({ customerId, mismatch, organizationId, purge }),
  entityType: purge ? "organization" : "customer",
  operation: purge ? "purge" : "anonymize",
  organizationId,
  privacyCaseId,
}));
const ledgerInput = oneof(looseInput, nearlyValidInput);

/** The rules of the ledger, restated: a known pair, opaque IDs, and the entity rule of each kind. */
function ledgerModelAccepts(input: DeletionLedgerEntryInput): boolean {
  const knownPair = DELETION_LEDGER_KINDS.some(
    (kind) =>
      kind.entityType === input.entityType && kind.operation === input.operation
  );
  const caseId = input.privacyCaseId ?? null;
  return (
    knownPair &&
    isOpaqueId(input.entityId) &&
    isOpaqueId(input.organizationId) &&
    (input.entityType !== "customer" || isLowerUuid(input.entityId)) &&
    (input.entityType !== "organization" ||
      input.entityId === input.organizationId) &&
    (caseId === null || isLowerUuid(caseId))
  );
}

describe("deletion ledger (PRV-11 to PRV-12)", () => {
  it("PRV-11: an entry is accepted exactly when the model says so, and then comes back with every field", () => {
    let accepted = 0;
    assertProperty(
      property(ledgerInput, (input) => {
        const typed = input as DeletionLedgerEntryInput;
        if (ledgerModelAccepts(typed)) {
          accepted += 1;
          expect(deletionLedgerEntry(typed)).toEqual({
            ...typed,
            privacyCaseId: typed.privacyCaseId ?? null,
          });
        } else {
          expect(() => deletionLedgerEntry(typed)).toThrow(
            InvalidDeletionLedgerEntryError
          );
        }
      })
    );
    // the property is only worth something if it saw valid entries too
    expect(accepted).toBeGreaterThanOrEqual(minimumSeen());
  });

  it("PRV-12: a valid entry with any extra field (a name, an e-mail, a value) is refused", () => {
    const valid = record({
      entityId: uuid().filter(isLowerUuid),
      organizationId: stringMatching(ORG_SLUG),
    });
    assertProperty(
      property(
        valid,
        stringMatching(EXTRA_KEY).filter(
          (key) =>
            ![
              "entityId",
              "entityType",
              "operation",
              "organizationId",
              "privacyCaseId",
            ].includes(key)
        ),
        string({ maxLength: 20 }),
        ({ entityId, organizationId }, extraKey, extraValue) => {
          const base = {
            entityId,
            entityType: "customer",
            operation: "anonymize",
            organizationId,
          };
          expect(
            deletionLedgerEntry(base as DeletionLedgerEntryInput).privacyCaseId
          ).toBeNull();
          expect(() =>
            deletionLedgerEntry({
              ...base,
              [extraKey]: extraValue,
            } as DeletionLedgerEntryInput)
          ).toThrow(InvalidDeletionLedgerEntryError);
        }
      )
    );
  });
});
