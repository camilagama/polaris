/**
 * Canonical field schema of the backend's log events (ADR 0091, PR115).
 *
 * One name per thing: a field that already has a canonical name is never
 * logged under another one. `forbiddenAliases` lists the spellings the code
 * base used (or could drift to) and the name that replaces each; the logger
 * type refuses them, the logger drops them at run time and a test scans the
 * call sites. The policy that keeps personal data out of values is PR116; the
 * schema only fixes names, units and shapes.
 */

/**
 * How an operation ended. One value per wide event.
 *
 * - `success`: did what was asked.
 * - `partial`: did some of it and reports the rest as failed.
 * - `rejected`: refused on purpose (validation, authorization, idempotent
 *   duplicate); retrying the same input changes nothing.
 * - `skipped`: nothing to do (not due, busy, not configured).
 * - `failure`: broke; the operator is the one who has to look.
 */
export const outcomes = [
  "success",
  "partial",
  "rejected",
  "skipped",
  "failure",
] as const;

export type Outcome = (typeof outcomes)[number];

/**
 * Opaque identifiers. The value is an id the system minted (UUID, ULID, a
 * provider id), never an e-mail, a name or a phone number: it identifies a row
 * without telling who the person is. The caller passes that id; the logger
 * only checks the shape (see `isOpaqueId`): it drops an e-mail or a text with
 * spaces, but a bare name or a digits-only phone still has the shape of an id,
 * so the shape is a safety net, not proof of anonymity.
 */
export const opaqueIdFields = [
  "actorId",
  "commandId",
  "correlationId",
  "deviceId",
  "eventId",
  "messageId",
  "organizationId",
  "requestId",
] as const;

const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

declare const opaqueIdBrand: unique symbol;

/**
 * An id-shaped string that went through `opaqueId`. `organizationId`,
 * `actorId` and `deviceId` take this type only, so a plain `string` (an e-mail,
 * a header the client sent, a name) does not compile into those fields. The
 * brand is a compile-time marker: the shape check is `isOpaqueId`, and the
 * logger repeats it at run time.
 */
export type OpaqueId = string & { readonly [opaqueIdBrand]: true };

/** True for an id-shaped value (shape only): no `@`, no spaces, no `+`, at most 128 characters. */
export function isOpaqueId(value: unknown): value is OpaqueId {
  return typeof value === "string" && opaqueIdPattern.test(value);
}

/**
 * The fields that have a fixed name and meaning. Anything else is a free
 * metric (a counter, a short reason) and keeps its own name as long as it is
 * not an alias of one of these.
 */
interface CanonicalFieldTypes {
  /** Who acted: the user or the platform principal. Opaque id. */
  readonly actorId?: OpaqueId;
  /** Attempt number of a retried delivery (1 for the first). */
  readonly attempt?: number;
  /** Id that ties the events of one business flow across requests, queues and jobs. Opaque id. */
  readonly correlationId?: string;
  /** Id of the offline command (ADR on idempotent commands). Opaque id. */
  readonly commandId?: string;
  /** Device that sent the command. Opaque id, never a model name or a user agent. */
  readonly deviceId?: OpaqueId;
  /** Wall-clock time of the operation in milliseconds, never CPU time. */
  readonly durationMs?: number;
  /** Provider or application error code, as the provider spells it. */
  readonly errorCode?: string;
  /** Class (constructor name) of the error, never its message. */
  readonly errorClass?: string;
  /** Id of the outbox/domain event. Opaque id. */
  readonly eventId?: string;
  /** Type of the outbox/domain event, e.g. `sale.confirmed`. */
  readonly eventType?: string;
  /** HTTP status code of the answer. */
  readonly httpStatus?: number;
  /** Scheduled job name. */
  readonly job?: string;
  /** Scheduler lane (`outbox`, `maintenance`). */
  readonly lane?: string;
  /** HTTP method. */
  readonly method?: string;
  /** Id of the queue message. Opaque id. */
  readonly messageId?: string;
  /** Name of the domain command or operation, e.g. `sale.confirm`. */
  readonly operation?: string;
  /** Organization the work belongs to. Opaque id, set by the server, never taken from the client as proof. */
  readonly organizationId?: OpaqueId;
  /** How it ended. */
  readonly outcome?: Outcome;
  /** Payment or e-mail provider. */
  readonly provider?: string;
  /** Queue name. */
  readonly queue?: string;
  /** Short machine reason (`not_due`, `busy`), never free text. */
  readonly reason?: string;
  /** Id of the request (the `x-request-id` the server minted). Opaque id. */
  readonly requestId?: string;
  /** Route *pattern*, never the concrete URL, query or parameters. */
  readonly route?: string;
  /** PostgreSQL SQLSTATE of a database error. */
  readonly sqlState?: string;
}

