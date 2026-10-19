import { describe, expect, it } from "vitest";
import { isSafeAuthCallbackPath, parseReturnPath } from "./return-path";

describe("parseReturnPath", () => {
  it.each([
    "/",
    "/sales",
    "/sales/history?x=1",
    "/inventory?q=caf%C3%A9",
    "/a%2Fb",
    "/apis",
    "/rpcs",
    "/healthy",
    "/ready-to-go",
  ])("accepts %s", (value) => {
    expect(parseReturnPath(value)).toBe(value);
  });

  it.each([
    ["an empty value", ""],
    ["a missing value", undefined],
    ["a value that is not text", 42],
    ["another host", "https://evil.example"],
    ["a protocol-relative host", "//evil.example"],
    ["an encoded protocol-relative host", "%2F%2Fevil.example"],
    ["an encoded protocol-relative host after a slash", "/%2F%2Fevil.example"],
    ["a doubly encoded protocol-relative host", "/%252F%252Fevil.example"],
    ["a backslash host", "/\\evil.example"],
    ["an encoded backslash host", "/%5Cevil.example"],
    ["a scheme", "javascript:alert(1)"],
    ["a relative path", "sales"],
    ["user info before the host", "@evil.example/x"],
    ["a line break", "/sales\r\nSet-Cookie:x=1"],
    ["an encoded line break", "/sales%0d%0aSet-Cookie:x=1"],
    ["a doubly encoded line break", "/sales%250d%250a"],
    ["a null byte", "/sales%00"],
    ["a C1 control", "/sales%C2%85"],
    ["a line separator", "/sales%E2%80%A8"],
    ["a tab", "/sa\tles"],
    ["the API", "/api"],
    ["the API with a path", "/api/auth/sign-out"],
    ["the API in capitals", "/API/auth/sign-out"],
    ["the API encoded", "/%61pi/auth/sign-out"],
    ["the API behind dot segments", "/sales/../api/auth/sign-out"],
    ["the API behind encoded dot segments", "/sales/%2e%2e/api/x"],
    ["a dot segment hidden behind an encoded slash", "/a/..%2fapi/x"],
    ["a dot segment that turns the path protocol-relative", "/.//evil.example"],
    [
      "a parent segment that turns the path protocol-relative",
      "/x/..//evil.example",
    ],
    [
      "an encoded dot segment that turns the path protocol-relative",
      "/%2e%2e//evil.example",
    ],
    ["RPC", "/rpc/sales/list"],
    ["RPC behind dot segments", "/./rpc/x"],
    ["the health check of the Worker", "/health"],
    ["the readiness check of the Worker", "/ready"],
    ["the billing webhooks", "/webhooks/billing/asaas"],
    ["the sign-in page", "/entrar"],
    ["the sign-in page with a query", "/entrar?voltar=%2Fsales"],
    ["a malformed escape", "/sales%E0%A4%A"],
    ["a text over 200 characters", `/${"a".repeat(200)}`],
  ])("refuses %s", (_reason, value) => {
    expect(parseReturnPath(value)).toBeUndefined();
  });

  it("accepts exactly 200 characters", () => {
    const value = `/${"a".repeat(199)}`;
    expect(parseReturnPath(value)).toBe(value);
  });
});

describe("isSafeAuthCallbackPath", () => {
  it("accepts the sign-in page carrying the longest valid destination, totally encoded", () => {
    const destination = `/${"é".repeat(100)}?x=1`;
    const value = `/entrar?voltar=${encodeURIComponent(destination)}`;

    expect(
      parseReturnPath(decodeURIComponent(encodeURIComponent(destination)))
    ).toBeDefined();
    expect(isSafeAuthCallbackPath(value)).toBe(true);
  });

  it("refuses a destination over 200 characters even inside the sign-in page", () => {
    const destination = `/${"a".repeat(200)}`;

    expect(
      isSafeAuthCallbackPath(
        `/entrar?voltar=${encodeURIComponent(destination)}`
      )
    ).toBe(false);
  });

  it.each([
    "/",
    "/sales",
    "/settings/account?link=failed",
    "/entrar?erro=google",
    "/entrar?erro=limite",
    "/entrar?voltar=%2Fsales%2Fhistory%3Fx%3D1",
    "/entrar?voltar=%2Fcaf%C3%A9",
  ])("accepts %s", (value) => {
    expect(isSafeAuthCallbackPath(value)).toBe(true);
  });

  it.each([
    ["another host", "https://evil.example"],
    ["a same-origin absolute URL", "http://localhost/sales"],
    ["a protocol-relative host", "//evil.example"],
    ["a backslash", "/\\evil.example"],
    ["an encoded protocol-relative path", "/%2F%2Fevil.example"],
    ["a scheme", "javascript:alert(1)"],
    ["a fragment", "/sales#frag"],
    ["a parenthesis the library refuses", "/vendas(x)"],
    ["a parenthesis in the query", "/entrar?voltar=/vendas(x)"],
    ["a control character", "/sales%0d%0a"],
    ["the API", "/api/auth/sign-out"],
    ["RPC", "/rpc/sales/list"],
    ["a destination on another host", "/entrar?voltar=%2F%2Fevil.example"],
    [
      "a destination with a scheme",
      "/entrar?voltar=https%3A%2F%2Fevil.example",
    ],
    [
      "a destination with a control character",
      "/entrar?voltar=%2Fsales%250d%250a",
    ],
    ["a destination in the API", "/entrar?voltar=%2Fapi%2Fx"],
    ["a destination in RPC", "/entrar?voltar=%2Frpc%2Fx"],
    [
      "a destination with a dot segment hidden behind an encoded slash",
      "/entrar?voltar=%2Fa%2F..%252fapi",
    ],
    [
      "a destination that turns protocol-relative",
      "/entrar?voltar=%2F.%2F%2Fevil.example",
    ],
    ["a path that turns protocol-relative", "/.//evil.example"],
    ["the sign-in page as the destination", "/entrar?voltar=%2Fentrar"],
    [
      "one bad destination among good ones",
      "/entrar?voltar=%2Fsales&voltar=%2F%2Fevil",
    ],
    ["a value that is not text", { path: "/sales" }],
  ])("refuses %s", (_reason, value) => {
    expect(isSafeAuthCallbackPath(value)).toBe(false);
  });
});
