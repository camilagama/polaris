import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import {
  assertAllowedGateUrl,
  isLocalGateHost,
} from "../../../packages/db/scripts/gate-hosts";
import { type RlsPocEnv, rlsPocRoutes } from "../poc/rls-poc";

/**
 * The RLS gate (`packages/db/scripts/verify-rls-gate.ts`) in the CI job.
 *
 * On Neon the gate calls a Worker behind Hyperdrive (`wrangler dev --remote`,
 * `poc:rls:verify`). The CI job has neither, so this script serves the SAME
 * route (`poc/rls-poc.ts`, the same transactions) from a local server whose
 * "Hyperdrive" is a direct connection to the job's Postgres as the runtime
 * login, then runs the real gate against it. What it proves: the policy, FORCE
 * RLS, cross-tenant reads and writes, rollback, the transaction-local context
 * and the retry after a killed backend. What stays Neon-only: pooling and SQL
 * caching of Hyperdrive itself.
 *
 * Environment (set by the runner, never printed):
 *   POLARIS_RLS_ADMIN_DATABASE_URL    owner URL of the disposable database
 *   POLARIS_RLS_RUNTIME_DATABASE_URL  URL of the runtime login (member of polaris_pr11_runtime)
 */
const adminUrl = process.env.POLARIS_RLS_ADMIN_DATABASE_URL;
const runtimeUrl = process.env.POLARIS_RLS_RUNTIME_DATABASE_URL;
if (!(adminUrl && runtimeUrl)) {
  throw new Error(
    "POLARIS_RLS_ADMIN_DATABASE_URL and POLARIS_RLS_RUNTIME_DATABASE_URL are required."
  );
}
for (const candidate of [adminUrl, runtimeUrl]) {
  if (!isLocalGateHost(assertAllowedGateUrl(candidate).hostname)) {
    throw new Error(
      "This stand-in runs only against the CI Postgres. Against Neon, run poc:rls:verify through the Worker."
    );
  }
}

const app = new Hono<RlsPocEnv>();
app.route("/api/poc/rls", rlsPocRoutes);
const env: RlsPocEnv["Bindings"] = {
  DB_RLS_POC_ENABLED: "true",
  HYPERDRIVE: { connectionString: runtimeUrl },
};
const server = createServer(async (incoming, outgoing) => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  const response = await app.fetch(
    new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
      body: body.length > 0 ? new Uint8Array(body) : null,
      headers: incoming.headers as Record<string, string>,
      method: incoming.method ?? "GET",
    }),
    env
  );
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

const exitCode = await new Promise<number>((resolve) => {
  const child = spawn(process.execPath, ["scripts/verify-rls-gate.ts"], {
    cwd: fileURLToPath(new URL("../../../packages/db", import.meta.url)),
    env: {
      ...process.env,
      POLARIS_RLS_POC_URL: `http://127.0.0.1:${port}/api/poc/rls/run`,
    },
    stdio: "inherit",
  });
  child.on("close", (code) => resolve(code ?? 1));
  child.on("error", () => resolve(1));
  // the executor stops this process on its time limit: take the gate down with it
  process.once("SIGTERM", () => child.kill());
});
await new Promise<void>((resolve) => {
  server.closeAllConnections();
  server.close(() => resolve());
});
process.exitCode = exitCode;
