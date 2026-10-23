import { createORPCClient, onError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { PolarisRpcClient } from "@polaris/contracts";
import { endSessionHere } from "../offline/runtime/session-ended";
import { browserConnection } from "./browser-connection";
import { markLegalAcceptanceRequired } from "./legal-acceptance";
import { isLegalAcceptanceRefusal, rpcErrorCode } from "./rpc-error";

function createPolarisRpcClient(origin: string): PolarisRpcClient {
  const link = new RPCLink({
    // Every response is classified before oRPC decodes it: one that does not carry the Worker's mark is
    // thrown as "no answer", so the UNAUTHORIZED below only ever comes from the Worker (emenda do ADR 0043).
    fetch: (request, init) => browserConnection.fetch(request, init),
    interceptors: [
      // The server said, in answer to one of the screen's own calls, that the session is over: the shell
      // offers "Entrar de novo" (it never navigates by itself while something may be in progress).
      onError((error) => {
        if (rpcErrorCode(error) === "UNAUTHORIZED") {
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
