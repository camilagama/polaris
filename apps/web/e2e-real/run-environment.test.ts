import { describe, expect, it } from "vitest";
import { closedEnvironment } from "./closed-environment";
import {
  assertLoopbackBaseUrl,
  assertRunHyperdrives,
  ensureRunEnvironment,
  HYPERDRIVE_BINDINGS,
  hyperdriveVariable,
  ownerDatabaseUrl,
  previewEnvironment,
} from "./run-environment";

const DATABASE_URL_REQUIRED = /POLARIS_E2E_DATABASE_URL is required/;
const LOOPBACK_ONLY = /loopback/;
const OUTBOX_NOT_RUN_LOGIN = /OUTBOX_HYPERDRIVE is not the run login/;
const PRIVACY_MISSING = /PRIVACY_HYPERDRIVE is missing/;
const LOCAL_ONLY = /must be the local PostgreSQL/;
const SECRET_NOT_HEX = /E2E_RUN_SECRET must be/;
const PASSWORD_NOT_HEX = /E2E_LOGIN_PASSWORD_HYPERDRIVE must be/;
const PREVIEW_VARIABLES_MISSING = /E2E_PREVIEW_VARIABLES is missing/;
const HEX_64 = /^[a-f0-9]{64}$/;

const OWNER = "postgresql://owner:secret@localhost:5432/postgres";

