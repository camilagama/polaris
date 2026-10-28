import type { FolderState } from "./mutation-summary";

export const FOLDERS = ["inventory", "money", "economics", "sales"];

/** The deadline as a timestamp; `null` when unset; `"invalid"` when it is not a positive number, so a typo cannot switch the limit off. */
export function parseDeadline(
  value: string | undefined,
  now: number
): number | null | "invalid" {
  if (value === undefined || value === "") {
    return null;
  }
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return "invalid";
  }
  return now + minutes * 60_000;
}

/** Milliseconds left for the next folder; `null` without deadline; at most 0 when it already passed. */
export function remainingMs(
  deadline: number | null,
  now: number
): number | null {
  return deadline === null ? null : deadline - now;
}

interface Finish {
  status: number | null;
  timedOut: boolean;
}

export function stateOfRun({ status, timedOut }: Finish): FolderState {
  if (timedOut) {
    return "cut";
  }
  return status === 0 ? "complete" : "failed";
}

/** The mark that lets the next night skip: all four folders, asked for together, finished. */
export function isComplete(
  states: FolderState[],
  askedForAll: boolean
): boolean {
  return (
    askedForAll &&
    states.length === FOLDERS.length &&
    states.every((state) => state === "complete")
  );
}
