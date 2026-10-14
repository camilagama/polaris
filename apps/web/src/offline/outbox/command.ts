import { canonicalJson } from "../../lib/canonical-json";

/**
 * The envelope of an offline command (plan PR52, ADR 0015/0003): what the
 * outbox stores durably and what `sync.push` will send. The domain does not
 * change: a command carries the domain command's payload and the context the
 * server needs to authorize and replay it (organization, device, base version,
 * lease). The command ID is the idempotency key: the server answers a repeated
 * ID with the stored result.
 */
export const OUTBOX_MAX_PAYLOAD_BYTES = 256 * 1024;
export const OUTBOX_MAX_PENDING = 10_000;

type OutboxJson =
  | boolean
  | number
  | string
  | null
  | OutboxJson[]
  | { [key: string]: OutboxJson };

type OutboxCommandStatus =
  /** Waiting to be sent. */
  | "pending"
  /** Sent; the answer is unknown (the app may have died). Safe to resend: same ID. */
  | "sending"
  /** The server refused it; it blocks the commands behind it until resolved. */
  | "rejected";

export interface OutboxCommandInput {
  /** The version of the entity the command was made against, when it has one. */
  baseVersion: number | null;
  commandId: string;
  deviceId: string;
  /** The signed lease token the command was made under (PR49). */
  lease: string;
  organizationId: string;
  payload: OutboxJson;
  /** The domain command name, e.g. "sale.confirm". */
  type: string;
}

interface OutboxRejection {
  at: string;
  code: string;
}

export interface OutboxCommand extends OutboxCommandInput {
  attempts: number;
  createdAt: string;
  lastAttemptAt: string | null;
  rejection: OutboxRejection | null;
  /** Local, monotonic position: commands are sent in this order. */
  seq: number;
  status: OutboxCommandStatus;
}

export class InvalidOutboxCommandError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`invalid_outbox_command:${reason}`);
    this.name = "InvalidOutboxCommandError";
    this.reason = reason;
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const typePattern = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const rejectionCodePattern = /^[a-z][a-z0-9_]{0,63}$/;

function isJson(value: unknown, depth = 0): value is OutboxJson {
  if (depth > 32) {
    return false;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJson(item, depth + 1));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    return (
      (prototype === Object.prototype || prototype === null) &&
      Object.values(value as Record<string, unknown>).every((item) =>
        isJson(item, depth + 1)
      )
    );
  }
  return false;
}

/** Deterministic text of a JSON value (sorted keys), to compare payloads. */
const stableJson: (value: OutboxJson) => string = canonicalJson;

function payloadByteSize(payload: OutboxJson): number {
  return new TextEncoder().encode(stableJson(payload)).length;
}

function assertText(value: unknown, reason: string, max: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new InvalidOutboxCommandError(reason);
  }
}

/** Throws `InvalidOutboxCommandError` unless the envelope is well formed. */
export function assertOutboxCommandInput(input: OutboxCommandInput): void {
  if (
    typeof input.commandId !== "string" ||
    !uuidPattern.test(input.commandId)
  ) {
    throw new InvalidOutboxCommandError("command_id");
  }
  if (typeof input.deviceId !== "string" || !uuidPattern.test(input.deviceId)) {
    throw new InvalidOutboxCommandError("device_id");
  }
  assertText(input.organizationId, "organization_id", 255);
  assertText(input.lease, "lease", 4096);
  if (typeof input.type !== "string" || !typePattern.test(input.type)) {
    throw new InvalidOutboxCommandError("type");
  }
  if (
    input.baseVersion !== null &&
    !(Number.isSafeInteger(input.baseVersion) && input.baseVersion >= 0)
  ) {
    throw new InvalidOutboxCommandError("base_version");
  }
  if (!isJson(input.payload)) {
    throw new InvalidOutboxCommandError("payload_not_json");
  }
  if (payloadByteSize(input.payload) > OUTBOX_MAX_PAYLOAD_BYTES) {
    throw new InvalidOutboxCommandError("payload_too_large");
  }
}

export function assertRejectionCode(code: string): void {
  if (!rejectionCodePattern.test(code)) {
    throw new InvalidOutboxCommandError("rejection_code");
  }
}

/** True when two envelopes describe the same command (the idempotent retry). */
export function sameOutboxCommand(
  left: OutboxCommandInput,
  right: OutboxCommandInput
): boolean {
  return (
    left.commandId === right.commandId &&
    left.type === right.type &&
    left.organizationId === right.organizationId &&
    left.deviceId === right.deviceId &&
    left.baseVersion === right.baseVersion &&
    stableJson(left.payload) === stableJson(right.payload)
  );
}