describe("the environment of an e2e run", () => {
  it("is made once: a second evaluation (another Playwright process) reads the same values", () => {
    const parent: NodeJS.ProcessEnv = {};
    const first = ensureRunEnvironment(parent);
    // a worker process inherits a copy of the parent's environment
    const worker = { ...parent };
    expect(ensureRunEnvironment(worker)).toEqual(first);
    expect(ensureRunEnvironment(parent)).toEqual(first);
    expect(ensureRunEnvironment({})).not.toEqual(first);
    expect(new Set(Object.values(first.passwords)).size).toBe(
      HYPERDRIVE_BINDINGS.length
    );
  });

  it("gives the preview the seven bindings as the run's logins, a closed list and no environment of wrangler", () => {
    const run = ensureRunEnvironment({});
    const environment = previewEnvironment(
      new URL(OWNER),
      run,
      "http://127.0.0.1:4321",
      true,
      {
        CLOUDFLARE_ENV: "production",
        PATH: "/bin",
        POLARIS_E2E_DATABASE_URL: OWNER,
      }
    );
    expect(() => assertRunHyperdrives(environment, run.runId)).not.toThrow();
    expect(environment.CLOUDFLARE_ENV).toBeUndefined();
    expect(environment.POLARIS_E2E_DATABASE_URL).toBeUndefined();
    expect(environment.PATH).toBe("/bin");
    expect(environment.VITE_OFFLINE_RUNTIME_ENABLED).toBe("true");
    expect(environment.BETTER_AUTH_SECRET).toBe(run.secret);
    expect(JSON.stringify(environment)).not.toContain("owner:secret");
  });

  it("gives the lease and sync keys to the preview with the runtime on only, 32 bytes or more, and never the run's own secret", () => {
    const run = ensureRunEnvironment({});
    const origin = "http://127.0.0.1:4321";
    const on = previewEnvironment(new URL(OWNER), run, origin, true, {});
    const off = previewEnvironment(new URL(OWNER), run, origin, false, {});
    for (const name of ["OFFLINE_LEASE_SECRET", "SYNC_PAYLOAD_HASH_SECRET"]) {
      expect(on[name], name).toMatch(HEX_64);
      expect(on[name], name).not.toBe(run.secret);
      expect(off[name], name).toBeUndefined();
      expect(on.E2E_PREVIEW_VARIABLES, name).toContain(name);
      expect(off.E2E_PREVIEW_VARIABLES, name).not.toContain(name);
    }
    expect(on.OFFLINE_LEASE_SECRET).not.toBe(on.SYNC_PAYLOAD_HASH_SECRET);
    expect(closedEnvironment(on, "build").OFFLINE_LEASE_SECRET).toBeUndefined();
  });

  it("refuses a binding missing or left on the wrangler.jsonc fallback (postgres:postgres)", () => {
    const run = ensureRunEnvironment({});
    const environment = previewEnvironment(
      new URL(OWNER),
      run,
      "http://127.0.0.1:4321",
      false,
      {}
    );
    const missing = {
      ...environment,
      [hyperdriveVariable("PRIVACY_HYPERDRIVE")]: undefined,
    };
    expect(() => assertRunHyperdrives(missing, run.runId)).toThrow(
      PRIVACY_MISSING
    );
    const fallback = {
      ...environment,
      [hyperdriveVariable("OUTBOX_HYPERDRIVE")]:
        "postgresql://postgres:postgres@127.0.0.1:5432/polaris",
    };
    expect(() => assertRunHyperdrives(fallback, run.runId)).toThrow(
      OUTBOX_NOT_RUN_LOGIN
    );
  });

  it("only takes the loopback as BASE_URL", () => {
    expect(assertLoopbackBaseUrl("http://127.0.0.1:4321").port).toBe("4321");
    for (const url of [
      "https://polaris-web-staging.example.workers.dev",
      "http://10.0.0.2:4321",
      "https://127.0.0.1:4321",
    ]) {
      expect(() => assertLoopbackBaseUrl(url), url).toThrow(LOOPBACK_ONLY);
    }
  });

  it("only takes a database host of gate-hosts.ts, and the local one only with CI=true", () => {
    expect(
      ownerDatabaseUrl({ CI: "true", POLARIS_E2E_DATABASE_URL: OWNER }).hostname
    ).toBe("localhost");
    expect(() =>
      ownerDatabaseUrl({ POLARIS_E2E_DATABASE_URL: OWNER })
    ).toThrow();
    expect(() =>
      ownerDatabaseUrl({
        CI: "true",
        POLARIS_E2E_DATABASE_URL: "postgresql://u:p@db.example.com/x",
      })
    ).toThrow();
    expect(() =>
      ownerDatabaseUrl({
        CI: "true",
        POLARIS_E2E_DATABASE_URL:
          "postgresql://u:p@localhost/x?host=db.example.com",
      })
    ).toThrow();
    expect(() => ownerDatabaseUrl({ CI: "true" })).toThrow(
      DATABASE_URL_REQUIRED
    );
    // the remote pattern of gate-hosts.ts also matches production: this harness creates databases, so only local
    expect(() =>
      ownerDatabaseUrl({
        CI: "true",
        POLARIS_E2E_DATABASE_URL: `postgresql://u:p@ep-cool-name-123456.c-2.sa-east-1.aws.${"neon"}.tech/db`,
      })
    ).toThrow(LOCAL_ONLY);
  });

  it("refuses a secret or a password set by hand that is not hex (they enter SQL and URLs)", () => {
    const valid = ensureRunEnvironment({});
    expect(() =>
      ensureRunEnvironment({ E2E_RUN_SECRET: "x' ; select 1; --" })
    ).toThrow(SECRET_NOT_HEX);
    expect(() =>
      ensureRunEnvironment({
        E2E_LOGIN_PASSWORD_HYPERDRIVE: "a'b",
        E2E_RUN_SECRET: valid.secret,
      })
    ).toThrow(PASSWORD_NOT_HEX);
  });

  it("closes the environment of the build and of the preview to the names of the config", () => {
    const run = ensureRunEnvironment({});
    const config = previewEnvironment(
      new URL(OWNER),
      run,
      "http://127.0.0.1:4321",
      false,
      { PATH: "/bin" }
    );
    // what Playwright hands a web server: the whole environment of its process plus the config's
    const leaked = [
      "ASAAS_API_KEY",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ENV",
      "POLARIS_E2E_DATABASE_URL",
      "RESEND_API_KEY",
      "VITE_SENTRY_DSN",
    ];
    const merged = {
      ...config,
      ...Object.fromEntries(leaked.map((name) => [name, "value"])),
    };
    const preview = closedEnvironment(merged, "preview");
    const build = closedEnvironment(merged, "build");
    for (const name of leaked) {
      expect(preview[name], name).toBeUndefined();
      expect(build[name], name).toBeUndefined();
    }
    expect(preview.BETTER_AUTH_SECRET).toBe(run.secret);
    expect(() => assertRunHyperdrives(preview, run.runId)).not.toThrow();
    expect(build.BETTER_AUTH_SECRET).toBeUndefined();
    expect(
      Object.keys(build).some((name) => name.startsWith("CLOUDFLARE_"))
    ).toBe(false);
    expect(build.VITE_OFFLINE_RUNTIME_ENABLED).toBe("false");
    expect(() => closedEnvironment({ PATH: "/bin" }, "preview")).toThrow(
      PREVIEW_VARIABLES_MISSING
    );
  });

  it("gives the keys of the offline runtime to the preview the stack lists them for, never to the build", () => {
    const names = ["OFFLINE_LEASE_SECRET", "SYNC_PAYLOAD_HASH_SECRET"];
    const environment = {
      E2E_PREVIEW_VARIABLES: names.join(","),
      OFFLINE_LEASE_SECRET: "a".repeat(64),
      SYNC_PAYLOAD_HASH_SECRET: "b".repeat(64),
    };
    const preview = closedEnvironment(environment, "preview");
    const build = closedEnvironment(environment, "build");
    for (const name of names) {
      expect(preview[name], name).toHaveLength(64);
      expect(build[name], name).toBeUndefined();
    }
  });
});
