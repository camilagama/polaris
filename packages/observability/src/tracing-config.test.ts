import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const WORKERS = ["web", "admin", "catalog"] as const;
const PRODUCTION_TRACES_RATE = 0.05;

interface Observability {
  enabled?: boolean;
  head_sampling_rate?: number;
  logs?: {
    enabled?: boolean;
    head_sampling_rate?: number;
    invocation_logs?: boolean;
  };
  traces?: { enabled?: boolean; head_sampling_rate?: number };
}

interface WranglerConfig {
  observability?: Observability;
  env?: Record<string, { observability?: Observability }>;
}

// wrangler.jsonc is JSON with comments and trailing commas, which is also a valid JavaScript expression;
// evaluating it avoids a comment stripper that would break on the "//" of the connection strings.
const readConfig = (worker: string): WranglerConfig =>
  new Function(
    `return (${readFileSync(new URL(`../../../apps/${worker}/wrangler.jsonc`, import.meta.url), "utf8")});`
  )() as WranglerConfig;

describe.each(WORKERS)("the observability block of the %s Worker", (worker) => {
  const config = readConfig(worker);
  const { observability } = config;

  it("keeps Workers Logs and traces on", () => {
    expect(observability?.enabled).toBe(true);
    expect(observability?.logs?.enabled).toBe(true);
    expect(observability?.traces?.enabled).toBe(true);
  });

  it("samples production traces at 5%", () => {
    expect(observability?.traces?.head_sampling_rate).toBe(
      PRODUCTION_TRACES_RATE
    );
  });

  it("never samples logs below 100%, because the platform has no separate rate for errors", () => {
    expect(observability?.logs?.head_sampling_rate).toBe(1);
    // a top-level rate would also apply to logs that do not set their own
    expect(observability?.head_sampling_rate ?? 1).toBe(1);
  });

  it("stores only the structured events: invocation logs stay off", () => {
    expect(observability?.logs?.invocation_logs).toBe(false);
  });

  // an environment block replaces the top-level one instead of merging with it, so it is checked on its own
  it("does not let a named environment turn observability off, lower the log rate or bring invocation logs back", () => {
    for (const environment of Object.values(config.env ?? {})) {
      const override = environment.observability;
      if (override === undefined) {
        continue;
      }
      expect(override.enabled).toBe(true);
      expect(override.logs?.enabled).toBe(true);
      expect(override.traces?.enabled).toBe(true);
      expect(override.logs?.head_sampling_rate).toBe(1);
      expect(override.head_sampling_rate ?? 1).toBe(1);
      expect(override.logs?.invocation_logs).toBe(false);
    }
  });
});
