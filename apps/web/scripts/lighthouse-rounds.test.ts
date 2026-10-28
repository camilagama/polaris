import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  median,
  missingByPage,
  type Round,
  readRounds,
  roundOf,
  surplusFiles,
  summaryTable,
} from "./lighthouse-rounds.mjs";

const SIGN_IN = "http://127.0.0.1:4381/entrar";
const HOME = "http://127.0.0.1:4382/";

const lhr = (url: string, benchmark: number, lcp: number) => ({
  audits: {
    "cumulative-layout-shift": { numericValue: 0.05 },
    "largest-contentful-paint": { numericValue: lcp },
    "resource-summary": {
      details: {
        items: [
          { resourceType: "total", transferSize: 900_000 },
          { resourceType: "script", transferSize: 300_000 },
        ],
      },
    },
    "total-blocking-time": { numericValue: 120 },
  },
  environment: { benchmarkIndex: benchmark },
  requestedUrl: url,
});

const round = (
  url: string,
  file: string,
  benchmark: number,
  lcp = 3000
): Round => roundOf(file, lhr(url, benchmark, lcp));

describe("the rounds of the Lighthouse run", () => {
  it("reads the page, the machine speed and the four metrics out of a report", () => {
    expect(round(HOME, "lhr-1.json", 1200, 4800)).toEqual({
      benchmark: 1200,
      cls: 0.05,
      file: "lhr-1.json",
      js: 300_000,
      lcp: 4800,
      tbt: 120,
      url: HOME,
    });
  });

  it("reads only the JSON reports of the folder, oldest first", () => {
    const directory = mkdtempSync(join(tmpdir(), "lh-rounds-"));
    try {
      for (const [name, body] of [
        ["lhr-2.json", lhr(HOME, 1200, 1)],
        ["lhr-1.json", lhr(SIGN_IN, 1200, 1)],
      ] as const) {
        writeFileSync(join(directory, name), JSON.stringify(body));
      }
      writeFileSync(join(directory, "lhr-1.html"), "<!doctype html>");
      writeFileSync(join(directory, "manifest.json"), "[]");
      expect(readRounds(directory).map((item) => item.file)).toEqual([
        "lhr-1.json",
        "lhr-2.json",
      ]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("takes the middle value, not the mean", () => {
    expect(median([5000, 100, 3000])).toBe(3000);
    expect(median([3000])).toBe(3000);
  });

  it("asks, per page, for as many rounds as it lacks at the speed of the machine", () => {
    const rounds = [
      round(SIGN_IN, "a", 1300),
      round(SIGN_IN, "b", 1260),
      round(SIGN_IN, "c", 1000),
      round(HOME, "d", 513),
      round(HOME, "e", 900),
      round(HOME, "f", 1250),
    ];
    expect(missingByPage(rounds)).toEqual(
      new Map([
        [SIGN_IN, 1],
        [HOME, 2],
      ])
    );
  });

  it("asks for nothing once the slow rounds have been replaced by fast ones", () => {
    const rounds = [
      round(HOME, "slow", 513),
      round(HOME, "a", 1180),
      round(HOME, "b", 1250),
      round(HOME, "c", 1313),
    ];
    expect(missingByPage(rounds).size).toBe(0);
  });

  it("asks for nothing when every round ran at the speed of the machine", () => {
    const rounds = [1180, 1250, 1313].map((speed, index) =>
      round(HOME, String(index), speed)
    );
    expect(missingByPage(rounds).size).toBe(0);
  });

  it("keeps asking while only slow rounds exist, as many as the page lacks", () => {
    const rounds = [
      round(HOME, "a", 1300),
      round(HOME, "b", 600),
      round(HOME, "c", 590),
    ];
    expect(missingByPage(rounds)).toEqual(new Map([[HOME, 2]]));
  });

  it("keeps the three rounds on the fastest CPU of each page and names the rest to drop", () => {
    const rounds = [
      round(HOME, "slow", 600),
      round(HOME, "a", 1200),
      round(HOME, "b", 1250),
      round(HOME, "c", 1100),
      round(SIGN_IN, "x", 1000),
      round(SIGN_IN, "y", 1100),
    ];
    expect(surplusFiles(rounds)).toEqual(["slow"]);
  });

  it("drops nothing from a page that has no more than three rounds", () => {
    const rounds = [round(HOME, "a", 400), round(HOME, "b", 300)];
    expect(surplusFiles(rounds)).toEqual([]);
  });

  it("tabulates the median of each metric and the range of the LCP, one row per page", () => {
    const rounds = [
      round(SIGN_IN, "a", 1180, 3400),
      round(SIGN_IN, "b", 1290, 3600),
      round(SIGN_IN, "c", 1250, 3500),
      round(HOME, "d", 1200, 5000),
    ];
    expect(summaryTable(rounds).split("\n").slice(2)).toEqual([
      "| /entrar | 3 | 3500 | 120 | 0.050 | 300000 | 5.7% | 1180 a 1290 |",
      "| / (Início) | 1 | 5000 | 120 | 0.050 | 300000 | 0.0% | 1200 a 1200 |",
    ]);
  });
});
