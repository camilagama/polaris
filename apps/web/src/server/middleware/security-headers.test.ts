import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import staticHeadersFile from "../../../public/_headers?raw";
import { securityHeadersMiddleware } from "./security-headers";
import { SECURITY_HEADERS } from "./security-policy";

const lineBreakPattern = /\r?\n/;

function parseStaticHeaders(source: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let rule: string | undefined;

  for (const line of source.split(lineBreakPattern)) {
    if (line.trim() === "" || line.startsWith("#")) {
      continue;
    }
    if (!line.startsWith(" ")) {
      rule = line.trim();
      continue;
    }
    if (rule !== "/*") {
      throw new Error(`Unexpected _headers rule: ${rule}`);
    }
    const separator = line.indexOf(":");
    headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }

  return headers;
}

describe("security headers", () => {
  it("keeps public/_headers identical to the Worker policy", () => {
    expect(parseStaticHeaders(staticHeadersFile)).toEqual(SECURITY_HEADERS);
  });

  it("applies the shared policy to Worker responses", async () => {
    const app = new Hono();
    app.use("*", securityHeadersMiddleware);
    app.get("/health", (context) => context.json({ status: "ok" }));

    const response = await app.request("/health");

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });

  it("forbids framing, plugins, foreign scripts and foreign connections", () => {
    const policy = SECURITY_HEADERS["Content-Security-Policy"] as string;

    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
    expect(SECURITY_HEADERS["X-Frame-Options"]).toBe("DENY");
  });
});
