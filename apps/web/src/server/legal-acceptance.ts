import {
  type AcceptedLegalVersions,
  isLegalDocumentId,
  LEGAL_DOCUMENTS,
  type LegalDocumentId,
  pendingLegalDocuments,
} from "@polaris/domain/legal/legal-documents";
import type { WorkerBindings } from "./environment";
import type { PendingLegalAcceptance } from "./request-context-error";

/**
 * The server side of the acceptance of the Terms of Use and of the Privacy Policy (ADR 0100). The
 * record is per user, kept by the two `SECURITY DEFINER` functions of the migration, which only the
 * authentication runtime may execute: everything here goes through the authentication connection.
 */

/** The time a read or a record of the acceptance waits for the database, at most. */
const LEGAL_ACCEPTANCE_QUERY_TIMEOUT_MS = 5000;
const requestIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

/** The part of a `pg` pool (or client) this module uses. */
export interface LegalAcceptanceQueryable {
  query: (config: {
    query_timeout: number;
    text: string;
    values: unknown[];
  }) => Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * The procedures that answer without the acceptance of the versions in force, and why. Only these:
 * the acceptance itself, the requests of the data subject (the copy of the
 * data) and the list of devices; and the revocation of this installation by "Sair"
 * (`device.revokeCurrent`), a write that only takes access away, so a person held by the acceptance
 * still leaves without a copy of the device behind. NEVER sync, lease, `device.revoke`,
 * `device.register`, `device.check` or any other write. A test walks the whole router and fails on a
 * name that does not exist, on an exempt sync, lease or write, and on a new procedure nobody decided
 * about.
 */
export const LEGAL_ACCEPTANCE_EXEMPT_PROCEDURES = Object.freeze({
  "account.acceptLegal": "acceptance",
  "account.legalStatus": "acceptance",
  "dataExport.list": "privacy_request",
  "dataExport.listClosed": "privacy_request",
  "dataExport.request": "privacy_request",
  "dataExport.requestClosed": "privacy_request",
  "device.list": "devices_screen",
  "device.revokeCurrent": "logout",
} as const);

/** The `/api/*` routes with the same exemption: the download of the copies asked for above. */
export const LEGAL_ACCEPTANCE_EXEMPT_ROUTES = Object.freeze({
  "/api/closed-exports/:exportId/files/:ordinal": "privacy_request",
  "/api/data-exports/:exportId/files/:ordinal": "privacy_request",
} as const);

export type LegalAcceptanceExemptRoute =
  keyof typeof LEGAL_ACCEPTANCE_EXEMPT_ROUTES;

// The requests marked exempt by the procedure or route that serves them. Keyed by the request object
// itself, so nothing the client sends can mark a request: only the server's own routing does.
const exemptRequests = new WeakSet<Request>();

/**
 * Marks the request of an exempt RPC procedure (by its matched path); any other path is left controlled.
 * It relies on one procedure per HTTP request: the RPC handler has no batch plugin. A batch would share
 * the request among its calls, so turning one on needs another way to carry the exemption.
 */
export function exemptRpcRequest(
  request: Request,
  path: readonly string[]
): void {
  if (Object.hasOwn(LEGAL_ACCEPTANCE_EXEMPT_PROCEDURES, path.join("."))) {
    exemptRequests.add(request);
  }
}

/** Marks the request of an exempt `/api/*` route. */
export function exemptRouteRequest(
  request: Request,
  _route: LegalAcceptanceExemptRoute
): void {
  exemptRequests.add(request);
}

export function isExemptFromLegalAcceptance(request: Request): boolean {
  return exemptRequests.has(request);
}

/** The control is on only with `LEGAL_ACCEPTANCE_ENFORCED=true`; absent, it is off (deploy order of ADR 0100). */
export function isLegalAcceptanceEnforced(bindings: WorkerBindings): boolean {
  return bindings.LEGAL_ACCEPTANCE_ENFORCED === "true";
}

/** The highest version of each document the user accepted. A failure throws: the control fails closed. */
export async function readAcceptedLegalVersions(
  connection: LegalAcceptanceQueryable,
  userId: string
): Promise<AcceptedLegalVersions> {
  const { rows } = await connection.query({
    query_timeout: LEGAL_ACCEPTANCE_QUERY_TIMEOUT_MS,
    text: "SELECT document, version FROM public.legal_acceptance_versions($1::text)",
    values: [userId],
  });
  const accepted: Partial<Record<LegalDocumentId, number>> = {};
  for (const row of rows) {
    if (isLegalDocumentId(row.document) && Number.isInteger(row.version)) {
      accepted[row.document] = row.version as number;
    }
  }
  return accepted;
}

/** What the user still has to accept, each with the version in force. */
export function pendingLegalAcceptance(
  accepted: AcceptedLegalVersions
): PendingLegalAcceptance[] {
  return pendingLegalDocuments(accepted).map((document) => ({
    document,
    version: LEGAL_DOCUMENTS[document].version,
  }));
}

/** The status the acceptance screen shows: the pending documents, with their date and what changed. */
export function legalAcceptanceStatus(accepted: AcceptedLegalVersions) {
  return {
    pending: pendingLegalDocuments(accepted).map((document) => {
      const { changes, effectiveFrom, version } = LEGAL_DOCUMENTS[document];
      return { changes, document, effectiveFrom, version };
    }),
  };
}

/** The database refused a record for a reason that is a bug of the caller (`invalid_*`). */
export class LegalAcceptanceRecordError extends Error {
  readonly result: string;

  constructor(result: string) {
    super("legal_acceptance_not_recorded");
    this.name = "LegalAcceptanceRecordError";
    this.result = result;
  }
}

export type LegalAcceptanceOrigin = "reaceite" | "signup";

/**
 * Records the acceptance of the version in force of a document, with the hash of the server's constant
 * (the client never sends one) and the database clock. Idempotent: the same version again is
 * `already_accepted`. A request ID that the database would refuse is replaced by a fresh one.
 */
export async function recordLegalAcceptance(
  connection: LegalAcceptanceQueryable,
  entry: {
    document: LegalDocumentId;
    origin: LegalAcceptanceOrigin;
    requestId: string;
    userId: string;
  }
): Promise<"already_accepted" | "recorded"> {
  const { sha256, version } = LEGAL_DOCUMENTS[entry.document];
  const requestId = requestIdPattern.test(entry.requestId)
    ? entry.requestId
    : crypto.randomUUID();
  const { rows } = await connection.query({
    query_timeout: LEGAL_ACCEPTANCE_QUERY_TIMEOUT_MS,
    text: "SELECT public.record_legal_acceptance($1::text, $2::text, $3::integer, $4::text, $5::text, $6::text) AS result",
    values: [
      entry.userId,
      entry.document,
      version,
      sha256,
      entry.origin,
      requestId,
    ],
  });
  const result = rows[0]?.result;
  if (result === "recorded" || result === "already_accepted") {
    return result;
  }
  throw new LegalAcceptanceRecordError(
    typeof result === "string" ? result : "no_result"
  );
}