/** Every canonical field is optional, and an explicit `undefined` means absent (the logger drops it). */
export type CanonicalFields = {
  readonly [K in keyof CanonicalFieldTypes]?:
    | CanonicalFieldTypes[K]
    | undefined;
};

export type CanonicalFieldName = keyof CanonicalFieldTypes;

/** Forbidden spelling -> the canonical name to use instead. */
export const forbiddenAliases = {
  action: "operation",
  actor: "actorId",
  attemptCount: "attempt",
  attemptNumber: "attempt",
  attempts: "attempt",
  cmdId: "commandId",
  code: "errorCode",
  command: "operation",
  command_id: "commandId",
  commandID: "commandId",
  corrId: "correlationId",
  correlation_id: "correlationId",
  correlationID: "correlationId",
  device_id: "deviceId",
  deviceID: "deviceId",
  duration: "durationMs",
  duration_ms: "durationMs",
  durationMS: "durationMs",
  elapsed: "durationMs",
  elapsedMs: "durationMs",
  err_code: "errorCode",
  errCode: "errorCode",
  error_code: "errorCode",
  error_name: "errorClass",
  errorKind: "errorClass",
  errorName: "errorClass",
  errorType: "errorClass",
  event_id: "eventId",
  event_type: "eventType",
  exception: "errorClass",
  httpMethod: "method",
  httpStatusCode: "httpStatus",
  jobId: "job",
  jobName: "job",
  job_id: "job",
  laneId: "lane",
  latency: "durationMs",
  latencyMs: "durationMs",
  message_id: "messageId",
  ms: "durationMs",
  msgId: "messageId",
  op: "operation",
  operationName: "operation",
  orgId: "organizationId",
  orgID: "organizationId",
  org_id: "organizationId",
  organization: "organizationId",
  organization_id: "organizationId",
  path: "route",
  pathname: "route",
  pgCode: "sqlState",
  principalId: "actorId",
  queueName: "queue",
  queue_name: "queue",
  reqId: "requestId",
  req_id: "requestId",
  request_id: "requestId",
  requestID: "requestId",
  result: "outcome",
  resultStatus: "outcome",
  sql_state: "sqlState",
  sqlstate: "sqlState",
  status: "outcome",
  statusCode: "httpStatus",
  status_code: "httpStatus",
  tenant: "organizationId",
  tenantId: "organizationId",
  tenant_id: "organizationId",
  tookMs: "durationMs",
  type: "eventType",
  url: "route",
  userId: "actorId",
  user_id: "actorId",
  verb: "method",
} as const satisfies Record<string, CanonicalFieldName>;

export type ForbiddenAlias = keyof typeof forbiddenAliases;

/** Lowercase, no `_` or `-`: `organization_id`, `OrganizationId` and `organizationid` collide. */
function squash(name: string): string {
  return name.replaceAll(/[_-]/g, "").toLowerCase();
}

/** Exhaustive on purpose: adding a field to `CanonicalFields` fails here until it is listed. */
const canonicalNameSet: Readonly<Record<CanonicalFieldName, true>> = {
  actorId: true,
  attempt: true,
  commandId: true,
  correlationId: true,
  deviceId: true,
  durationMs: true,
  errorClass: true,
  errorCode: true,
  eventId: true,
  eventType: true,
  httpStatus: true,
  job: true,
  lane: true,
  messageId: true,
  method: true,
  operation: true,
  organizationId: true,
  outcome: true,
  provider: true,
  queue: true,
  reason: true,
  requestId: true,
  route: true,
  sqlState: true,
};

const canonicalBySquashed: ReadonlyMap<string, CanonicalFieldName> = new Map(
  (Object.keys(canonicalNameSet) as CanonicalFieldName[]).map((name) => [
    squash(name),
    name,
  ])
);

/** Keyed by the squashed spelling, so `orgid` and `ORG_ID` meet `orgId`. */
const aliasBySquashed: ReadonlyMap<string, CanonicalFieldName> = new Map(
  Object.entries(forbiddenAliases).map(([alias, canonical]) => [
    squash(alias),
    canonical,
  ])
);

/**
 * The canonical name a key should have used, or `undefined` when the key is
 * canonical or is a free metric. Catches the listed aliases and any other
 * casing/underscore spelling of a canonical name or of a listed alias
 * (`request_id`, `RequestId`, `orgid`).
 */
export function canonicalNameFor(key: string): CanonicalFieldName | undefined {
  if (Object.hasOwn(canonicalNameSet, key)) {
    return undefined;
  }
  const squashed = squash(key);
  const listed = aliasBySquashed.get(squashed);
  if (listed !== undefined) {
    return listed;
  }
  const spelled = canonicalBySquashed.get(squashed);
  return spelled !== undefined && spelled !== key ? spelled : undefined;
}
