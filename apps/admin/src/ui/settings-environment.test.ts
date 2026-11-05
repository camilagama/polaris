import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The environment of Configurações is the banner of the menu (corte admin-v2, AC-P9.2): the Worker writes it into the
 * page and the script writes it again, so the two sources are read as text and must say the same words.
 */
const here = dirname(fileURLToPath(import.meta.url));
const worker = readFileSync(join(here, "page.ts"), "utf8");
const screen = readFileSync(join(here, "../../ui/views/settings.ts"), "utf8");
const WORKER_BANNER =
  /banner: "([^"]+)",\s*kind: "(production|staging|unknown)"/g;
const SCREEN_BANNER = /^\s*(production|staging|unknown): "([^"]+)",?$/gm;

describe("the environment words of Configurações", () => {
  const ofWorker = new Map(
    [...worker.matchAll(WORKER_BANNER)].map((match) => [match[2], match[1]])
  );
  const ofScreen = new Map(
    [...screen.matchAll(SCREEN_BANNER)].map((match) => [match[1], match[2]])
  );

  it("are found in both files (the check is not blind)", () => {
    expect([...ofWorker.keys()].sort()).toEqual([
      "production",
      "staging",
      "unknown",
    ]);
    expect([...ofScreen.keys()].sort()).toEqual([
      "production",
      "staging",
      "unknown",
    ]);
  });

  it("are the same as the banner of the menu", () => {
    expect(Object.fromEntries(ofScreen)).toEqual(Object.fromEntries(ofWorker));
  });
});
