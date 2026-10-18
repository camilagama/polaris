import { createCspNonce } from "@polaris/http-security";
import { describe, expect, it } from "vitest";
import { NONCE_HEADER, requestWithNonce, secureResponse } from "./security";

const UNSAFE_OR_WILDCARD = /unsafe-|\*/;

const nonce = createCspNonce();

function html(headers: Record<string, string> = {}) {
  return new Response("<html></html>", {
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });
}

describe("the nonce of a request", () => {
  it("replaces a value the client sent and keeps the rest of the request", async () => {
    const request = new Request("https://catalogo.example/loja", {
      body: "{}",
      headers: { [NONCE_HEADER]: "forged", "x-other": "kept" },
      method: "POST",
    });

    const result = requestWithNonce(request, nonce);

    expect(result.headers.get(NONCE_HEADER)).toBe(nonce);
    expect(result.headers.get("x-other")).toBe("kept");
    expect(result.method).toBe("POST");
    expect(await result.text()).toBe("{}");
  });
});

describe("the security headers of the public catalog", () => {
  it("gives a page the policy with the nonce of this response and no 'unsafe-inline'", () => {
    const response = secureResponse(html(), nonce);
    const policy = response.headers.get("Content-Security-Policy") ?? "";

    expect(policy).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toMatch(UNSAFE_OR_WILDCARD);
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe(
      "same-origin"
    );
    expect(response.headers.get("Strict-Transport-Security")).toContain(
      "max-age="
    );
  });

  it("keeps the body, the status and the Cache-Control of a route that is not a page", async () => {
    const response = secureResponse(
      new Response("{}", {
        headers: {
          "Cache-Control": "public, max-age=60",
          "Content-Type": "application/json",
        },
      }),
      nonce
    );

    expect(await response.text()).toBe("{}");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(
      secureResponse(new Response(null, { status: 404 }), nonce).status
    ).toBe(404);
  });

  it("makes anything that is not a page inert, without a nonce or a cache rule of its own", () => {
    const robots = secureResponse(
      new Response("User-agent: *", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      nonce
    );
    const redirect = secureResponse(
      Response.redirect("https://catalogo.example/loja", 302),
      nonce
    );

    for (const response of [robots, redirect]) {
      expect(response.headers.get("Content-Security-Policy")).not.toContain(
        "nonce"
      );
      expect(response.headers.get("Content-Security-Policy")).toContain(
        "default-src 'none'"
      );
      expect(response.headers.has("Cache-Control")).toBe(false);
    }
    expect(redirect.status).toBe(302);
  });

  it("leaves alone a response that already carries its own policy, as an image does", () => {
    const image = new Response("x", {
      headers: {
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });

    const result = secureResponse(image, nonce);

    expect(result).toBe(image);
    expect(result.headers.get("Cross-Origin-Resource-Policy")).toBe(
      "cross-origin"
    );
  });
});

describe("the cache of a page", () => {
  it("is never shared, whatever the route asked for, so a nonce is never served twice", () => {
    for (const asked of [
      undefined,
      "public, max-age=60",
      "public, s-maxage=300",
      "max-age=600",
    ]) {
      const response = secureResponse(
        html(asked === undefined ? {} : { "Cache-Control": asked }),
        nonce
      );
      expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    }
  });

  it("keeps a page's own private or no-store rule", () => {
    for (const asked of ["private, max-age=5", "no-store"]) {
      expect(
        secureResponse(html({ "Cache-Control": asked }), nonce).headers.get(
          "Cache-Control"
        )
      ).toBe(asked);
    }
  });
});
