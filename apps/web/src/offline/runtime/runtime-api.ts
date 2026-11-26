import type { PolarisRpcClient } from "@polaris/contracts";
import {
  createSessionLookup,
  type SessionAnswer,
  type SessionLookup,
} from "../../lib/session-lookup";
import type {
  BootstrapCollectionName,
  BootstrapPageRequest,
  BootstrapSource,
  LocalRows,
} from "../bootstrap";
import {
  type RuntimeApi,
  type SignedInSession,
  SessionUnreachableError,
} from "./offline-runtime";

/** 5xx and 429 say nothing about who is signed in: they are a server that could not answer, not a refusal. */
function isNoAnswer(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * The server answered another collection than the one asked for. The bootstrap would store those rows
 * under the asked collection and drop the real ones, so the page is refused before anything is written.
 */
export class BootstrapResponseMismatchError extends Error {
  constructor() {
    super("bootstrap_response_mismatch");
    this.name = "BootstrapResponseMismatchError";
  }
}

function isDeviceRefusal(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "CONFLICT" || error.code === "NOT_FOUND")
  );
}

/**
 * The runtime's window to the server, over the same RPC client the screens use:
 * the session cookie authorizes every call, the organization is only the
 * requested context, and the server revalidates all of it (ADR 0033).
 */
export function createRpcRuntimeApi(
  client: PolarisRpcClient,
  // in the browser, over the connection's fetch: a 401 or 403 that is not the Worker's is no answer, not "no session"
  session: SessionLookup = createSessionLookup({
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
  })
): RuntimeApi {
  const readSession = async (options?: {
    fresh?: boolean;
  }): Promise<SignedInSession | null> => {
    let answer: SessionAnswer;
    try {
      answer = await session.read(options);
    } catch (cause) {
      throw new SessionUnreachableError("session_unreachable", { cause });
    }
    if (answer.status === 401 || answer.status === 403) {
      return null; // the server said, in so many words, that there is no session for this cookie
    }
    if (isNoAnswer(answer.status)) {
      // the server is down, overloaded or throttling: no answer, the same as having no connection
      throw new SessionUnreachableError(`session_http_${answer.status}`);
    }
    if (answer.status < 200 || answer.status >= 300) {
      throw new Error("session_unavailable");
    }
    if (answer.body === undefined) {
      throw new Error("session_unavailable");
    }
    const body = answer.body as {
      session?: { id?: unknown };
      user?: { id?: unknown };
    } | null;
    const userId = body?.user?.id;
    if (!(typeof userId === "string" && userId !== "")) {
      return null;
    }
    const sessionId = body?.session?.id;
    return {
      sessionId:
        typeof sessionId === "string" && sessionId !== "" ? sessionId : null,
      userId,
    };
  };
  return {
    // `device.check` also links this session to the device, so revoking the
    // device ends this session even if it never syncs (called at an online
    // start unless this same session was linked in the last 12 h). Revoked or
    // unknown is "not mine"; any other failure is thrown.
    deviceIsMine: async (deviceId) => {
      try {
        await client.device.check({ deviceId });
        return true;
      } catch (error) {
        if (isDeviceRefusal(error)) {
          return false;
        }
        throw error;
      }
    },
    issueLease: async (deviceId, organizationId) => {
      const issued = await client.offline.issueLease({
        deviceId,
        organizationId,
      });
      return { expiresAt: issued.expiresAt, lease: issued.lease };
    },
    push: (organizationId) => (input) =>
      client.sync.push({ commands: input.commands, organizationId }),
    registerDevice: async (label) => {
      const { device } = await client.device.register({ label });
      return device.id;
    },
    sessionUserId: async (options) =>
      (await readSession(options))?.userId ?? null,
    signedInSession: () => readSession({ fresh: true }),
    source: (organizationId, signal, expectedUserId): BootstrapSource => {
      const options = signal ? { signal } : undefined;
      return {
        getCursor: async () =>
          (await client.sync.getCursor({ organizationId }, options)).cursor,
        page: async <K extends BootstrapCollectionName>(
          collection: K,
          request: BootstrapPageRequest
        ) => {
          const page = await client.sync.bootstrapPage(
            {
              afterId: request.afterId ?? null,
              collection,
              ids: request.ids ?? null,
              limit: request.limit ?? 200,
              organizationId,
            },
            options
          );
          if (page.collection !== collection) {
            throw new BootstrapResponseMismatchError();
          }
          // the contract's union cannot be tied to the generic K, so the rows are narrowed here, after the check
          return {
            nextAfterId: page.nextAfterId,
            rows: page.rows as unknown as LocalRows[K][],
          };
        },
        pull: (cursor, limit) =>
          client.sync.pull(
            { cursor, expectedUserId, limit, organizationId },
            options
          ),
        recentSales: async () =>
          (await client.sale.list({ limit: 100, organizationId }, options))
            .sales,
      };
    },
  };
}
