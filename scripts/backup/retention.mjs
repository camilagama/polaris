#!/usr/bin/env node
// The retention of the daily backups (docs/runbooks/backup.md, ADR 0099): a backup older than 35 days is deleted,
// but the 35 newest always stay, so a job that stopped for weeks never deletes the last copies when it comes back.
// Only keys this job writes count; any other object of the prefix is never deleted.
//
//   aws s3api list-objects-v2 ... --output json |
//     node retention.mjs --now AAAAMMDDTHHMMSSZ --keep daily/AAAAMMDDTHHMMSSZ.tar.age
//
// Prints the keys to delete, one per line. Refuses (exit 1, nothing printed) when the backup just uploaded is not in
// the listing: a listing that misses it cannot be trusted to say what is old.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MAX_AGE_DAYS = 35;
export const MINIMUM_KEPT = 35;
const DAY_MS = 24 * 60 * 60 * 1000;
const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const KEY = /^daily\/(\d{8}T\d{6}Z)\.tar\.age$/;

/** The instant of a stamp `AAAAMMDDTHHMMSSZ`, or null when it is not one (including impossible dates). */
export function stampInstant(stamp) {
  const parts = STAMP.exec(stamp);
  if (!parts) {
    return null;
  }
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  const instant = Date.UTC(year, month - 1, day, hour, minute, second);
  const back = new Date(instant);
  const exact =
    back.getUTCFullYear() === year &&
    back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === day &&
    back.getUTCHours() === hour &&
    back.getUTCMinutes() === minute &&
    back.getUTCSeconds() === second;
  return exact ? instant : null;
}

function backupInstant(key) {
  const match = KEY.exec(key);
  return match ? stampInstant(match[1]) : null;
}

/**
 * The keys to delete, oldest first: backups written by this job, older than `maxAgeDays` before `now`, outside the
 * `minimum` newest and other than `keep`. A stamp in the future of `now` is never old.
 */
export function expiredBackups({
  keys,
  now,
  keep,
  maxAgeDays = MAX_AGE_DAYS,
  minimum = MINIMUM_KEPT,
}) {
  const nowInstant = stampInstant(now);
  if (nowInstant === null) {
    throw new Error("--now must be a stamp AAAAMMDDTHHMMSSZ");
  }
  if (!keys.includes(keep)) {
    throw new Error(
      "the backup just uploaded is not in the listing: nothing is deleted"
    );
  }
  const backups = keys
    .map((key) => ({ instant: backupInstant(key), key }))
    .filter((entry) => entry.instant !== null)
    .sort((a, b) => b.instant - a.instant || (a.key < b.key ? 1 : -1));
  const newest = new Set(backups.slice(0, minimum).map((entry) => entry.key));
  const limit = nowInstant - maxAgeDays * DAY_MS;
  return backups
    .filter(
      (entry) =>
        entry.instant < limit && !newest.has(entry.key) && entry.key !== keep
    )
    .map((entry) => entry.key)
    .reverse();
}

/**
 * The keys of an `aws s3api list-objects-v2 --output json` answer: empty output, or an object without `Contents`,
 * when the prefix is empty.
 */
export function parseListing(text) {
  const trimmed = text.trim();
  if (trimmed === "") {
    return [];
  }
  const answer = JSON.parse(trimmed);
  const contents = answer?.Contents ?? [];
  if (
    !(
      answer &&
      typeof answer === "object" &&
      !Array.isArray(answer) &&
      Array.isArray(contents) &&
      contents.every((entry) => typeof entry?.Key === "string")
    )
  ) {
    throw new Error("the listing is not a list-objects-v2 answer");
  }
  return contents.map((entry) => entry.Key);
}

function option(args, name) {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function main(args) {
  try {
    const expired = expiredBackups({
      keep: option(args, "--keep"),
      keys: parseListing(readFileSync(0, "utf8")),
      now: option(args, "--now"),
    });
    process.stdout.write(expired.map((key) => `${key}\n`).join(""));
  } catch (error) {
    console.error(`backup retention: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
