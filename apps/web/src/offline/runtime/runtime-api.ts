import type { PolarisRpcClient } from "@polaris/contracts";
import {
  createSessionLookup,
  type SessionAnswer,
  type SessionLookup,
} from "../../lib/session-lookup";
import type { BootstrapSource } from "../bootstrap";
import { type RuntimeApi, SessionUnreachableError } from "./offline-runtime";

/** 5xx and 429 say nothing about who is signed in: they are a server that could not answer, not a refusal. */
function isNoAnswer(status: number): boolean {
  return status === 429 || status >= 500;
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
  return {
    // `device.check` also links this session to the device, so revoking the
    // device ends this session even if it never syncs (called at every online
    // start). Revoked or unknown is "not mine"; any other failure is thrown.
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
    sessionUserId: async (options) => {
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
      const id = (answer.body as { user?: { id?: unknown } } | null)?.user?.id;
      return typeof id === "string" && id !== "" ? id : null;
    },
    source: (organizationId, signal): BootstrapSource => {
      const options = signal ? { signal } : undefined;
      return {
        getCursor: async () =>
          (await client.sync.getCursor({ organizationId }, options)).cursor,
        page: async (collection, request) => {
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
          return { nextAfterId: page.nextAfterId, rows: page.rows } as never;
        },
        pull: (cursor, limit) =>
          client.sync.pull({ cursor, limit, organizationId }, options),
        recentSales: async () =>
          (await client.sale.list({ limit: 100, organizationId }, options))
            .sales,
      };
    },
  };
}
