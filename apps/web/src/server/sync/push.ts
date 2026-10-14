import type {
  PushCommandReadModel,
  PushResultReadModel,
} from "@polaris/contracts";
import type {
  runSyncCommand,
  SyncJson,
} from "@polaris/db/sync-command-repository";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "@polaris/db/tenant-transaction";
import { InvalidOfflineLeaseError } from "@polaris/domain/offline/offline-lease";
import { canonicalJson, sha256Hex } from "../../lib/canonical-json";
import { verifyOfflineLease } from "../../lib/offline-lease-token";
import type { OfflineLeaseKeys } from "../offline-lease-service";

/**
 * The server side of `sync.push` (plan PR53): turns a batch of queued commands
 * into one outcome per command. The database frame (`runSyncCommand`) does the
 * idempotency, lease revalidation and savepoint; this layer verifies the lease
 * signature, finds the domain handler, validates the payload and keeps the
 * batch in order: after a rejection the rest are "not processed", so a command
 * never overtakes one it may depend on.
 */
export class InvalidSyncPayloadError extends Error {
  constructor() {
    super("invalid_sync_payload");
    this.name = "InvalidSyncPayloadError";
  }
}

interface SyncCommandContext {
  baseVersion: number | null;
  commandId: string;
}

/** How one command type is validated, authorized and executed on the server. */
export interface SyncCommandHandler {
  /** The domain capability the lease and the role must both grant. */
  capability: string;
  /** Maps an expected domain failure to a stable code; null re-throws. */
  classify: (error: unknown) => string | null;
  execute: (
    transaction: TenantRequestTransaction,
    identity: TenantRequestIdentity,
    payload: unknown,
    context: SyncCommandContext
  ) => Promise<SyncJson>;
  /** Throws `InvalidSyncPayloadError` for a payload the command cannot take. */
  parse: (payload: unknown) => unknown;
  type: string;
}

export const PUSH_REJECTION = {
  capabilityNotInLease: "capability_not_in_lease",
  invalidPayload: "invalid_payload",
  leaseInvalid: "lease_invalid",
  unsupportedCommandType: "unsupported_command_type",
} as const;

export interface PushDependencies {
  handlers: readonly SyncCommandHandler[];
  keys: OfflineLeaseKeys;
  now: () => Date;
  runSyncCommand: typeof runSyncCommand;
  /** Runs `operation` in an authorized tenant transaction for `sync:push`. */
  withTenant: <T>(
    operation: (
      transaction: TenantRequestTransaction,
      identity: TenantRequestIdentity
    ) => Promise<T>
  ) => Promise<T>;
}

function isAccepted(result: PushResultReadModel): boolean {
  return result.status === "accepted";
}

async function pushOne(
  command: PushCommandReadModel,
  dependencies: PushDependencies
): Promise<PushResultReadModel> {
  const handler = dependencies.handlers.find(
    (candidate) => candidate.type === command.type
  );
  let precheckFailure: string | null = null;
  let leaseClaims: Awaited<ReturnType<typeof verifyOfflineLease>> | null = null;
  let parsed: unknown = null;
  try {
    leaseClaims = await verifyOfflineLease(
      command.lease,
      dependencies.keys.verification,
      dependencies.now(),
      { checkWindow: false }
    );
  } catch (error) {
    if (!(error instanceof InvalidOfflineLeaseError)) {
      throw error;
    }
    precheckFailure = PUSH_REJECTION.leaseInvalid;
  }
  if (precheckFailure === null && !handler) {
    precheckFailure = PUSH_REJECTION.unsupportedCommandType;
  }
  if (
    precheckFailure === null &&
    handler &&
    leaseClaims &&
    !leaseClaims.caps.includes(handler.capability)
  ) {
    precheckFailure = PUSH_REJECTION.capabilityNotInLease;
  }
  if (precheckFailure === null && handler) {
    try {
      parsed = handler.parse(command.payload);
    } catch (error) {
      if (!(error instanceof InvalidSyncPayloadError)) {
        throw error;
      }
      precheckFailure = PUSH_REJECTION.invalidPayload;
    }
  }

  const payloadHash = await sha256Hex(
    canonicalJson({
      baseVersion: command.baseVersion,
      payload: command.payload,
      type: command.type,
    })
  );
  const outcome = await dependencies.withTenant((transaction, identity) =>
    dependencies.runSyncCommand(
      transaction,
      identity,
      {
        commandId: command.commandId,
        commandType: command.type,
        createdAt: new Date(command.createdAt),
        deviceId: command.deviceId,
        leaseClaims,
        now: dependencies.now(),
        payloadHash,
        precheckFailure,
      },
      (savepoint) => {
        if (!handler) {
          throw new InvalidSyncPayloadError();
        }
        return handler.execute(savepoint, identity, parsed, {
          baseVersion: command.baseVersion,
          commandId: command.commandId,
        });
      },
      (error) => handler?.classify(error) ?? null
    )
  );
  return {
    code: outcome.code,
    commandId: command.commandId,
    replayed: outcome.replayed,
    result: outcome.result,
    status: outcome.status,
  };
}

/** Processes the batch in order; a rejection stops the rest of it. */
export async function pushCommands(
  commands: readonly PushCommandReadModel[],
  dependencies: PushDependencies
): Promise<PushResultReadModel[]> {
  const results: PushResultReadModel[] = [];
  let blocked = false;
  for (const command of commands) {
    if (blocked) {
      results.push({
        code: null,
        commandId: command.commandId,
        replayed: false,
        result: null,
        status: "not_processed",
      });
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: commands are applied strictly in order
    const result = await pushOne(command, dependencies);
    results.push(result);
    blocked = !isAccepted(result);
  }
  return results;
}
