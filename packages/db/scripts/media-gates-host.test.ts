import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const refusal = /direct disposable Neon endpoint/;
const connectionFailure = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo/;

const refusedHosts: Array<{ ci: string; host: string; label: string }> = [
  {
    ci: "true",
    host: "ep-cool-wave-a5b6c7d8-pooler.c-2.sa-east-1.aws.neon.tech",
    label: "a pooled Neon endpoint",
  },
  {
    ci: "true",
    host: "db.internal.example",
    label: "a host that is not on the list",
  },
  {
    ci: "true",
    host: "ep-cool-wave-a5b6c7d8.c-2.us-east-2.aws.neon.tech",
    label: "a Neon endpoint outside São Paulo",
  },
  { ci: "false", host: "localhost", label: "the local Postgres outside CI" },
];

const allowedUrl =
  "postgresql://neondb_owner:secret@localhost:5432/neondb?sslmode=verify-full";

const gates = [
  {
    environment: (url: string, host: string, adminUrl: string) => ({
      POLARIS_MEDIA_GATE_CONFIRM_DISPOSABLE: "polaris-pr33-media-schema-gate",
      POLARIS_MEDIA_GATE_DATABASE_URL: adminUrl,
      POLARIS_MEDIA_GATE_EXPECTED_HOSTNAME: host,
      POLARIS_MEDIA_GATE_RUNTIME_DATABASE_URL: url,
    }),
    name: "media-schema",
    script: "scripts/verify-media-gate.ts",
  },
  {
    environment: (url: string, host: string, adminUrl: string) => ({
      POLARIS_MEDIA_DERIVATIVES_GATE_BRANCH: "pr0-ci-gate",
      POLARIS_MEDIA_DERIVATIVES_GATE_DATABASE_URL: adminUrl,
      POLARIS_MEDIA_DERIVATIVES_GATE_EXPECTED_HOSTNAME: host,
      POLARIS_MEDIA_DERIVATIVES_GATE_TENANT_DATABASE_URL: url,
    }),
    name: "media-derivatives",
    script: "scripts/verify-media-derivatives-gate.ts",
  },
];

function runGate(
  script: string,
  environment: Record<string, string>,
  ci: string
) {
  const result = spawnSync("bun", [script], {
    cwd: packageDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
      CI: ci,
      POLARIS_GATE_DATABASE: "neondb",
    },
    timeout: 60_000,
  });
  return { output: `${result.stdout}${result.stderr}`, status: result.status };
}

function expectRefusedBeforeConnecting(run: ReturnType<typeof runGate>) {
  expect(run.status).not.toBe(0);
  expect(run.output).toMatch(refusal);
  expect(run.output).not.toMatch(connectionFailure);
  expect(run.output).not.toContain("secret");
}

describe("the media gates keep the host list of gate-hosts.ts", () => {
  for (const gate of gates) {
    for (const target of refusedHosts) {
      it(`${gate.name} refuses ${target.label} before it connects`, () => {
        const url = `postgresql://neondb_owner:secret@${target.host}:5432/neondb?sslmode=verify-full`;
        expectRefusedBeforeConnecting(
          runGate(
            gate.script,
            gate.environment(url, target.host, url),
            target.ci
          )
        );
      });
    }

    it(`${gate.name} also checks the second URL, with the first one on the allowed local host`, () => {
      const refusedUrl =
        "postgresql://neondb_owner:secret@db.internal.example:5432/neondb?sslmode=verify-full";
      expectRefusedBeforeConnecting(
        runGate(
          gate.script,
          gate.environment(refusedUrl, "localhost", allowedUrl),
          "true"
        )
      );
    });
  }
});
