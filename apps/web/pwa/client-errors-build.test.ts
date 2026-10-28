import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clientErrorsBuildDefine } from "./client-errors-build";

const KEY = "import.meta.env.VITE_RELEASE";
const CI_SHA = "9b3d37ed5c223fba78109e32e9196bb294b35358";
const ON = "true";
const CONNECT_SRC = /connect-src ([^;]*)/g;

describe("the build side of the reports of the browser", () => {
  it("defines nothing without the flag, whatever else the environment says", () => {
    const processEnv = { GITHUB_SHA: CI_SHA };
    expect(clientErrorsBuildDefine({}, processEnv)).toEqual({});
    expect(
      clientErrorsBuildDefine({ VITE_RELEASE: "abcdef1" }, processEnv)
    ).toEqual({});
    for (const flag of ["false", "1", "TRUE", ""]) {
      expect(
        clientErrorsBuildDefine(
          { VITE_CLIENT_ERRORS_ENABLED: flag },
          processEnv
        ),
        flag
      ).toEqual({});
    }
  });

  it("stamps the first 12 characters of the SHA of the CI run with the flag", () => {
    expect(
      clientErrorsBuildDefine(
        { VITE_CLIENT_ERRORS_ENABLED: ON },
        { GITHUB_SHA: CI_SHA }
      )
    ).toEqual({ [KEY]: JSON.stringify("9b3d37ed5c22") });
  });

  it("lets the release of the environment win, cut to 12 and in lowercase", () => {
    expect(
      clientErrorsBuildDefine(
        {
          VITE_CLIENT_ERRORS_ENABLED: ON,
          VITE_RELEASE: " ABCDEF0123456789 ",
        },
        { GITHUB_SHA: CI_SHA }
      )
    ).toEqual({ [KEY]: JSON.stringify("abcdef012345") });
  });

  it("falls back to the SHA when the release of the environment is blank", () => {
    expect(
      clientErrorsBuildDefine(
        { VITE_CLIENT_ERRORS_ENABLED: ON, VITE_RELEASE: "   " },
        { GITHUB_SHA: CI_SHA.toUpperCase() }
      )
    ).toEqual({ [KEY]: JSON.stringify("9b3d37ed5c22") });
  });
});

describe("the CSP of the app shell", () => {
  const headers = readFileSync(
    fileURLToPath(new URL("../public/_headers", import.meta.url)),
    "utf8"
  );

  it("keeps connect-src at 'self' and data: in every policy, so the report opens no origin (the exact policy is pinned by packages/http-security)", () => {
    const policies = [...headers.matchAll(CONNECT_SRC)].map((match) =>
      (match[1] ?? "").trim()
    );
    expect(policies.length).toBeGreaterThan(0);
    for (const policy of policies) {
      expect(policy).toBe("'self' data:");
    }
  });

  it("does not name the route of the reports, which is of the same origin and needs no entry", () => {
    expect(headers).not.toContain("client-errors");
  });
});
