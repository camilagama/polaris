import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const script = "scripts/prepare-tenant-context-gate.ts";
const connectionFailure = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo/;

const confirmation = "polaris-pr22-tenant-context-disposable";
const validHost = "ep-cool-wave-a5b6c7d8.c-2.sa-east-1.aws.neon.tech";
const otherValidHost = "ep-calm-river-f9e8d7c6.c-2.sa-east-1.aws.neon.tech";
const pooledHost = "ep-cool-wave-pooler.c-2.sa-east-1.aws.neon.tech";
const foreignHost = "db.internal.example";
const otherRegionHost = "ep-cool-wave-a5b6c7d8.c-2.us-east-2.aws.neon.tech";

function escapeDots(value: string) {
  return value.replaceAll(".", "\\.");
}

function urlFor(host: string, database = "neondb") {
  return `postgresql://neondb_owner:secret@${host}:5432/${database}?sslmode=verify-full`;
}

function environmentWithout(prefix: string, names: string[]) {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      !name.startsWith(prefix) &&
      !names.includes(name)
    ) {
      inherited[name] = value;
    }
  }
  return inherited;
}

function runScript(tenantVariables: Record<string, string>) {
  const result = spawnSync("bun", [script], {
    cwd: packageDirectory,
    encoding: "utf8",
    env: {
      ...environmentWithout("POLARIS_TENANT_CONTEXT_TEST_", [
        "POLARIS_SALES_GATE_DATABASE",
      ]),
      ...tenantVariables,
      POLARIS_GATE_DATABASE: "neondb",
    },
    timeout: 60_000,
  });
  return { output: `${result.stdout}${result.stderr}`, status: result.status };
}

function variables(overrides: Record<string, string | undefined> = {}) {
  const complete: Record<string, string | undefined> = {
    POLARIS_TENANT_CONTEXT_TEST_CONFIRM_DISPOSABLE: confirmation,
    POLARIS_TENANT_CONTEXT_TEST_DATABASE_URL: urlFor(validHost),
    POLARIS_TENANT_CONTEXT_TEST_EXPECTED_HOSTNAME: validHost,
    ...overrides,
  };
  const present: Record<string, string> = {};
  for (const [name, value] of Object.entries(complete)) {
    if (value !== undefined) {
      present[name] = value;
    }
  }
  return present;
}

const refusals: Array<{
  environment: Record<string, string>;
  label: string;
  refusal: RegExp;
}> = [
  {
    environment: {},
    label: "no configuration at all",
    refusal: /Missing required PR22 disposable database configuration\./,
  },
  {
    environment: variables({
      POLARIS_TENANT_CONTEXT_TEST_CONFIRM_DISPOSABLE: undefined,
    }),
    label: "a missing disposable-branch confirmation",
    refusal: /requires its disposable-branch confirmation\./,
  },
  {
    environment: variables({
      POLARIS_TENANT_CONTEXT_TEST_CONFIRM_DISPOSABLE: "yes",
    }),
    label: "a wrong disposable-branch confirmation",
    refusal: /requires its disposable-branch confirmation\./,
  },
  {
    environment: variables({
      POLARIS_TENANT_CONTEXT_TEST_EXPECTED_HOSTNAME: undefined,
    }),
    label: "a missing expected hostname",
    refusal: /Missing required PR22 disposable database configuration\./,
  },
  {
    environment: variables({
      POLARIS_TENANT_CONTEXT_TEST_DATABASE_URL: "not a url",
    }),
    label: "a database URL that does not parse",
    refusal: /A valid direct Neon URL is required\./,
  },
  {
    environment: variables({
      POLARIS_TENANT_CONTEXT_TEST_EXPECTED_HOSTNAME: otherValidHost,
    }),
    label: "a host that differs from the expected hostname",
    refusal: new RegExp(
      `strictly equal[\\s\\S]*${escapeDots(validHost)}[\\s\\S]*${escapeDots(otherValidHost)}`
    ),
  },
  {
    environment: variables({
      POLARIS_TENANT_CONTEXT_TEST_DATABASE_URL: urlFor(validHost, "other"),
    }),
    label: "a database other than the gate database",
    refusal: /strictly equal[\s\S]*\/other[\s\S]*\/neondb/,
  },
  {
    environment: variables({
      POLARIS_TENANT_CONTEXT_TEST_DATABASE_URL: urlFor(pooledHost),
      POLARIS_TENANT_CONTEXT_TEST_EXPECTED_HOSTNAME: pooledHost,
    }),
    label: "a pooled Neon host",
    refusal: /true !== false/,
  },
  {
    environment: variables({
      POLARIS_TENANT_CONTEXT_TEST_DATABASE_URL: urlFor(foreignHost),
      POLARIS_TENANT_CONTEXT_TEST_EXPECTED_HOSTNAME: foreignHost,
    }),
    label: "a host outside the Neon São Paulo pattern",
    refusal: /did not match the regular expression/,
  },
  {
    environment: variables({
      POLARIS_TENANT_CONTEXT_TEST_DATABASE_URL: urlFor(otherRegionHost),
      POLARIS_TENANT_CONTEXT_TEST_EXPECTED_HOSTNAME: otherRegionHost,
    }),
    label: "a Neon host outside São Paulo",
    refusal: /did not match the regular expression/,
  },
];

describe("prepare-tenant-context-gate refuses before it connects", () => {
  for (const { environment, label, refusal } of refusals) {
    it(`refuses ${label}`, () => {
      const run = runScript(environment);
      expect(run.status).not.toBe(0);
      expect(run.output).toMatch(refusal);
      expect(run.output).not.toMatch(connectionFailure);
      expect(run.output).not.toContain("secret");
    });
  }
});
