import { describe, expect, it } from "vitest";
import {
  createCspNonce,
  defaultCacheControl,
  renderStaticHeadersFile,
  type SecurityProfile,
  securityHeaders,
} from "./index";

const PROFILES: readonly SecurityProfile[] = [
  "admin",
  "api",
  "app-shell",
  "public-document",
  "public-media",
];

const NO_WILDCARD = /\*/;
const NO_SCHEME_OR_ORIGIN = /^https?:?$|^https?:\/\//;
const NO_JS_EVAL = /(?<!wasm-)unsafe-eval/;
const NONCE_SHAPE = /^[A-Za-z0-9+/]{22}==$/;
const NO_TRAILING_SPACE = /sandbox $/;
const EXACT_ORIGIN = /exact https origin/;
const LOADS_NOTHING = /loads nothing/;
const NO_NONCE = /no nonce/;
const NONCE_REQUIRED = /nonce/;

const NONCE = "dGVzdC1ub25jZS0xMjM0NQ==";

function headersOf(profile: SecurityProfile) {
  return securityHeaders(
    profile,
    profile === "public-document" ? { nonce: NONCE } : {}
  );
}

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split("; ").map((directive) => {
      const [name = "", ...sources] = directive.split(" ");
      return [name, sources];
    })
  );
}

describe("the headers of every profile", () => {
  it.each(PROFILES)(
    "%s forbids sniffing, framing and plain http",
    (profile) => {
      const headers = headersOf(profile);

      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(headers["Strict-Transport-Security"]).toBe(
        "max-age=31536000; includeSubDomains"
      );
      expect(headers["Strict-Transport-Security"]).not.toContain("preload");
      expect(headers["Permissions-Policy"]).toBe(
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
      );
      expect(
        directives(headers["Content-Security-Policy"]).get("frame-ancestors")
      ).toEqual(["'none'"]);
    }
  );

  it.each(PROFILES)("%s has no dangerous source in its policy", (profile) => {
    const policy = headersOf(profile)["Content-Security-Policy"];
    const parsed = directives(policy);

    expect(policy).not.toContain("unsafe-inline");
    // 'wasm-unsafe-eval' (WebAssembly only) is allowed; JavaScript eval is not
    expect(policy).not.toMatch(NO_JS_EVAL);
    expect(policy).not.toContain("strict-dynamic");
    for (const [directive, sources] of parsed) {
      for (const source of sources) {
        // no wildcard, no scheme alone (http:, https:) and no foreign origin by default
        expect(source, `${profile} ${directive}`).not.toMatch(NO_WILDCARD);
        expect(source, `${profile} ${directive}`).not.toMatch(
          NO_SCHEME_OR_ORIGIN
        );
      }
    }
    // data: is never a script, style or frame source; the one data: the shell allows is connect-src (see below)
    for (const directive of [
      "script-src",
      "style-src",
      "frame-src",
      "child-src",
    ]) {
      expect(parsed.get(directive) ?? []).not.toContain("data:");
    }
    // a profile either closes everything by default or lists what it opens
    expect(parsed.get("default-src")).toBeDefined();
  });

  it("keeps the document profiles from running anything but their own scripts", () => {
    for (const profile of ["app-shell", "public-document"] as const) {
      const parsed = directives(headersOf(profile)["Content-Security-Policy"]);
      expect(parsed.get("object-src")).toEqual(["'none'"]);
      expect(parsed.get("base-uri")).toEqual(["'self'"]);
      expect(parsed.get("form-action")).toEqual(["'self'"]);
      expect(parsed.get("script-src")?.[0]).toBe("'self'");
    }
  });

  it("closes everything for the profiles that are data, not pages", () => {
    for (const profile of ["admin", "api", "public-media"] as const) {
      const parsed = directives(headersOf(profile)["Content-Security-Policy"]);
      expect(parsed.get("default-src")).toEqual(["'none'"]);
      expect(parsed.has("script-src")).toBe(false);
      expect(parsed.get("form-action")).toEqual(["'none'"]);
    }
  });

  it("sandboxes an image opened as a document and lets any origin embed it", () => {
    const headers = headersOf("public-media");

    expect(directives(headers["Content-Security-Policy"]).has("sandbox")).toBe(
      true
    );
    expect(headers["Content-Security-Policy"]).not.toMatch(NO_TRAILING_SPACE);
    expect(headers["Cross-Origin-Resource-Policy"]).toBe("cross-origin");
    expect(headers["Cross-Origin-Opener-Policy"]).toBeUndefined();
  });

  it.each(["admin", "api", "app-shell", "public-document"] as const)(
    "isolates %s from other origins",
    (profile) => {
      const headers = headersOf(profile);

      expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
      expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
      expect(headers["X-Frame-Options"]).toBe("DENY");
    }
  );

  it("sends no referrer at all from the Admin", () => {
    expect(headersOf("admin")["Referrer-Policy"]).toBe("no-referrer");
    expect(headersOf("api")["Referrer-Policy"]).toBe(
      "strict-origin-when-cross-origin"
    );
  });
});

