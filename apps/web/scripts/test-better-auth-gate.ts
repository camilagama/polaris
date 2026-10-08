import assert from "node:assert/strict";
import { createDatabase } from "@polaris/db/client";
import type { BetterAuthPlugin } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { createBetterAuth } from "../src/server/auth";

interface TestAuthHelpers {
  createUser: (overrides?: Record<string, unknown>) => { id: string };
  deleteUser: (userId: string) => Promise<void>;
  login: (options: { userId: string }) => Promise<{
    headers: Headers;
    token: string;
  }>;
  saveUser: (user: { id: string }) => Promise<{ id: string }>;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error("Missing auth gate environment configuration.");
  }
  return value;
}

async function main() {
  const databaseUrl = requiredEnvironment("DATABASE_URL");
  const baseURL = requiredEnvironment("BETTER_AUTH_BASE_URL");
  const workerUrl = new URL(requiredEnvironment("AUTH_GATE_WORKER_URL"));
  const secret = requiredEnvironment("BETTER_AUTH_SECRET");

  if (!["127.0.0.1", "localhost"].includes(workerUrl.hostname)) {
    throw new Error("The auth gate only calls a Worker on localhost.");
  }
  if (workerUrl.origin !== baseURL || secret.length < 32) {
    throw new Error("The auth gate Worker configuration is invalid.");
  }

  const { db, pool } = createDatabase(databaseUrl, { maxConnections: 1 });
  let helpers: TestAuthHelpers | undefined;
  let fixtureUserId: string | undefined;

  try {
    const testPlugin = testUtils() as unknown as BetterAuthPlugin;
    const auth = createBetterAuth({
      baseURL,
      database: db,
      plugins: [testPlugin],
      secret,
    });
    helpers = ((await auth.$context) as unknown as { test: TestAuthHelpers })
      .test;

    const user = await helpers.saveUser(
      helpers.createUser({
        email: "auth-gate@example.invalid",
        name: "Auth Gate Fixture",
      })
    );
    fixtureUserId = user.id;

    const login = await helpers.login({ userId: user.id });
    const sessionResponse = await fetch(
      new URL("/api/auth/get-session", workerUrl),
      { headers: login.headers }
    );
    const sessionBody = (await sessionResponse.json()) as {
      session?: { token?: string };
      user?: { id?: string };
    };

    assert.equal(sessionResponse.status, 200);
    assert.equal(sessionBody.session?.token, login.token);
    assert.equal(sessionBody.user?.id, user.id);

    const revokeHeaders = new Headers(login.headers);
    revokeHeaders.set("content-type", "application/json");
    revokeHeaders.set("origin", baseURL);
    const revokeResponse = await fetch(
      new URL("/api/auth/revoke-session", workerUrl),
      {
        body: JSON.stringify({ token: login.token }),
        headers: revokeHeaders,
        method: "POST",
      }
    );
    assert.equal(revokeResponse.status, 200);

    const afterRevoke = await fetch(
      new URL("/api/auth/get-session?disableCookieCache=true", workerUrl),
      { headers: login.headers }
    );
    assert.equal(afterRevoke.status, 200);
    assert.equal(await afterRevoke.json(), null);

    console.log("auth_worker_session_read=passed");
    console.log("auth_worker_session_revocation=passed");
  } finally {
    if (fixtureUserId && helpers) {
      await helpers.deleteUser(fixtureUserId);
    }
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : "UnknownError";
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const secret = process.env.BETTER_AUTH_SECRET ?? "";
  const message = error instanceof Error ? error.message : "unknown error";
  const safeMessage = message
    .replaceAll(databaseUrl, "[redacted]")
    .replaceAll(secret, "[redacted]");
  console.error("auth_gate_test=failed", name, safeMessage);
  process.exitCode = 1;
});
