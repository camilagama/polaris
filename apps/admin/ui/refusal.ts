import { type ApiFailure, PROBLEM_TEXT } from "./api";
import { minutesText } from "./format";

/** The 429 sentence: how long to wait when the server said, the plain one when it did not. */
export function limitText(failure: ApiFailure): string {
  return failure.retryAfterSeconds === undefined
    ? PROBLEM_TEXT.rate_limited
    : `Limite de consultas por hora atingido. Tente de novo em ${minutesText(failure.retryAfterSeconds)}.`;
}

/**
 * The failures after which a write may have happened all the same (the request left, the answer did not come back or
 * could not be read): they get the sentence that says so, never a plain "failed".
 */
export function writeMayHaveHappened(failure: ApiFailure): boolean {
  return (
    failure.problem === "network" ||
    failure.problem === "failed" ||
    failure.problem === "unavailable" ||
    failure.problem === "plan_catalog_incomplete"
  );
}
