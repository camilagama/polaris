import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WorkerBindings } from "../environment";

/**
 * The three advisories left out of the dependency audit (docs/runbooks/dependency-audit.md) need a Better Auth plugin
 * that production never loads. This test is what keeps that true: it fails when the `createAuth` of production
 * receives any plugin. The `testUtils` of the tests does not count: they build their own instance.
 */
const EXPLANATION =
  "Production passes a Better Auth plugin to createAuth. The dependency audit leaves out GHSA-965c-763c-88jm (critical), " +
  "GHSA-r4xp-prcw-77qf and GHSA-q84f-53jg-9ppm only because no plugin is loaded in production. Magic Link by e-mail " +
  "would make the critical GHSA-965c-763c-88jm exploitable on better-auth 1.6.23 (OAuth state used as a Magic Link). " +
  "Upgrade better-auth (1.7.7 or newer) and remove the exception in docs/runbooks/dependency-audit.md before adding a plugin, " +
  "and ask for the security review.";

const SOURCE_FILE = /\.tsx?$/;
const TEST_FILE = /\.test\.tsx?$|-test-support\.tsx?$/;
const PLUGIN_USE =
  /["']better-auth\/plugins["']|["']@better-auth\/[^"']*["']|\bplugins\s*:/;

const captured = vi.hoisted(() => ({
  options: [] as { plugins?: unknown }[],
}));

vi.mock("better-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("better-auth")>()),
  betterAuth: (options: { plugins?: unknown }) => {
    captured.options.push(options);
    return {
      $context: Promise.resolve({}),
      api: { getSession: () => Promise.resolve(null) },
      handler: () => Promise.resolve(Response.json(null)),
    };
  },
}));

vi.mock("@polaris/db/client", () => ({
  createDatabase: () => ({
    db: {},
    pool: { end: () => Promise.resolve() },
  }),
}));

const { handleBetterAuthRequest } = await import("./handler");
const { createAuthenticatedRequestContext } = await import(
  "../authenticated-request-context"
);

const bindings: WorkerBindings = {
  AUTH_HYPERDRIVE: { connectionString: "postgresql://auth.invalid/neondb" },
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "p".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://tenant.invalid/neondb" },
};

function hasPlugins(options: { plugins?: unknown }) {
  return Array.isArray(options.plugins)
    ? options.plugins.length > 0
    : options.plugins !== undefined;
}

describe("no Better Auth plugin runs in production", () => {
  it("the /api/auth/* handler builds Better Auth without plugins", async () => {
    captured.options.length = 0;

    await handleBetterAuthRequest(
      new Request("https://polaris.example.invalid/api/auth/get-session"),
      bindings,
      "no-plugins",
      vi.fn()
    );

    expect(captured.options.length, "the handler built no instance").toBe(1);
    expect(captured.options.some(hasPlugins), EXPLANATION).toBe(false);
  });

  it("the session read of the request context builds Better Auth without plugins", async () => {
    captured.options.length = 0;
    const context = createAuthenticatedRequestContext({
      createDatabase: (() => ({
        db: {},
        pool: { end: () => Promise.resolve() },
      })) as never,
    });

    await context({
      bindings: { ...bindings, BETTER_AUTH_SECRET: "q".repeat(32) },
      operation: () => Promise.resolve(null),
      request: new Request("https://polaris.example.invalid/rpc/x"),
    }).catch(() => undefined);

    expect(
      captured.options.length,
      "the request context built no instance"
    ).toBeGreaterThan(0);
    expect(captured.options.some(hasPlugins), EXPLANATION).toBe(false);
  });

  it("no production file hands Better Auth a plugin", () => {
    const root = join(import.meta.dirname, "..", "..");
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (
          SOURCE_FILE.test(entry.name) &&
          !TEST_FILE.test(entry.name) &&
          PLUGIN_USE.test(readFileSync(path, "utf8"))
        ) {
          offenders.push(relative(root, path));
        }
      }
    };
    walk(root);

    expect(offenders, EXPLANATION).toEqual([]);
  });
});
