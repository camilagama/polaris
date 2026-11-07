export const SESSION_IDLE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_REFRESH_INTERVAL_SECONDS = 24 * 60 * 60;
const SESSION_ABSOLUTE_TTL_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
/** A session signed in this recently may revoke another device. */
export const FRESH_SESSION_MAX_AGE_MILLISECONDS = 15 * 60 * 1000;

/** Whether the session signed in within the fresh window; an unreadable creation time is not fresh. */
export function isSessionFresh(
  createdAt: Date | string,
  now = Date.now()
): boolean {
  const createdAtMilliseconds =
    createdAt instanceof Date
      ? createdAt.getTime()
      : new Date(createdAt).getTime();

  return (
    Number.isFinite(createdAtMilliseconds) &&
    now - createdAtMilliseconds < FRESH_SESSION_MAX_AGE_MILLISECONDS
  );
}

export function isSessionPastAbsoluteExpiration(
  createdAt: Date | string,
  now = Date.now()
): boolean {
  const createdAtMilliseconds =
    createdAt instanceof Date
      ? createdAt.getTime()
      : new Date(createdAt).getTime();

  return (
    !Number.isFinite(createdAtMilliseconds) ||
    now >= createdAtMilliseconds + SESSION_ABSOLUTE_TTL_MILLISECONDS
  );
}
