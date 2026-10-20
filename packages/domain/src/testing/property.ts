import { assert, type IProperty } from "fast-check";

/**
 * The one way the domain runs a property test (T-124a). Every property goes through `assertProperty`,
 * so `numRuns` and the seed are decided in one place and a failure always says how to run it again.
 *
 * - `POLARIS_PROPERTY_RUNS`: how many cases each property runs. Low by default (the pull request
 *   pays for it); a scheduled or local run raises it (for example `POLARIS_PROPERTY_RUNS=5000`).
 * - `POLARIS_PROPERTY_SEED`: an integer, to replay a failure or to pin a run. The default is a fixed
 *   seed, so a pull request never fails by luck; `random` draws a new one, which the failure prints.
 */
export const DEFAULT_PROPERTY_RUNS = 100;
export const DEFAULT_PROPERTY_SEED = 20_261_020;

const RUNS_VARIABLE = "POLARIS_PROPERTY_RUNS";
const SEED_VARIABLE = "POLARIS_PROPERTY_SEED";

type Environment = Readonly<Record<string, string | undefined>>;

export interface PropertySettings {
  numRuns: number;
  seed: number;
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

function seedFrom(text: string | undefined): number {
  if (text === undefined || text.trim() === "") {
    return DEFAULT_PROPERTY_SEED;
  }
  if (text === "random") {
    return Math.floor(Math.random() * 2 ** 31);
  }
  const value = Number(text);
  if (!Number.isInteger(value) || Math.abs(value) > 2 ** 31) {
    throw new Error(
      `${SEED_VARIABLE} must be an integer or "random", got "${text}"`
    );
  }
  return value;
}

/** The runs and the seed for the environment given (the process environment unless a test passes its own). */
export function propertySettings(
  environment: Environment = process.env
): PropertySettings {
  return {
    numRuns:
      positiveInteger(environment[RUNS_VARIABLE]) ?? DEFAULT_PROPERTY_RUNS,
    seed: seedFrom(environment[SEED_VARIABLE]),
  };
}

/** How to run the same cases again, for the message of a failure. */
export function propertyReplayHint(settings: PropertySettings): string {
  return `Replay: ${SEED_VARIABLE}=${settings.seed} ${RUNS_VARIABLE}=${settings.numRuns} bun run test <file>`;
}

/**
 * Runs a property and, when it fails, throws the error of fast-check (counterexample, shrunk case and
 * seed) with the line that replays it.
 */
export function assertProperty<Ts>(
  property: IProperty<Ts>,
  environment: Environment = process.env
): void {
  const settings = propertySettings(environment);
  try {
    assert(property, settings);
  } catch (error) {
    if (error instanceof Error) {
      error.message = `${error.message}\n${propertyReplayHint(settings)}`;
    }
    throw error;
  }
}

/**
 * How many valid cases a property that counts them must have seen: five at the default size, fewer
 * when someone lowers `POLARIS_PROPERTY_RUNS` to run a quick pass.
 */
export function minimumSeen(environment: Environment = process.env): number {
  return Math.min(5, Math.floor(propertySettings(environment).numRuns / 20));
}
