import { describe, expect, it, vi } from "vitest";
import {
  googleAuthorizationUrl,
  googleStartOutcome,
  hasSession,
  loadAuthMethods,
  parseAuthMethods,
  startGoogleSignIn,
} from "./sign-in-model";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
const GOOGLE_URL = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x";

describe("startGoogleSignIn", () => {
  it("posts the provider and the encoded destination, and returns Google's address", async () => {
    const fetcher = vi.fn(async () =>
      json({ redirect: true, url: GOOGLE_URL })
    );

    const result = await startGoogleSignIn("/sales/history?x=1", fetcher);

    expect(result).toEqual({ status: "redirect", url: GOOGLE_URL });
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/auth/sign-in/social");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      callbackURL: "/entrar?voltar=%2Fsales%2Fhistory%3Fx%3D1",
      errorCallbackURL: "/entrar?erro=google",
      provider: "google",
    });
  });

  it("answers `limite` to a 429", async () => {
    const result = await startGoogleSignIn(undefined, async () =>
      json({ error: { code: "auth_rate_limited" } }, 429)
    );
    expect(result).toEqual({ failure: "limite", status: "failed" });
  });

  it.each([
    ["a 503", async () => json({ error: { code: "x" } }, 503)],
    ["a 403", async () => json({ error: { code: "x" } }, 403)],
    ["a network failure", async () => Promise.reject(new TypeError("offline"))],
    [
      "an answer that is not JSON",
      async () => new Response("<html>", { status: 200 }),
    ],
    ["an answer without an address", async () => json({ redirect: true })],
    [
      "an address that is not Google's",
      async () => json({ url: "https://evil.example/x" }),
    ],
    [
      "an address over http",
      async () => json({ url: "http://accounts.google.com/x" }),
    ],
    ["a javascript address", async () => json({ url: "javascript:alert(1)" })],
  ])("answers `indisponivel` to %s", async (_name, fetcher) => {
    expect(await startGoogleSignIn("/sales", fetcher)).toEqual({
      failure: "indisponivel",
      status: "failed",
    });
  });
});

describe("googleAuthorizationUrl", () => {
  it("accepts only an https address on Google's host", () => {
    expect(googleAuthorizationUrl({ url: GOOGLE_URL })).toBe(GOOGLE_URL);
    expect(
      googleAuthorizationUrl({
        url: "https://accounts.google.com.evil.example/",
      })
    ).toBeNull();
    expect(googleAuthorizationUrl(null)).toBeNull();
    expect(googleAuthorizationUrl({ url: 3 })).toBeNull();
  });
});

describe("parseAuthMethods and loadAuthMethods", () => {
  it("reads the three fields", () => {
    expect(
      parseAuthMethods({
        emailPassword: true,
        google: true,
        turnstileSiteKey: "k",
      })
    ).toEqual({ emailPassword: true, google: true, turnstileSiteKey: "k" });
    expect(
      parseAuthMethods({
        emailPassword: false,
        google: false,
        turnstileSiteKey: null,
      })
    ).toEqual({ emailPassword: false, google: false, turnstileSiteKey: null });
  });

  it.each([
    null,
    "x",
    {},
    { emailPassword: false, google: "yes" },
    { google: true },
  ])("refuses %j", (body) => {
    expect(parseAuthMethods(body)).toBeNull();
  });

  it("says `null` (unknown) when the request fails or answers badly", async () => {
    expect(
      await loadAuthMethods(async () => Promise.reject(new Error("x")))
    ).toBeNull();
    expect(await loadAuthMethods(async () => json({}, 503))).toBeNull();
    expect(await loadAuthMethods(async () => json({ nope: true }))).toBeNull();
  });
});

describe("hasSession", () => {
  it("is true only with a session object", async () => {
    expect(
      await hasSession(async () => json({ session: { id: "s" }, user: {} }))
    ).toBe(true);
    expect(await hasSession(async () => json(null))).toBe(false);
    expect(await hasSession(async () => json({ session: null }))).toBe(false);
    expect(await hasSession(async () => json({}, 500))).toBe(false);
    expect(await hasSession(async () => Promise.reject(new Error("x")))).toBe(
      false
    );
  });
});

describe("googleStartOutcome", () => {
  it("lets the page leave for Google's address", () => {
    expect(googleStartOutcome({ status: "redirect", url: GOOGLE_URL })).toEqual(
      {
        status: "redirect",
        url: GOOGLE_URL,
      }
    );
  });

  it.each([
    "https://evil.example/x",
    "https://accounts.google.com.evil.example/",
    "http://accounts.google.com/x",
    "javascript:alert(1)",
    "/entrar",
    "",
  ])("shows the error state instead of leaving for %j", (url) => {
    expect(googleStartOutcome({ status: "redirect", url })).toEqual({
      failure: "indisponivel",
      status: "failed",
    });
  });

  it("passes a failure along as it is", () => {
    expect(googleStartOutcome({ failure: "limite", status: "failed" })).toEqual(
      { failure: "limite", status: "failed" }
    );
  });
});
