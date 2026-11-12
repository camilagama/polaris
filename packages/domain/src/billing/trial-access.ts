import { saoPauloDateOf } from "./provider-period";

/**
 * How long a trial's access outlasts the end of the São Paulo day its stored
 * end falls on. The provider takes the first charge during that day (the Asaas
 * card capture comes in the late afternoon), so a trial that ended at the exact
 * stored instant would drop to Free, and record `over_limit_since`, in the
 * hours between that instant and the confirmation (AC-47).
 */
export const TRIAL_SLACK_HOURS = 6;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** São Paulo has had no daylight saving time since 2019: its days start at 03:00 UTC. */
const SAO_PAULO_OFFSET = "-03:00";

/**
 * Until when a trial whose record stores `accessEndsAt` grants Pro: the end of
 * that instant's day in São Paulo plus `TRIAL_SLACK_HOURS` (`17/11 13:46` →
 * `18/11 06:00`). Only the reading changes: the stored end stays as it is.
 */
export function trialAccessEndsAt(accessEndsAt: Date): Date {
  const day = saoPauloDateOf(accessEndsAt);
  const start = new Date(`${day}T00:00:00.000${SAO_PAULO_OFFSET}`);
  return new Date(start.getTime() + DAY_MS + TRIAL_SLACK_HOURS * HOUR_MS);
}
