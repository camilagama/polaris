import { createDatabase } from "@polaris/db/client";
import { createBetterAuth } from "../auth";
import type { WorkerBindings } from "../environment";

export async function handleBetterAuthRequest(
  request: Request,
  bindings: WorkerBindings
): Promise<Response> {
  const secret = bindings.BETTER_AUTH_SECRET;
  const baseURL = bindings.BETTER_AUTH_BASE_URL;

  if (!secret || secret.length < 32 || !baseURL) {
    return Response.json(
      { error: { code: "auth_unavailable" } },
      { status: 503 }
    );
  }

  const { db, pool } = createDatabase(bindings.HYPERDRIVE.connectionString, {
    maxConnections: 1,
  });

  try {
    const auth = createBetterAuth({ baseURL, database: db, secret });
    return await auth.handler(request);
  } finally {
    await pool.end();
  }
}
