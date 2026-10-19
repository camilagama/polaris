import { createCspNonce } from "@polaris/http-security";
import { configureLogging } from "@polaris/observability/logger";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { requestWithNonce, secureResponse } from "./server/security";

configureLogging({ service: "polaris-catalog" });

// Start finds this file by itself and delegates to its own handler; this entry adds the nonce and the
// security headers of ADR 0090. The dev server injects inline scripts of its own (HMR, React refresh),
// which no production policy allows, so it runs without them; a build always has them.
export default createServerEntry({
  fetch: async (request, options) => {
    if (import.meta.env.DEV) {
      return await handler.fetch(request, options);
    }
    const nonce = createCspNonce();
    return secureResponse(
      await handler.fetch(requestWithNonce(request, nonce), options),
      nonce
    );
  },
});
