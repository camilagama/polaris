import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expiredBackups, parseListing, stampInstant } from "./retention.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "retention.mjs");
const NOW = "20261104T062200Z";
const DAY_MS = 24 * 60 * 60 * 1000;
const MILLISECONDS_SUFFIX = /\.\d+Z$/;
const SEPARATORS = /[-:]/g;

const stampOf = (instant) =>
  new Date(instant)
    .toISOString()
    .replace(SEPARATORS, "")
    .replace(MILLISECONDS_SUFFIX, "Z");
const keyAt = (instant) => `daily/${stampOf(instant)}.tar.age`;
const keyAgo = (days, seconds = 0) =>
  keyAt(stampInstant(NOW) - days * DAY_MS - seconds * 1000);
const dailyRun = (count, startDaysAgo = 0) =>
  Array.from({ length: count }, (_, index) => keyAgo(startDaysAgo + index));

function runCli(args, stdin) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      (error, stdout, stderr) =>
        resolve({ code: error ? error.code : 0, stderr, stdout })
    );
    child.stdin.end(stdin);
  });
}

describe("stampInstant", () => {
  it("reads a valid stamp as a UTC instant", () => {
    expect(stampInstant("20261104T062200Z")).toBe(Date.UTC(2026, 10, 4, 6, 22));
  });

  it("returns null for impossible dates and other shapes", () => {
    expect(stampInstant("20261399T000000Z")).toBeNull();
    expect(stampInstant("20260230T000000Z")).toBeNull();
    expect(stampInstant("20261104T246000Z")).toBeNull();
    expect(stampInstant("2026-11-04T06:22:00Z")).toBeNull();
    expect(stampInstant("")).toBeNull();
  });
});

describe("parseListing", () => {
  it("reads the keys of a list-objects-v2 answer", () => {
    expect(
      parseListing('{"Contents":[{"Key":"daily/a"},{"Key":"daily/b"}]}\n')
    ).toEqual(["daily/a", "daily/b"]);
  });

  it("treats an answer without Contents and an empty output as an empty listing", () => {
    expect(parseListing('{"RequestCharged": null}\n')).toEqual([]);
    expect(parseListing("")).toEqual([]);
    expect(parseListing("  \n")).toEqual([]);
  });

  it("refuses what is not a list-objects-v2 answer", () => {
    expect(() => parseListing("null")).toThrow("not a list-objects-v2 answer");
    expect(() => parseListing('["daily/a"]')).toThrow(
      "not a list-objects-v2 answer"
    );
    expect(() => parseListing('{"Contents":[{"Key":1}]}')).toThrow(
      "not a list-objects-v2 answer"
    );
  });
});

describe("expiredBackups", () => {
  const keep = keyAgo(0);

  it("does not delete a backup of exactly 35 days", () => {
    const keys = [...dailyRun(35), keyAgo(35)];
    expect(expiredBackups({ keep, keys, now: NOW })).toEqual([]);
  });

  it("deletes a backup 35 days and one second old when it is outside the 35 newest", () => {
    const older = keyAgo(35, 1);
    const keys = [...dailyRun(35), older];
    expect(expiredBackups({ keep, keys, now: NOW })).toEqual([older]);
  });

  it("keeps the 35 newest even when all of them are old after a long stop", () => {
    const keys = [...dailyRun(9, 60), keep];
    expect(expiredBackups({ keep, keys, now: NOW })).toEqual([]);
  });

  it("deletes only the oldest of 40 continuous dailies, oldest first, from an unsorted listing", () => {
    const keys = dailyRun(40);
    const expired = expiredBackups({
      keep,
      keys: [...keys].reverse(),
      now: NOW,
    });
    expect(expired).toEqual([keyAgo(39), keyAgo(38), keyAgo(37), keyAgo(36)]);
  });

  it("deletes the 5 oldest of 41 continuous dailies", () => {
    const expired = expiredBackups({ keep, keys: dailyRun(41), now: NOW });
    expect(expired).toEqual([
      keyAgo(40),
      keyAgo(39),
      keyAgo(38),
      keyAgo(37),
      keyAgo(36),
    ]);
  });

  it("never deletes keys of another format in the prefix", () => {
    const strangers = [
      "daily/x.txt",
      "daily/20261399T000000Z.tar.age",
      "daily/20200101T000000Z.tar.age.bak",
      "daily/sub/20200101T000000Z.tar.age",
      "other/20200101T000000Z.tar.age",
    ];
    const keys = [...dailyRun(36), ...strangers];
    expect(expiredBackups({ keep, keys, now: NOW })).toEqual([]);
  });

  it("never deletes a stamp in the future", () => {
    const future = keyAt(stampInstant(NOW) + 400 * DAY_MS);
    const keys = [...dailyRun(60), future];
    expect(expiredBackups({ keep, keys, now: NOW })).not.toContain(future);
  });

  it("throws when the backup just uploaded is not in the listing", () => {
    expect(() =>
      expiredBackups({ keep, keys: dailyRun(40, 1), now: NOW })
    ).toThrow("not in the listing");
  });

  it("throws on an empty listing", () => {
    expect(() => expiredBackups({ keep, keys: [], now: NOW })).toThrow(
      "not in the listing"
    );
  });

  it("throws when now is not a stamp", () => {
    expect(() =>
      expiredBackups({ keep, keys: [keep], now: "2026-11-04" })
    ).toThrow("--now");
  });

  it("never deletes the kept key even when it is old", () => {
    const oldKeep = keyAgo(50);
    const keys = [...dailyRun(40), oldKeep];
    expect(expiredBackups({ keep: oldKeep, keys, now: NOW })).not.toContain(
      oldKeep
    );
  });
});

const listing = (keys) =>
  JSON.stringify({ Contents: keys.map((Key) => ({ Key })) });

describe("retention CLI", () => {
  it("prints one key per line, oldest first", async () => {
    const keys = dailyRun(38);
    const result = await runCli(
      ["--now", NOW, "--keep", keys[0]],
      listing(keys)
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${keyAgo(37)}\n${keyAgo(36)}\n`);
  });

  it("prints nothing when nothing expired", async () => {
    const keys = dailyRun(10);
    const result = await runCli(
      ["--now", NOW, "--keep", keys[0]],
      listing(keys)
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 1 with empty stdout when --keep is missing", async () => {
    const result = await runCli(["--now", NOW], listing(dailyRun(40)));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("missing --keep");
  });

  it("exits 1 with empty stdout when the listing misses the kept key", async () => {
    const result = await runCli(
      ["--now", NOW, "--keep", keyAgo(0)],
      listing(dailyRun(40, 1))
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("exits 1 on an empty listing", async () => {
    const result = await runCli(
      ["--now", NOW, "--keep", keyAgo(0)],
      '{"RequestCharged": null}'
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  });
});
