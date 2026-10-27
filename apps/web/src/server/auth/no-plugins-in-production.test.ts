import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { WorkerBindings } from "../environment";

/**
 * No Better Auth plugin in production without a security review first. The three advisories of better-auth 1.6.23
 * (GHSA-965c-763c-88jm, GHSA-r4xp-prcw-77qf, GHSA-q84f-53jg-9ppm) were each in a plugin (Magic Link, OAuth Proxy,
 * device authorization) and are fixed since the upgrade to 1.7 (t435); this test stays as the line every plugin crosses
 * (docs/runbooks/dependency-audit.md): it fails when the `createBetterAuth` of production receives any plugin. The
 * `testUtils` of the tests does not count: they build their own instance.
 */
const EXPLANATION =
  "Production passes a Better Auth plugin to createAuth. Every plugin is new attack surface: the three advisories of " +
  "better-auth 1.6.23 (GHSA-965c-763c-88jm critical, GHSA-r4xp-prcw-77qf, GHSA-q84f-53jg-9ppm) were all in plugins " +
  "(Magic Link, OAuth Proxy, device authorization). Ask for the security review, then update this test and " +
  "docs/runbooks/dependency-audit.md in the same pull request.";

const SOURCE_FILE = /\.tsx?$/;
const TEST_FILE = /\.test\.tsx?$|-test-support\.tsx?$/;
// a plugin import, or a `plugins` key or shorthand handed to something (the type of the option is `plugins?:`)
const PLUGIN_USE =
  /["']better-auth\/plugins(?:\/[^"']*)?["']|["']@better-auth\/(?!core)[^"']*["']|\bplugins\s*:|\{\s*plugins\s*[,}]/;

/**
 * The one line of `server/auth.ts` that forwards the `plugins` option to Better Auth; what it receives is what the
 * runtime tests watch. It is the only thing the scan lets through there: a plugin import in the same file still fails.
 */
const FORWARDS_PLUGINS_FILE = "server/auth.ts";
const FORWARDS_PLUGINS_LINE = "...(plugins ? { plugins } : {}),";

// every non-test file under src that mentions the builders (a definition, a call or an import); the text scan only
// sees src, and the runtime tests above are what watch what is really passed
const BUILDS_BETTER_AUTH = /\b(?:createBetterAuth|betterAuth)\b/;
const BUILDERS = [
  "server/auth.ts",
  "server/auth/handler.ts",
  "server/authenticated-request-context.ts",
];
const BUILDER_EXPLANATION =
  "A new file builds a Better Auth instance. Add it to the tests above that run it (so they see its plugins) " +
  "and to BUILDERS in this file.";

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

/** Each branch of the handler that adds options (Google, e-mail and password) is a place a plugin could hide. */
const configurations: [string, WorkerBindings][] = [
  ["without Google and without e-mail", bindings],
  [
    "with Google and with e-mail and password",
    {
      ...bindings,
      AUTH_EMAIL_FROM: "Polaris <no-reply@example.invalid>",
      BETTER_AUTH_SECRET: "g".repeat(32),
      EMAIL_PASSWORD_AUTH_ENABLED: "true",
      GOOGLE_CLIENT_ID: "client-id.invalid",
      GOOGLE_CLIENT_SECRET: "client-secret",
      RESEND_API_KEY: "re_invalid",
    },
  ],
];

function hasPlugins(options: { plugins?: unknown }) {
  return Array.isArray(options.plugins)
    ? options.plugins.length > 0
    : options.plugins !== undefined;
}

describe("no Better Auth plugin runs in production", () => {
  it.each(configurations)(
    "the /api/auth/* handler builds Better Auth without plugins, %s",
    async (_name, withBindings) => {
      captured.options.length = 0;

      await handleBetterAuthRequest(
        new Request("https://polaris.example.invalid/api/auth/get-session"),
        withBindings,
        "no-plugins",
        vi.fn()
      );

      expect(captured.options.length, "the handler built no instance").toBe(1);
      expect(captured.options.some(hasPlugins), EXPLANATION).toBe(false);
    }
  );

  it("the session read of the request context builds Better Auth without plugins", async () => {
    captured.options.length = 0;
    const context = createAuthenticatedRequestContext({
      createDatabase: (() => ({
        db: {},
        pool: { end: () => Promise.resolve() },
      })) as never,
    });

    await context({
      bindings,
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
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const offenders: string[] = [];
    const scanned: string[] = [];
    const builders: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (
          SOURCE_FILE.test(entry.name) &&
          !TEST_FILE.test(entry.name)
        ) {
          const name = relative(root, path);
          const source = readFileSync(path, "utf8");
          scanned.push(name);
          if (BUILDS_BETTER_AUTH.test(source)) {
            builders.push(name);
          }
          const inspected =
            name === FORWARDS_PLUGINS_FILE
              ? source.replace(FORWARDS_PLUGINS_LINE, "")
              : source;
          if (PLUGIN_USE.test(inspected)) {
            offenders.push(name);
          }
        }
      }
    };
    walk(root);

    // a scan that read nothing proves nothing
    expect(scanned).toEqual(
      expect.arrayContaining(["server/auth.ts", "server/auth/handler.ts"])
    );
    expect(offenders, EXPLANATION).toEqual([]);
    // the forwarding line must still be there, or the exemption above guards nothing
    expect(
      readFileSync(join(root, FORWARDS_PLUGINS_FILE), "utf8"),
      "server/auth.ts no longer forwards plugins with the expected line"
    ).toContain(FORWARDS_PLUGINS_LINE);
    expect(builders.sort(), BUILDER_EXPLANATION).toEqual(BUILDERS);
  });
});
