import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MAIN = /"main":\s*"([^"]+)"/;
const root = new URL("../../", import.meta.url);

describe("the server entry of the public catalog", () => {
  it("is the Worker's main, so the nonce and the security headers reach every page", () => {
    const wrangler = readFileSync(new URL("wrangler.jsonc", root), "utf8");
    const main = MAIN.exec(wrangler)?.[1];

    // the package's own entry (@tanstack/react-start/server-entry) would skip src/server.ts
    expect(main).toBe("./src/server.ts");
    expect(existsSync(new URL(main ?? "", root))).toBe(true);
    const entry = readFileSync(new URL("src/server.ts", root), "utf8");
    expect(entry).toContain("secureResponse");
    expect(entry).toContain("requestWithNonce");
  });
});
