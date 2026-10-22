import { describe, expect, it } from "vitest";
import { isSafeAuthCallbackPath } from "./return-path";
import {
  buildSocialSignInRequest,
  currentReturnPath,
  logoutDestination,
  parseSignInSearch,
  signInPath,
} from "./sign-in-path";

const BODY_CHARACTERS = /^[\w\-.+/=&%@?]*$/;

describe("signInPath without a reason (U-01)", () => {
  it("opens the plain screen when the browser never had a session", () => {
    expect(signInPath({})).toBe("/entrar");
    expect(signInPath({ returnTo: "/sales" })).toBe("/entrar?voltar=/sales");
  });

  it("carries the reason 'saiu' after 'Sair' and reads it back", () => {
    const path = signInPath({ reason: "saiu", returnTo: "/sales" });
    expect(path).toBe("/entrar?motivo=saiu&voltar=/sales");
    expect(parseSignInSearch(path.slice("/entrar".length)).reason).toBe("saiu");
  });
});

describe("buildSocialSignInRequest", () => {
  it("sends the plain start as the destination when there is none", () => {
    expect(buildSocialSignInRequest()).toEqual({
      callbackURL: "/entrar",
      errorCallbackURL: "/entrar?erro=google",
      provider: "google",
    });
  });

  it("carries a simple path inside voltar, fully encoded", () => {
    expect(buildSocialSignInRequest("/sales").callbackURL).toBe(
      "/entrar?voltar=%2Fsales"
    );
  });

  it("encodes a path with a query (the AC-41 example)", () => {
    expect(buildSocialSignInRequest("/sales/history?x=1").callbackURL).toBe(
      "/entrar?voltar=%2Fsales%2Fhistory%3Fx%3D1"
    );
  });

  it("encodes an accented path", () => {
    expect(buildSocialSignInRequest("/café").callbackURL).toBe(
      "/entrar?voltar=%2Fcaf%C3%A9"
    );
  });

  it("encodes the characters that encodeURIComponent leaves alone", () => {
    const { callbackURL } = buildSocialSignInRequest("/sales?q=(x)!'*~");
    expect(callbackURL).toBe(
      "/entrar?voltar=%2Fsales%3Fq%3D%28x%29%21%27%2A%7E"
    );
    expect(callbackURL).toMatch(BODY_CHARACTERS);
  });

  it("never sends an idToken", () => {
    expect(Object.keys(buildSocialSignInRequest("/sales")).sort()).toEqual([
      "callbackURL",
      "errorCallbackURL",
      "provider",
    ]);
  });

  it.each([
    ["another host", "//evil.example"],
    ["a backslash", "/\\evil.example"],
    ["a scheme", "https://evil.example"],
    ["javascript", "javascript:alert(1)"],
    ["an encoded double slash", "%2F%2Fevil.example"],
    ["the sign-in page", "/entrar"],
    ["a long text", `/${"a".repeat(300)}`],
    ["an empty value", ""],
    ["the API", "/api/auth/sign-out"],
  ])("sends the start instead of %s", (_name, value) => {
    expect(buildSocialSignInRequest(value).callbackURL).toBe("/entrar");
  });

  it("only builds callbacks the app itself accepts", () => {
    for (const value of ["/sales", "/sales/history?x=1", "/café", "/a?b=(c)"]) {
      const request = buildSocialSignInRequest(value);
      expect(isSafeAuthCallbackPath(request.callbackURL)).toBe(true);
      expect(isSafeAuthCallbackPath(request.errorCallbackURL)).toBe(true);
    }
  });
});

describe("signInPath", () => {
  it("carries the reason and the destination", () => {
    expect(signInPath({ reason: "sessao", returnTo: "/devices" })).toBe(
      "/entrar?motivo=sessao&voltar=/devices"
    );
  });

  it("escapes what would break the query, keeping the slashes", () => {
    expect(
      signInPath({ reason: "sessao", returnTo: "/sales/history?x=1&y=2" })
    ).toBe("/entrar?motivo=sessao&voltar=/sales/history%3Fx%3D1%26y%3D2");
  });

  it("leaves a destination out when it is not valid", () => {
    expect(signInPath({ reason: "recente", returnTo: "//evil.example" })).toBe(
      "/entrar?motivo=recente"
    );
    expect(signInPath({ reason: "recente" })).toBe("/entrar?motivo=recente");
  });
});

describe("logoutDestination", () => {
  it("goes to the sign-in screen with a valid destination", () => {
    expect(logoutDestination({ reason: "recente", returnTo: "/devices" })).toBe(
      "/entrar?motivo=recente&voltar=/devices"
    );
  });

  it.each([undefined, "", "//evil.example", "https://evil.example", "/entrar"])(
    "goes to the start without a valid destination (%s)",
    (returnTo) => {
      expect(logoutDestination({ reason: "sessao", returnTo })).toBe("/");
    }
  );
});

describe("currentReturnPath", () => {
  it("returns the page and its query", () => {
    expect(
      currentReturnPath({ pathname: "/sales/history", search: "?x=1" })
    ).toBe("/sales/history?x=1");
  });

  it("never returns the sign-in screen", () => {
    expect(
      currentReturnPath({ pathname: "/entrar", search: "?erro=google" })
    ).toBeUndefined();
  });
});

describe("parseSignInSearch", () => {
  it("reads the three parameters", () => {
    expect(
      parseSignInSearch("?motivo=sessao&voltar=%2Fsales%2Fhistory&erro=limite")
    ).toEqual({
      error: "limite",
      reason: "sessao",
      returnTo: "/sales/history",
    });
  });

  it.each([
    ["motivo", "?motivo=admin"],
    ["motivo", "?motivo=%3Cb%3E"],
    ["erro", "?erro=oauth"],
    ["erro", "?erro="],
  ])("ignores an unknown %s (%s)", (_name, search) => {
    expect(parseSignInSearch(search)).toEqual({});
  });

  it.each([
    "?voltar=//evil.example",
    "?voltar=%2F%2Fevil.example",
    "?voltar=https%3A%2F%2Fevil.example",
    "?voltar=javascript%3Aalert(1)",
    "?voltar=%2Fentrar",
    "?voltar=",
  ])("drops an invalid destination (%s)", (search) => {
    expect(parseSignInSearch(search).returnTo).toBeUndefined();
  });

  it("accepts the three errors", () => {
    for (const error of ["google", "indisponivel", "limite"]) {
      expect(parseSignInSearch(`?erro=${error}`).error).toBe(error);
    }
  });
});
