// biome-ignore lint/style/noRestrictedImports: This is the one place that calls fast-check's assert.
import { assert, type IProperty } from "fast-check";
import { expect } from "vitest";

/**
 * The one way the domain runs a property test (T-124a). Every property goes through `assertProperty`,
 * so `numRuns` and the seed are decided in one place and a run always says how to run it again. Biome
 * refuses `assert` from fast-check anywhere else in `packages/domain`.
 *
 * - `POLARIS_PROPERTY_RUNS`: how many cases each property runs (300 by default). A scheduled or local
 *   run raises it (for example `POLARIS_PROPERTY_RUNS=5000`). A property that needs more than the
 *   default passes `minRuns`: the run is never below it.
 * - `POLARIS_PROPERTY_SEED`: an integer, to replay a run or to pin it; `random` draws a new one.
 *   Without it, the seed comes from the commit under test (`GITHUB_SHA`, so each commit explores
 *   other cases and a rerun of the same commit repeats them) or, outside CI, is a fixed one.
 *
 * The seed is printed on every run (once per test file), not only on a failure, so a case that fails
 * in CI can be replayed.
 */
export const DEFAULT_PROPERTY_RUNS = 300;
export const DEFAULT_PROPERTY_SEED = 20_261_020;

const RUNS_VARIABLE = "POLARIS_PROPERTY_RUNS";
const SEED_VARIABLE = "POLARIS_PROPERTY_SEED";
const COMMIT_VARIABLE = "GITHUB_SHA";
const SEED_LIMIT = 2 ** 31;
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

type Environment = Readonly<Record<string, string | undefined>>;

export type SeedSource = "environment" | "commit" | "fixed";

export interface PropertySettings {
  numRuns: number;
  seed: number;
  source: SeedSource;
}

export interface AssertPropertyOptions {
  /** Only for tests of the helper itself: the process environment is used otherwise. */
  environment?: Environment;
  /** The least runs this property needs; the run is never below it, whatever the environment says. */
  minRuns?: number;
}

function positiveInteger(text: string | undefined): number | undefined {
  if (text === undefined || text.trim() === "") {
    return;
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `${RUNS_VARIABLE} must be a positive integer, got "${text}"`
    );
  }
  return value;
}

/** The seed of a commit: the first eight hex digits of its SHA, kept under 2^31 (a different commit, other cases). */
function seedFromCommit(sha: string): number {
  if (!COMMIT_SHA.test(sha)) {
    throw new Error(`${COMMIT_VARIABLE} must be a commit SHA, got "${sha}"`);
  }
  return Number.parseInt(sha.slice(0, 8), 16) % SEED_LIMIT;
}

function seedFrom(environment: Environment): {
  seed: number;
  source: SeedSource;
} {
  const text = environment[SEED_VARIABLE];
  if (text !== undefined && text.trim() !== "") {
    if (text === "random") {
      return {
        seed: Math.floor(Math.random() * SEED_LIMIT),
        source: "environment",
      };
    }
    const value = Number(text);
    if (!Number.isInteger(value) || Math.abs(value) > SEED_LIMIT) {
      throw new Error(
        `${SEED_VARIABLE} must be an integer or "random", got "${text}"`
      );
    }
    return { seed: value, source: "environment" };
  }
  const commit = environment[COMMIT_VARIABLE]?.trim();
  if (commit) {
    return { seed: seedFromCommit(commit), source: "commit" };
  }
  return { seed: DEFAULT_PROPERTY_SEED, source: "fixed" };
}

/** The runs and the seed for the environment given (the process environment unless a test passes its own). */
export function propertySettings(
  environment: Environment = process.env,
  minRuns = 1
): PropertySettings {
  return {
    numRuns: Math.max(
      positiveInteger(environment[RUNS_VARIABLE]) ?? DEFAULT_PROPERTY_RUNS,
      minRuns
    ),
    ...seedFrom(environment),
  };
}

/** How to run the same cases again: the seed, the runs and the test file. */
export function propertyReplayHint(
  settings: Pick<PropertySettings, "numRuns" | "seed">,
  testPath: string
): string {
  return `Replay: ${SEED_VARIABLE}=${settings.seed} ${RUNS_VARIABLE}=${settings.numRuns} bun run test ${testPath}`;
}

/** The test file under run, relative to the repository when it lives in it (vitest knows it; a bare call does not). */
function currentTestPath(): string {
  const path = expect.getState().testPath;
  if (!path) {
    return "<test file>";
  }
  const root = process.cwd();
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

const announced = new Set<string>();

/** Prints the seed and the replay line once per test file, on every run: a failure in CI needs the seed it ran with. */
function announce(settings: PropertySettings, testPath: string): void {
  if (announced.has(testPath)) {
    return;
  }
  announced.add(testPath);
  // biome-ignore lint/suspicious/noConsole: The seed has to reach the CI log of a run that passes.
  console.info(
    `Property tests: seed ${settings.seed} (${settings.source}), at least ${settings.numRuns} runs. ${propertyReplayHint(settings, testPath)}`
  );
}

/**
 * Runs a property and, when it fails, throws the error of fast-check (counterexample, shrunk case and
 * seed) with the line that replays it.
 */
export function assertProperty<Ts>(
  property: IProperty<Ts>,
  options: AssertPropertyOptions = {}
): void {
  const settings = propertySettings(
    options.environment ?? process.env,
    options.minRuns
  );
  const testPath = currentTestPath();
  if (options.environment === undefined) {
    announce(settings, testPath);
  }
  try {
    assert(property, { numRuns: settings.numRuns, seed: settings.seed });
  } catch (error) {
    if (error instanceof Error) {
      error.message = `${error.message}\n${propertyReplayHint(settings, testPath)}`;
    }
    throw error;
  }
}

/**
 * How many valid cases a property that counts them must have seen: five at the default size, fewer
 * when someone lowers `POLARIS_PROPERTY_RUNS` to run a quick pass, never zero (a property that only
 * rejects would pass).
 */
export function minimumSeen(environment: Environment = process.env): number {
  return Math.max(
    1,
    Math.min(5, Math.floor(propertySettings(environment).numRuns / 20))
  );
}
