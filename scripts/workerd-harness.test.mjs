import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertAllowedHyperdriveHost,
  CLOSED_PORT,
  closedHyperdriveConnectionString,
  harnessHyperdrives,
} from "./workerd-harness.mjs";

const REFUSED = /Workers harness/;
const ci = { CI: "true" };
const notCi = {};
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("workerd harness host guard", () => {
  it("accepts the closed loopback port anywhere, and nothing else off CI", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const url = `postgresql://u:p@${host}:${CLOSED_PORT}/db`;
      expect(assertAllowedHyperdriveHost(url, { environment: notCi })).toBe(
        url
      );
      expect(() =>
        assertAllowedHyperdriveHost(`postgresql://u:p@${host}:5432/db`, {
          environment: notCi,
        })
      ).toThrow(REFUSED);
      expect(() =>
        assertAllowedHyperdriveHost(`postgresql://u:p@${host}/db`, {
          environment: notCi,
        })
      ).toThrow(REFUSED);
    }
    expect(
      assertAllowedHyperdriveHost(closedHyperdriveConnectionString, {
        environment: notCi,
      })
    ).toBe(closedHyperdriveConnectionString);
  });

  it("accepts any loopback port with CI=true", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const url = `postgresql://u:p@${host}:5432/db`;
      expect(assertAllowedHyperdriveHost(url, { environment: ci })).toBe(url);
    }
  });

  it.each([
    "postgresql://u:p@ep-cool-name-123456.sa-east-1.aws.neon.tech/db",
    "postgresql://u:p@ep-x-123-pooler.sa-east-1.aws.neon.tech/db",
    "postgresql://u:p@10.0.0.5:5432/db",
    "postgresql://u:p@127.0.0.1.evil.example/db",
    "postgresql://u:p@localhost.evil.example/db",
    "postgresql://127.0.0.1@evil.example/db",
    "postgresql://u:p@127.0.0.1:1/db?host=db.example.com",
    "postgresql://u:p@127.0.0.1:1/db?%68ost=db.example.com",
    "postgresql://u:p@127.0.0.1:1/db?hostaddr=10.0.0.5",
    "postgresql://u:p@127.0.0.1:1/db?service=prod",
    "https://127.0.0.1:1/db",
    "not a url",
  ])("refuses %s even with CI=true", (connectionString) => {
    expect(() =>
      assertAllowedHyperdriveHost(connectionString, {
        environment: ci,
        serviceHosts: ["postgres"],
      })
    ).toThrow(REFUSED);
  });

  it("accepts the service host of the database job only with CI=true", () => {
    const url = "postgresql://u:p@postgres:5432/polaris_gate";
    expect(() =>
      assertAllowedHyperdriveHost(url, {
        environment: notCi,
        serviceHosts: ["postgres"],
      })
    ).toThrow(REFUSED);
    expect(
      assertAllowedHyperdriveHost(url, {
        environment: ci,
        serviceHosts: ["postgres"],
      })
    ).toBe(url);
    expect(() => assertAllowedHyperdriveHost(url, { environment: ci })).toThrow(
      REFUSED
    );
  });

  it("checks every connection of a project", () => {
    expect(
      harnessHyperdrives(
        { ADMIN_HYPERDRIVE: closedHyperdriveConnectionString },
        { environment: notCi }
      )
    ).toEqual({ ADMIN_HYPERDRIVE: closedHyperdriveConnectionString });
    expect(() =>
      harnessHyperdrives(
        {
          ADMIN_HYPERDRIVE: closedHyperdriveConnectionString,
          OTHER: "postgresql://u:p@db.example.com/db",
        },
        { environment: ci }
      )
    ).toThrow(REFUSED);
  });
});

/** Every `*.workerd.test.ts` under apps/<app>/src. */
function workerdTests() {
  const found = [];
  for (const app of readdirSync(join(root, "apps"), { withFileTypes: true })) {
    if (!app.isDirectory()) {
      continue;
    }
    const src = join(root, "apps", app.name, "src");
    let entries = [];
    try {
      entries = readdirSync(src, { recursive: true });
    } catch {
      // an app without src
    }
    for (const entry of entries) {
      if (String(entry).endsWith(".workerd.test.ts")) {
        found.push({ app: app.name, file: String(entry) });
      }
    }
  }
  return found;
}

// The Node project excludes `*.workerd.test.ts` and a project that matches no
// file passes silently, so a mistyped include would leave the test running nowhere.
describe("workerd harness discovery", () => {
  const tests = workerdTests();
  const rootConfig = readFileSync(join(root, "vitest.config.ts"), "utf8");

  it("finds the Admin test", () => {
    expect(tests.map(({ app }) => app)).toContain("admin");
  });

  it.each(tests)(
    "runs $app/src/$file in a workers project of the root config",
    ({ app }) => {
      const configPath = `apps/${app}/vitest.workers.config.ts`;
      expect(rootConfig).toContain(`"${configPath}"`);
      const projectConfig = readFileSync(join(root, configPath), "utf8");
      expect(projectConfig).toContain('"src/**/*.workerd.test.ts"');
    }
  );
});
