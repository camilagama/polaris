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

/**
 * The Workers tests that need PostgreSQL run through a gate, from a root config of their own (the `database` job).
 * Where each app keeps them and which gate runs them.
 */
const DATABASE_APPS = {
  admin: {
    directory: "src",
    gate: { name: "admin-worker", script: "verify-admin-worker-gate.ts" },
    rootConfig: "vitest.admin-worker.config.ts",
  },
  catalog: {
    directory: "src",
    gate: { name: "catalog-worker", script: "verify-catalog-worker-gate.ts" },
    rootConfig: "vitest.catalog-worker.config.ts",
  },
  web: {
    directory: "worker",
    gate: { name: "web-worker", script: "verify-web-worker-gate.ts" },
    rootConfig: "vitest.web-worker.config.ts",
  },
};

/** Every `*.workerd.test.ts` and `*.workerd-db.test.ts` under apps/<app>/src (the Web Worker's are under apps/web/worker). */
function workerdTests() {
  const found = [];
  for (const app of readdirSync(join(root, "apps"), { withFileTypes: true })) {
    if (!app.isDirectory()) {
      continue;
    }
    for (const directory of ["src", "worker"]) {
      const base = join(root, "apps", app.name, directory);
      let entries = [];
      try {
        entries = readdirSync(base, { recursive: true });
      } catch {
        // an app without that directory
      }
      for (const entry of entries) {
        const file = String(entry);
        if (file.endsWith(".workerd.test.ts")) {
          found.push({ app: app.name, database: false, directory, file });
        } else if (file.endsWith(".workerd-db.test.ts")) {
          found.push({ app: app.name, database: true, directory, file });
        }
      }
    }
  }
  return found;
}

// The Node project excludes the Workers tests and a project that matches no
// file passes silently, so a mistyped include would leave the test running nowhere.
// The ones without a database run in the root config (`bun run test`); the ones with a
// database run through their gate, from their own root config (the `database` job).
describe("workerd harness discovery", () => {
  const tests = workerdTests();
  const rootConfig = readFileSync(join(root, "vitest.config.ts"), "utf8");
  const gates = readFileSync(
    join(root, "packages/db/scripts/run-gates.ts"),
    "utf8"
  );

  it("finds the tests of the three Workers", () => {
    expect(new Set(tests.map(({ app }) => app))).toEqual(
      new Set(["admin", "catalog", "web"])
    );
    expect(tests.some(({ database }) => database)).toBe(true);
    expect(tests.some(({ database }) => !database)).toBe(true);
  });

  it.each(tests)(
    "runs $app/$directory/$file in a workers project",
    ({ app, database, directory }) => {
      if (database) {
        const setup = DATABASE_APPS[app];
        expect(
          setup,
          `${app} has a gate for its tests with a database`
        ).toBeDefined();
        expect(directory).toBe(setup.directory);
        const configPath = `apps/${app}/vitest.workers-db.config.ts`;
        expect(readFileSync(join(root, setup.rootConfig), "utf8")).toContain(
          `"${configPath}"`
        );
        expect(rootConfig).not.toContain(configPath);
        expect(readFileSync(join(root, configPath), "utf8")).toContain(
          `"${setup.directory}/**/*.workerd-db.test.ts"`
        );
        // and a gate runs that config, in the suite of the `database` job
        expect(gates).toContain(setup.gate.script);
        expect(gates).toMatch(new RegExp(`ci: \\[[^\\]]*"${setup.gate.name}"`));
        expect(
          readFileSync(
            join(root, "packages/db/scripts", setup.gate.script),
            "utf8"
          )
        ).toContain(setup.rootConfig);
        return;
      }
      const configPath = `apps/${app}/vitest.workers.config.ts`;
      expect(rootConfig).toContain(`"${configPath}"`);
      const projectConfig = readFileSync(join(root, configPath), "utf8");
      expect(projectConfig).toContain('"src/**/*.workerd.test.ts"');
    }
  );

  it("points every Workers project's Hyperdrive through the host guard", () => {
    for (const { app } of tests) {
      const files = readdirSync(join(root, "apps", app)).filter((name) =>
        name.startsWith("vitest.workers")
      );
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const text = readFileSync(join(root, "apps", app, file), "utf8");
        if (text.includes("hyperdrives")) {
          expect(text, file).toContain("harnessHyperdrives(");
        }
      }
    }
  });

  it("keeps the database projects out of `bun run test` and the node project away from both", () => {
    expect(rootConfig).not.toContain("workers-db");
    expect(rootConfig).toContain('"**/*.workerd.test.ts"');
    expect(rootConfig).toContain('"**/*.workerd-db.test.ts"');
  });
});
