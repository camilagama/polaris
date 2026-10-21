import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { headersForPath, parseHeadersFile } from "./static-headers.mjs";

const SHELL_POLICY =
  /^default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';/;
const shipped = parseHeadersFile(
  readFileSync(new URL("../public/_headers", import.meta.url), "utf8")
);
const cspOf = (path: string) =>
  headersForPath(shipped, path)["content-security-policy"];

describe("the _headers of the shell, as the static server of the browser checks applies them", () => {
  it("every page of the app gets the policy of /*", () => {
    for (const path of [
      "/",
      "/ui-galeria",
      "/sales/new",
      "/assets/index-abc.js",
    ]) {
      expect(cspOf(path)).toMatch(SHELL_POLICY);
    }
  });

  it("the sign-in pages swap it for the one with the challenge, with and without the final slash", () => {
    for (const path of ["/entrar", "/entrar/", "/criar-conta"]) {
      const policy = cspOf(path);
      expect(policy).toContain("frame-src https://challenges.cloudflare.com");
      expect(policy).not.toContain(", default-src");
    }
  });

  it("joins repeated headers, keeps the other ones and detaches with !", () => {
    const rules = parseHeadersFile(
      "# comment\n/*\n  X-A: 1\n  X-B: 2\n/x\n  ! X-A\n  X-B: 3\n/x*\n  X-C: 4\n"
    );
    expect(headersForPath(rules, "/y")).toEqual({ "x-a": "1", "x-b": "2" });
    expect(headersForPath(rules, "/x")).toEqual({ "x-b": "2, 3", "x-c": "4" });
    expect(headersForPath(rules, "/x.y")).toEqual({
      "x-a": "1",
      "x-b": "2",
      "x-c": "4",
    });
  });
});
