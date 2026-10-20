import { createORPCClient, onError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { PolarisRpcClient } from "@polaris/contracts";
import { endSessionHere } from "../offline/runtime/session-ended";
import { rpcErrorCode } from "./rpc-error";

function createPolarisRpcClient(origin: string): PolarisRpcClient {
  const link = new RPCLink({
    interceptors: [
      // The server said, in answer to one of the screen's own calls, that the session is over: the shell
      // offers "Entrar de novo" (it never navigates by itself while something may be in progress).
      onError((error) => {
        if (rpcErrorCode(error) === "UNAUTHORIZED") {
          endSessionHere();
        }
      }),
    ],
    method: "POST",
    url: new URL("/rpc", origin),
  });

  return createORPCClient(link);
}

export const orpcClient = createPolarisRpcClient(window.location.origin);
