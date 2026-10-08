export const SESSION_IDLE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_REFRESH_INTERVAL_SECONDS = 24 * 60 * 60;
const SESSION_ABSOLUTE_TTL_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

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