describe("the policy of the app shell", () => {
  it("lets the offline store run WebAssembly and read its embedded module, and nothing else", () => {
    const parsed = directives(
      headersOf("app-shell")["Content-Security-Policy"]
    );

    expect(parsed.get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(parsed.get("connect-src")).toEqual(["'self'", "data:"]);
    expect(parsed.get("style-src")).toEqual(["'self'"]);
    expect(parsed.get("img-src")).toEqual(["'self'", "blob:", "data:"]);
  });

  it("opens an origin only when the app asks for it", () => {
    const parsed = directives(
      securityHeaders("app-shell", {
        connectSources: [
          "https://o1.ingest.sentry.io",
          "https://a.example.com:8443",
          "https://o1.ingest.sentry.io",
        ],
        imgSources: ["https://images.example.com"],
      })["Content-Security-Policy"]
    );

    expect(parsed.get("connect-src")).toEqual([
      "'self'",
      "data:",
      "https://a.example.com:8443",
      "https://o1.ingest.sentry.io",
    ]);
    expect(parsed.get("img-src")).toContain("https://images.example.com");
    expect(parsed.get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  });

  it.each([
    "*",
    "https://*.example.com",
    "https:",
    "http://example.com",
    "https://example.com/path",
    "https://example.com?x=1",
    "'unsafe-inline'",
    "data:",
    "https://localhost",
    "https://exa mple.com",
    "example.com",
    "https://10.0.0.1",
    "https://127.0.0.1:8443",
    "https://1.2.3.4.5",
  ])("refuses the source %s", (source) => {
    expect(() =>
      securityHeaders("app-shell", { connectSources: [source] })
    ).toThrow(EXACT_ORIGIN);
    expect(() =>
      securityHeaders("app-shell", { imgSources: [source] })
    ).toThrow(EXACT_ORIGIN);
  });

  it("does not let a profile that loads nothing open a source or take a nonce", () => {
    for (const profile of ["admin", "api", "public-media"] as const) {
      expect(() =>
        securityHeaders(profile, { connectSources: ["https://a.example.com"] })
      ).toThrow(LOADS_NOTHING);
      expect(() => securityHeaders(profile, { nonce: NONCE })).toThrow(
        NO_NONCE
      );
    }
    expect(() => securityHeaders("app-shell", { nonce: NONCE })).toThrow(
      NO_NONCE
    );
  });
});

describe("the policy of the public documents", () => {
  it("allows the scripts of the site and the ones carrying this response's nonce", () => {
    const parsed = directives(
      securityHeaders("public-document", { nonce: NONCE })[
        "Content-Security-Policy"
      ]
    );

    expect(parsed.get("script-src")).toEqual(["'self'", `'nonce-${NONCE}'`]);
    expect(parsed.get("img-src")).toEqual(["'self'"]);
    expect(parsed.get("connect-src")).toEqual(["'self'"]);
    expect(parsed.get("style-src")).toEqual(["'self'"]);
  });

  it.each([
    undefined,
    "",
    "short",
    'has space and "quotes"',
    "a;b",
    "x'y".padEnd(24, "a"),
  ])("refuses the nonce %j", (nonce) => {
    expect(() =>
      securityHeaders("public-document", nonce === undefined ? {} : { nonce })
    ).toThrow(NONCE_REQUIRED);
  });

  it("makes a different nonce every time, with 128 random bits", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => createCspNonce()));

    expect(nonces.size).toBe(50);
    for (const nonce of nonces) {
      expect(nonce).toMatch(NONCE_SHAPE);
      expect(() => securityHeaders("public-document", { nonce })).not.toThrow();
    }
  });
});

describe("Cache-Control", () => {
  it("makes the answers of the Worker and of the Admin uncacheable", () => {
    expect(defaultCacheControl("api")).toBe("no-store");
    expect(defaultCacheControl("admin")).toBe("no-store");
    for (const profile of [
      "app-shell",
      "public-document",
      "public-media",
    ] as const) {
      expect(defaultCacheControl(profile)).toBeNull();
    }
  });
});

describe("the static headers file", () => {
  it("carries the app shell headers for every path and revalidates the service worker", () => {
    const file = renderStaticHeadersFile();

    expect(file).toContain("\n/*\n");
    for (const [name, value] of Object.entries(securityHeaders("app-shell"))) {
      expect(file).toContain(`\n  ${name}: ${value}\n`);
    }
    expect(file).toContain("\n/sw.js\n  Cache-Control: no-cache\n");
    expect(file.endsWith("\n")).toBe(true);
  });
});
