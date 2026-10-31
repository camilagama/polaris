import { createORPCClient, onError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { PolarisRpcClient } from "@polaris/contracts";
import {
  saleMayBeOnServer,
  sessionStorageOrNull,
} from "../sales/sale-attempt-storage";
import { endSessionHere } from "../offline/runtime/session-ended";
import { browserConnection } from "./browser-connection";
import { markLegalAcceptanceRequired } from "./legal-acceptance";
import {
  markOrganizationClosed,
  requestedOrganizationId,
  type SaleRefusalCause,
} from "./organization-closed";
import {
  isLegalAcceptanceRefusal,
  isOrganizationClosedRefusal,
  rpcErrorCode,
} from "./rpc-error";
import { trackWrite } from "./writes-in-flight";

function closedCause(
  options: { input: unknown; path: readonly string[] },
  organizationId: string
): SaleRefusalCause | "other" {
  if (options.path.join("/") !== "sale/confirm") {
    return "other";
  }
  const { commandId } = (options.input ?? {}) as { commandId?: unknown };
  return typeof commandId === "string" &&
    saleMayBeOnServer(sessionStorageOrNull(), organizationId, commandId)
    ? "sale_resent"
    : "sale";
}

function createPolarisRpcClient(origin: string): PolarisRpcClient {
  const link = new RPCLink({
    // Every response is classified before oRPC decodes it: one that does not carry the Worker's mark is
    // thrown as "no answer", so the UNAUTHORIZED below only ever comes from the Worker (emenda do ADR 0043).
    fetch: (request, init) => browserConnection.fetch(request, init),
    interceptors: [
      // a write on its way holds the swap of the build (pwa/swap-guard.ts) until it answers or fails
      (options) => trackWrite(options.path, () => options.next()),
      // The server said, in answer to one of the screen's own calls, that the session is over: the shell
      // offers "Entrar de novo" (it never navigates by itself while something may be in progress).
      onError((error, options) => {
        // the closed store first: it is a FORBIDDEN too, and the session is fine. Only the reason says so; a FORBIDDEN
        // without it is never taken for a closure
        const closedId = isOrganizationClosedRefusal(error)
          ? requestedOrganizationId(options.input)
          : null;
        if (closedId !== null) {
          markOrganizationClosed(closedId, closedCause(options, closedId));
        } else if (rpcErrorCode(error) === "UNAUTHORIZED") {
          endSessionHere();
        } else if (isLegalAcceptanceRefusal(error)) {
          // not a refused session: nothing is dropped, the shell shows the fixed notice with `/aceite`
          markLegalAcceptanceRequired();
        }
      }),
    ],
    method: "POST",
    url: new URL("/rpc", origin),
  });

  return createORPCClient(link);
}

export const orpcClient = createPolarisRpcClient(window.location.origin);
