/** Redirect targets the app must refuse, by the reason it refuses them (AC-39 and AC-40). */
export const hostileRedirectTargets: readonly [string, string][] = [
  ["an external host", "https://evil.example"],
  ["an external host without a scheme (protocol-relative)", "//evil.example"],
  ["a backslash that browsers read as a slash", "/\\evil.example"],
  ["an encoded protocol-relative path", "/%2F%2Fevil.example"],
  ["the javascript scheme", "javascript:alert(1)"],
  ["a scheme in a same-origin absolute URL", "http://localhost/sales"],
  [
    "the characters that encodeURIComponent leaves and Better Auth refuses (the '(x)' case)",
    "/vendas(x)",
  ],
  ["a control character in the path", "/vendas%0d%0aSet-Cookie:x=1"],
  ["a raw line break in the path", "/vendas\r\nSet-Cookie:x=1"],
  ["a dot segment that turns the path protocol-relative", "/.//evil.example"],
  [
    "a parent segment that turns the path protocol-relative",
    "/x/..//evil.example",
  ],
  ["the API", "/api/auth/sign-out"],
  ["the API with dot segments", "/sales/../api/auth/sign-out"],
  ["RPC", "/rpc/sales/list"],
  [
    "an external host in the destination (voltar)",
    "/entrar?voltar=%2F%2Fevil.example",
  ],
  [
    "a scheme in the destination (voltar)",
    "/entrar?voltar=https%3A%2F%2Fevil.example",
  ],
  [
    "a control character in the destination (voltar)",
    "/entrar?voltar=%2Fsales%250d%250a",
  ],
  [
    "the API in the destination (voltar)",
    "/entrar?voltar=%2Fapi%2Fauth%2Fsign-out",
  ],
  ["RPC in the destination (voltar)", "/entrar?voltar=%2Frpc%2Fsales"],
  [
    "a dot segment hidden behind an encoded slash in the destination (voltar)",
    "/entrar?voltar=%2Fa%2F..%252fapi",
  ],
  [
    "a dot segment that turns the destination protocol-relative (voltar)",
    "/entrar?voltar=%2F.%2F%2Fevil.example",
  ],
  ["the sign-in page as the destination (voltar)", "/entrar?voltar=%2Fentrar"],
];

/** The destination the sign-in page carries, totally encoded, that must be accepted. */
export const validReturnCallbackURL =
  "/entrar?voltar=%2Fsales%2Fhistory%3Fx%3D1";
