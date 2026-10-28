// The rounds Lighthouse CI saved (`.lighthouseci/lhr-*.json`), read for `lighthouse.mjs`: which rounds ran on a
// contended CPU, which to keep, and the table of medians. Pure functions over the reports, tested in
// lighthouse-rounds.test.ts.
import { readdirSync, readFileSync } from "node:fs";

/** The rounds a page needs, and the share of the fastest `benchmarkIndex` seen below which a round counts as contended. */
export const ROUNDS_PER_PAGE = 3;
export const CONTENDED_BELOW = 0.85;

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** What one report says: its page, the machine speed Lighthouse measured while it ran, and the four metrics. */
export function roundOf(file, lhr) {
  const { audits } = lhr;
  return {
    benchmark: lhr.environment.benchmarkIndex,
    cls: audits["cumulative-layout-shift"].numericValue,
    file,
    js: audits["resource-summary"].details.items.find(
      (item) => item.resourceType === "script"
    ).transferSize,
    lcp: audits["largest-contentful-paint"].numericValue,
    tbt: audits["total-blocking-time"].numericValue,
    url: lhr.requestedUrl,
  };
}

export function readRounds(directory) {
  return readdirSync(directory)
    .filter((name) => name.startsWith("lhr-") && name.endsWith(".json"))
    .sort()
    .map((name) =>
      roundOf(name, JSON.parse(readFileSync(`${directory}/${name}`, "utf8")))
    );
}

/** The speed (`benchmarkIndex`) a round has to reach: a share of the fastest one seen in the run. */
function speedBar(rounds) {
  return Math.max(...rounds.map((round) => round.benchmark)) * CONTENDED_BELOW;
}

/**
 * How many rounds each page still needs: the rounds measured while the machine was slower than at its best (a neighbor
 * on the same cores scales the work of every task by the CPU slowdown and moves the LCP and the TBT by seconds) do not
 * count, and a page asks for as many as it lacks to have `ROUNDS_PER_PAGE` that do.
 */
export function missingByPage(rounds) {
  const bar = speedBar(rounds);
  const good = new Map();
  for (const round of rounds) {
    good.set(
      round.url,
      (good.get(round.url) ?? 0) + (round.benchmark >= bar ? 1 : 0)
    );
  }
  const missing = new Map();
  for (const [url, count] of good) {
    if (count < ROUNDS_PER_PAGE) {
      missing.set(url, ROUNDS_PER_PAGE - count);
    }
  }
  return missing;
}

/** The files to drop so that each page keeps its `ROUNDS_PER_PAGE` rounds measured on the fastest CPU. */
export function surplusFiles(rounds) {
  const byPage = new Map();
  for (const round of rounds) {
    byPage.set(round.url, [...(byPage.get(round.url) ?? []), round]);
  }
  return [...byPage.values()].flatMap((list) =>
    [...list]
      .sort((a, b) => b.benchmark - a.benchmark)
      .slice(ROUNDS_PER_PAGE)
      .map((round) => round.file)
  );
}

const label = (url) => {
  const { pathname } = new URL(url);
  return pathname === "/" ? "/ (Início)" : pathname;
};

/** The medians per page and how far apart the rounds of the LCP were (the median is what the assertions read), as a Markdown table. */
export function summaryTable(rounds) {
  const lines = [
    "| Página | Rodadas | LCP (ms) | TBT (ms) | CLS | JS (B, gzip) | LCP: menor a maior | benchmarkIndex: menor a maior |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const url of new Set(rounds.map((round) => round.url))) {
    const own = rounds.filter((round) => round.url === url);
    const of = (key) => own.map((round) => round[key]);
    const lcp = of("lcp");
    const spread = (Math.max(...lcp) - Math.min(...lcp)) / median(lcp);
    lines.push(
      `| ${label(url)} | ${own.length} | ${Math.round(median(lcp))} | ${Math.round(median(of("tbt")))} | ${median(of("cls")).toFixed(3)} | ${median(of("js"))} | ${(spread * 100).toFixed(1)}% | ${Math.round(Math.min(...of("benchmark")))} a ${Math.round(Math.max(...of("benchmark")))} |`
    );
  }
  return lines.join("\n");
}
