import { createCspNonce } from "@polaris/http-security";
import {
  createServerEntry,
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";
import { requestWithNonce, secureResponse } from "./server/security";

const handler = createStartHandler(defaultStreamHandler);

// The same entry TanStack Start ships, plus the nonce and the security headers of ADR 0090. The dev
// server injects inline scripts of its own (HMR, React refresh), which no production policy allows,
// so it runs without them; a build always has them.
export default createServerEntry({
  fetch: async (request, options) => {
    if (import.meta.env.DEV) {
      return await handler(request, options);
    }
    const nonce = createCspNonce();
    return secureResponse(
      await handler(requestWithNonce(request, nonce), options),
      nonce
    );
  },
});
