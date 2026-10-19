import { type Outcome, outcomes } from "./fields";
import {
  emit as write,
  type LogFields,
  type LogLevel,
  type LogValue,
} from "./logger";

/**
 * Wide events (ADR 0091, PR115): one event per request, command or job. The
 * handler accumulates fields as it learns them (the organization once the
 * membership is checked, the SQLSTATE when the database refuses) and the event
 * is written once, at the end, with `durationMs` and `outcome`. Facts that need
 * their own line (a lease lost while the job still runs) stay as plain
 * `logger.*` calls with their own event name.
 */

export interface WideEvent {
  /**
   * Writes the event, once; later calls do nothing. `outcome` defaults to the
   * one set on the way, then to `success`. The level follows the outcome.
   */
  emit: (outcome?: Outcome) => void;
  /** Marks `failure` and records the error's class and code, never its message. */
  fail: (error: unknown) => void;
  /** Adds fields; a later value replaces an earlier one, `undefined` changes nothing. */
  set: (fields: LogFields) => void;
}

export interface WideEventOptions {
  /** Clock in milliseconds; injected by tests. */
  now?: () => number;
}

const levelOf: Readonly<Record<Outcome, LogLevel>> = {
  failure: "error",
  partial: "warn",
  rejected: "warn",
  skipped: "info",
  success: "info",
};

const safeNamePattern = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const safeCodePattern = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Class and code of an error as canonical fields. Both are checked against a
 * short safe alphabet, because a provider can put user input in either; the
 * message, the stack and the cause chain are never read.
 */
export function describeError(error: unknown): {
  errorClass: string;
  errorCode?: string;
} {
  if (typeof error !== "object" || error === null) {
    return { errorClass: "NonObjectError" };
  }
  const { code, name } = error as { code?: unknown; name?: unknown };
  const described: { errorClass: string; errorCode?: string } = {
    errorClass:
      typeof name === "string" && safeNamePattern.test(name)
        ? name
        : "UnknownError",
  };
  if (typeof code === "string" && safeCodePattern.test(code)) {
    described.errorCode = code;
  } else if (typeof code === "number" && Number.isSafeInteger(code)) {
    described.errorCode = String(code);
  }
  return described;
}

/**
 * The SQLSTATE classes PostgreSQL defines (Appendix A of its manual). A code is taken for a SQLSTATE only when it has
 * five characters and one of these classes, so `EPERM`, `ECONNRESET` or a five-digit provider code (`10001`) is not.
 */
const sqlStatePattern =
  /^(?:00|01|02|03|08|09|0A|0B|0F|0L|0P|2[0-8]|2B|2D|2F|34|38|39|3B|3D|3F|40|42|44|5[3-8]|72|F0|HV|P0|XX)[0-9A-Z]{3}$/;

export function isSqlState(code: unknown): code is string {
  return typeof code === "string" && sqlStatePattern.test(code);
}

export function startWideEvent(
  event: string,
  initial: LogFields = {},
  options: WideEventOptions = {}
): WideEvent {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const fields: Record<string, LogValue> = {};
  let emitted = false;

  const set = (more: LogFields): void => {
    for (const [key, value] of Object.entries(more)) {
      if (value !== undefined) {
        fields[key] = value;
      }
    }
  };
  set(initial);

  return {
    emit: (outcome) => {
      if (emitted) {
        return;
      }
      emitted = true;
      const wanted = outcome ?? fields.outcome ?? "success";
      // a value forged by a cast must not break the `finally` of `withWideEvent`
      const final = outcomes.find((known) => known === wanted) ?? "failure";
      write(levelOf[final], event, {
        ...fields,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
        outcome: final,
      });
    },
    fail: (error) => {
      // a code left by an earlier failure must not describe this one
      fields.errorCode = undefined;
      set({ ...describeError(error), outcome: "failure" });
    },
    set,
  };
}

/**
 * Runs `work` inside a wide event: a throw marks `failure` (class and code of
 * the error) and is rethrown; the event is written either way.
 */
export async function withWideEvent<T>(
  event: string,
  initial: LogFields,
  work: (wide: WideEvent) => Promise<T>,
  options: WideEventOptions = {}
): Promise<T> {
  const wide = startWideEvent(event, initial, options);
  try {
    return await work(wide);
  } catch (error: unknown) {
    wide.fail(error);
    throw error;
  } finally {
    wide.emit();
  }
}
