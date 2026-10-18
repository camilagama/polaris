import { Client } from "pg";

/**
 * The Admin app's view of the people who run Polaris (plan PR93, ADR 0070). A
 * principal is found by the Access issuer and subject the Worker verified, never
 * by e-mail; one that does not exist, or is disabled, is `null` and gets no
 * access. The database role behind this can only read principals and refresh
 * the e-mail snapshot and last-seen time.
 */

export interface PlatformPrincipal {
  emailSnapshot: string | null;
  id: string;
  issuer: string;
  role: string;
  subject: string;
}

export interface PlatformIdentity {
  /** What Access says the e-mail is; kept only as a label to show who it is. */
  email: string | null;
  issuer: string;
  subject: string;
}

export interface AdminQueryable {
  query: (
    text: string,
    values: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[] }>;
}

/** The last-seen time is refreshed at most this often, so a busy session does not write on every request. */
const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;
const MAX_EMAIL_LENGTH = 320;

function snapshotOf(email: string | null): string | null {
  const trimmed = email?.trim() ?? "";
  return trimmed === "" || trimmed.length > MAX_EMAIL_LENGTH ? null : trimmed;
}

export async function resolvePlatformPrincipal(
  client: AdminQueryable,
  identity: PlatformIdentity
): Promise<PlatformPrincipal | null> {
  const found = await client.query(
    `SELECT id, role, status, email_snapshot, last_seen_at, now() AS now
       FROM public.platform_principals
      WHERE issuer = $1 AND subject = $2`,
    [identity.issuer, identity.subject]
  );
  const [row] = found.rows;
  if (row?.status !== "active") {
    return null;
  }
  const snapshot = snapshotOf(identity.email);
  const lastSeen = row.last_seen_at as Date | null;
  const now = row.now as Date;
  const stale =
    lastSeen === null ||
    now.getTime() - lastSeen.getTime() > LAST_SEEN_REFRESH_MS;
  const changed = snapshot !== null && snapshot !== row.email_snapshot;
  let emailSnapshot = row.email_snapshot as string | null;
  if (stale || changed) {
    emailSnapshot = snapshot ?? emailSnapshot;
    await client.query(
      `UPDATE public.platform_principals
          SET email_snapshot = $2, last_seen_at = now(), updated_at = now()
        WHERE id = $1`,
      [row.id, emailSnapshot]
    );
  }
  return {
    emailSnapshot,
    id: row.id as string,
    issuer: identity.issuer,
    role: row.role as string,
    subject: identity.subject,
  };
}

/** Runs the operation over one connection with the Admin role's login and closes it (a Worker makes one per request). */
export async function withAdminDatabase<T>(
  connectionString: string,
  operation: (client: AdminQueryable) => Promise<T>
): Promise<T> {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    query_timeout: 8000,
    statement_timeout: 5000,
  });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}
