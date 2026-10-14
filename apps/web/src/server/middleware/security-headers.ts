import type { MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { SECURITY_HEADERS } from "./security-policy";

// Hono's defaults cover the remaining cross-origin isolation headers; the
// shared policy below overrides every header it defines.
const honoDefaults = secureHeaders({ strictTransportSecurity: false });

export const securityHeadersMiddleware: MiddlewareHandler = async (
  context,
  next
) => {
  await honoDefaults(context, next);

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    context.header(name, value);
  }
};
