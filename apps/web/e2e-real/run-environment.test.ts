import { describe, expect, it } from "vitest";
import {
  assertLoopbackBaseUrl,
  assertRunHyperdrives,
  ensureRunEnvironment,
  HYPERDRIVE_BINDINGS,
  hyperdriveVariable,
  ownerDatabaseUrl,
  previewEnvironment,
} from "./run-environment";

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
    expect(new Set(Object.values(first.passwords)).size).toBe(HYPERDRIVE_BINDINGS.length);
  });

  it("gives the preview the seven bindings as the run's logins, a closed list and no environment of wrangler", () => {
    const run = ensureRunEnvironment({});
    const environment = previewEnvironment(new URL(OWNER), run, "http://127.0.0.1:4321", true, {
      CLOUDFLARE_ENV: "production",
      PATH: "/bin",
      POLARIS_E2E_DATABASE_URL: OWNER,
    });
    expect(() => assertRunHyperdrives(environment, run.runId)).not.toThrow();
    expect(environment.CLOUDFLARE_ENV).toBeUndefined();
    expect(environment.POLARIS_E2E_DATABASE_URL).toBeUndefined();
    expect(environment.PATH).toBe("/bin");
    expect(environment.VITE_OFFLINE_RUNTIME_ENABLED).toBe("true");
    expect(environment.BETTER_AUTH_SECRET).toBe(run.secret);
    expect(JSON.stringify(environment)).not.toContain("owner:secret");
  });

  it("refuses a binding missing or left on the wrangler.jsonc fallback (postgres:postgres)", () => {
    const run = ensureRunEnvironment({});
    const environment = previewEnvironment(new URL(OWNER), run, "http://127.0.0.1:4321", false, {});
    const missing = { ...environment, [hyperdriveVariable("PRIVACY_HYPERDRIVE")]: undefined };
    expect(() => assertRunHyperdrives(missing, run.runId)).toThrow(/PRIVACY_HYPERDRIVE is missing/);
    const fallback = {
      ...environment,
      [hyperdriveVariable("OUTBOX_HYPERDRIVE")]: "postgresql://postgres:postgres@127.0.0.1:5432/polaris",
    };
    expect(() => assertRunHyperdrives(fallback, run.runId)).toThrow(/OUTBOX_HYPERDRIVE is not the run login/);
  });

  it("only takes the loopback as BASE_URL", () => {
    expect(assertLoopbackBaseUrl("http://127.0.0.1:4321").port).toBe("4321");
    for (const url of ["https://polaris-web-staging.example.workers.dev", "http://10.0.0.2:4321", "https://127.0.0.1:4321"]) {
      expect(() => assertLoopbackBaseUrl(url), url).toThrow(/loopback/);
    }
  });

  it("only takes a database host of gate-hosts.ts, and the local one only with CI=true", () => {
    expect(ownerDatabaseUrl({ CI: "true", POLARIS_E2E_DATABASE_URL: OWNER }).hostname).toBe("localhost");
    expect(() => ownerDatabaseUrl({ POLARIS_E2E_DATABASE_URL: OWNER })).toThrow();
    expect(() => ownerDatabaseUrl({ CI: "true", POLARIS_E2E_DATABASE_URL: "postgresql://u:p@db.example.com/x" })).toThrow();
    expect(() =>
      ownerDatabaseUrl({ CI: "true", POLARIS_E2E_DATABASE_URL: "postgresql://u:p@localhost/x?host=db.example.com" })
    ).toThrow();
    expect(() => ownerDatabaseUrl({ CI: "true" })).toThrow(/POLARIS_E2E_DATABASE_URL is required/);
  });
});
