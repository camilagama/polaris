import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderStaticHeadersFile } from "@polaris/http-security";
import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";
import { appShellHeadersPlugin, sentryBuildSettings } from "./sentry-build";

const staticHeadersFile = readFileSync(
  fileURLToPath(new URL("../public/_headers", import.meta.url)),
  "utf8"
);

/** Made-up values: the key is invented and the project does not exist. */
const FAKE_DSN = "https://chavefalsa@o1.ingest.sentry.io/1";
const INGEST = "https://o1.ingest.sentry.io";
const SHA = "9b3d37ed5c223fba78109e32e9196bb294b35358";

const POLICY_LINE = /Content-Security-Policy: (.*)/;

function directives(file: string): Map<string, string[]> {
  const policy = POLICY_LINE.exec(file)?.[1] ?? "";
  return new Map(
    policy
      .split(";")
      .map((part) => part.trim().split(" "))
      .map(([name = "", ...values]) => [name, values])
  );
}

function outputWith(headers: string): string {
  const directory = mkdtempSync(join(tmpdir(), "polaris-headers-"));
  writeFileSync(join(directory, "_headers"), headers);
  return directory;
}

function runWriteBundle(
  plugin: Plugin,
  environment: string,
  dir: string
): void {
  const hook = plugin.writeBundle as { handler: (...args: never[]) => void };
  hook.handler.call(
    { environment: { name: environment } } as never,
    {
      dir,
    } as never
  );
}

describe("the build settings of the browser Sentry", () => {
  it("do nothing without a DSN: the output is the one of a build that never heard of Sentry", () => {
    for (const env of [
      {},
      { VITE_SENTRY_DSN: "" },
      { VITE_SENTRY_DSN: "lixo" },
    ]) {
      expect(sentryBuildSettings(env, { GITHUB_SHA: SHA })).toEqual({
        connectSources: [],
        define: {},
      });
    }
  });

  it("open the ingest origin of the DSN and nothing else, and stamp the commit SHA", () => {
    expect(
      sentryBuildSettings(
        { VITE_SENTRY_DSN: FAKE_DSN, VITE_SENTRY_ENVIRONMENT: "staging" },
        { GITHUB_SHA: SHA }
      )
    ).toEqual({
      connectSources: [INGEST],
      define: { "import.meta.env.VITE_SENTRY_RELEASE": JSON.stringify(SHA) },
    });
  });

  it("stay off for a DSN without a valid environment, so the CSP never opens for an SDK that stays off", () => {
    for (const VITE_SENTRY_ENVIRONMENT of [undefined, "", "qa"]) {
      expect(
        sentryBuildSettings(
          { VITE_SENTRY_DSN: FAKE_DSN, VITE_SENTRY_ENVIRONMENT },
          { GITHUB_SHA: SHA }
        )
      ).toEqual({ connectSources: [], define: {} });
    }
  });

  it("keep a release that the environment already says", () => {
    expect(
      sentryBuildSettings(
        {
          VITE_SENTRY_DSN: FAKE_DSN,
          VITE_SENTRY_ENVIRONMENT: "production",
          VITE_SENTRY_RELEASE: "abc1234",
        },
        { GITHUB_SHA: SHA }
      ).define
    ).toEqual({ "import.meta.env.VITE_SENTRY_RELEASE": '"abc1234"' });
  });

  it("refuse a DSN host that is not Sentry's, so the CSP never opens a foreign origin", () => {
    expect(
      sentryBuildSettings({
        VITE_SENTRY_DSN: "https://k@example.com/1",
        VITE_SENTRY_ENVIRONMENT: "production",
      }).connectSources
    ).toEqual([]);
  });
});

describe("the CSP of the app shell with the reporter on", () => {
  const withSentry = renderStaticHeadersFile({ connectSources: [INGEST] });

  it("adds the ingest origin to connect-src and changes no other directive", () => {
    const base = directives(staticHeadersFile);
    const on = directives(withSentry);

    expect(on.get("connect-src")).toEqual(["'self'", "data:", INGEST]);
    for (const [name, values] of base) {
      if (name !== "connect-src") {
        expect(on.get(name), name).toEqual(values);
      }
    }
    expect([...on.keys()]).toEqual([...base.keys()]);
  });

  it("keeps the committed baseline free of any origin", () => {
    expect(staticHeadersFile).not.toContain("sentry");
  });

  it("is what the plugin writes into the output of the browser build", () => {
    const directory = outputWith(staticHeadersFile);

    runWriteBundle(appShellHeadersPlugin([INGEST]), "client", directory);

    expect(readFileSync(join(directory, "_headers"), "utf8")).toBe(withSentry);
  });

  it("leaves the output alone without an origin or outside the browser build", () => {
    const directory = outputWith(staticHeadersFile);

    runWriteBundle(appShellHeadersPlugin([INGEST]), "ssr", directory);
    runWriteBundle(appShellHeadersPlugin([]), "client", directory);

    expect(readFileSync(join(directory, "_headers"), "utf8")).toBe(
      staticHeadersFile
    );
  });
});
