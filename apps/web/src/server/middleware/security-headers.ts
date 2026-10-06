import { secureHeaders } from "hono/secure-headers";

export const securityHeadersMiddleware = secureHeaders({
  strictTransportSecurity: false,
});
