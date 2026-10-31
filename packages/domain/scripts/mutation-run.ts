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

/** One entry per folder for the summary. A folder this run did not ask for is "not-run" and its report is not read: the JSON left by an earlier run would pass as a finished one. */
export function foldersForSummary(
  states: ReadonlyMap<string, FolderState>,
  read: (folder: string, state: FolderState) => FolderReport
): FolderReport[] {
  return FOLDERS.map((folder) => {
    const state = states.get(folder);
    return state === undefined
      ? { folder, report: null, state: "not-run" as const }
      : read(folder, state);
  });
}

/** Text of the warning when `src/` differs from how it was before the run (Stryker with inPlace did not restore it) or the comparison could not be made (`null` diff); `null` when it is the same. */
export function unrestoredSourceWarning(
  before: string | null,
  after: string | null
): string | null {
  if (before === null || after === null) {
    return "Could not check src/ with git diff, so it is not known whether Stryker restored it. Run git status and, if src/ changed: git checkout -- packages/domain/src";
  }
  if (before === after) {
    return null;
  }
  return "src/ was left different from how the run found it (Stryker did not restore the mutated files). Restore it before committing: git checkout -- packages/domain/src";
}
