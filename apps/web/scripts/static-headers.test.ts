import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { headersForPath, parseHeadersFile } from "./static-headers.mjs";

const SHELL_POLICY =
  /^default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';/;
const shipped = parseHeadersFile(
  readFileSync(new URL("../public/_headers", import.meta.url), "utf8")
);
const TURNSTILE_SCRIPT =
  /"(https:\/\/challenges\.cloudflare\.com\/[^"]+api\.js[^"]*)"/;
const WHITESPACE = /\s+/;
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

  it("lets the staging page load the Turnstile script and open its frame, on every page with the challenge", () => {
    // The URL the app really loads (src/sign-in/turnstile.ts); the frame the script opens is on the same origin.
    const loader = readFileSync(
      new URL("../src/sign-in/turnstile.ts", import.meta.url),
      "utf8"
    );
    const scriptUrl = new URL(loader.match(TURNSTILE_SCRIPT)?.[1] ?? "");
    const frameUrl = new URL("https://challenges.cloudflare.com");
    const pages = [
      "/entrar",
      "/criar-conta",
      "/esqueci-a-senha",
      "/redefinir-senha",
      "/confirmar-email",
    ];
    for (const page of pages) {
      for (const path of [page, `${page}/`]) {
        const directives = Object.fromEntries(
          String(cspOf(path))
            .split(";")
            .map((directive) => directive.trim().split(WHITESPACE))
            .map(([name, ...sources]) => [name, sources])
        ) as Record<string, string[]>;
        // CSP ignores the query of the URL: a source with a path allows exactly that path, `?render=explicit` included.
        expect(directives["script-src"], path).toContain(
          scriptUrl.origin + scriptUrl.pathname
        );
        expect(directives["frame-src"], path).toEqual([frameUrl.origin]);
        expect(directives["connect-src"], path).not.toContain(frameUrl.origin);
      }
    }
    // The unlock page shows no challenge and keeps the policy of the shell.
    expect(cspOf("/desbloquear")).toMatch(SHELL_POLICY);
    expect(cspOf("/desbloquear")).not.toContain("challenges.cloudflare.com");
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
