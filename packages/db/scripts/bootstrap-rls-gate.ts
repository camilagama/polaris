import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const adminConnectionString = process.env.POLARIS_RLS_ADMIN_DATABASE_URL;
const disposableMarker = process.env.POLARIS_RLS_CONFIRM_DISPOSABLE;
const expectedHostname = process.env.POLARIS_RLS_EXPECTED_HOSTNAME;
const expectedDisposableMarker = "polaris-pr11-rls-gate";

if (!adminConnectionString) {
  throw new Error(
    "Set POLARIS_RLS_ADMIN_DATABASE_URL to the direct owner URL for the new disposable project."
  );
}

if (disposableMarker !== expectedDisposableMarker) {
  throw new Error(
    `Set POLARIS_RLS_CONFIRM_DISPOSABLE=${expectedDisposableMarker} only for the new disposable project.`
  );
}

if (!expectedHostname) {
  throw new Error(
    "Set POLARIS_RLS_EXPECTED_HOSTNAME to the endpoint hostname shown by the newly created disposable project."
  );
}

const adminUrl = new URL(adminConnectionString);
const databaseName = decodeURIComponent(adminUrl.pathname.slice(1));

if (
  adminUrl.hostname.includes("-pooler") ||
  adminUrl.hostname !== expectedHostname ||
  !adminUrl.hostname.endsWith(".sa-east-1.aws.neon.tech") ||
  databaseName !== "neondb"
) {
  throw new Error(
    "The PR11 bootstrap requires a direct Neon PostgreSQL 18 connection in AWS South America East 1 (São Paulo) to the new project's neondb database."
  );
}

const runtimeRole = "polaris_pr11_runtime";
const runtimePassword = randomBytes(32).toString("base64url");
const migrationPath = fileURLToPath(
  new URL("../drizzle/0001_typical_jackpot.sql", import.meta.url)
);
const migrationSql = await readFile(migrationPath, "utf8");
const webDirectory = fileURLToPath(
  new URL("../../../apps/web/", import.meta.url)
);
const configPath = fileURLToPath(
  new URL("../../../apps/web/wrangler.pr11.jsonc", import.meta.url)
);
const excludedCloudflareEnvironment = new Set([
  "DATABASE_URL",
  "NEON_API_KEY",
  "NEON_API_TOKEN",
  "POLARIS_RLS_ADMIN_DATABASE_URL",
  "POLARIS_RLS_CONFIRM_DISPOSABLE",
  "POLARIS_RLS_EXPECTED_HOSTNAME",
]);
const cfEnvironment: NodeJS.ProcessEnv = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !excludedCloudflareEnvironment.has(key)) {
    cfEnvironment[key] = value;
  }
}
const pool = new Pool({ connectionString: adminConnectionString, max: 1 });

try {
  const identity = await pool.query<{
    currentDatabase: string;
    currentUser: string;
    serverVersion: string;
  }>(
    `SELECT current_database() AS "currentDatabase",
            current_user AS "currentUser",
            current_setting('server_version') AS "serverVersion"`
  );
  const [row] = identity.rows;
  const serverMajor = Number.parseInt(
    row?.serverVersion.split(".")[0] ?? "",
    10
  );

  if (serverMajor !== 18 || row?.currentDatabase !== "neondb") {
    throw new Error(
      `Expected PostgreSQL 18 on neondb; found PostgreSQL ${row?.serverVersion ?? "unknown"}.`
    );
  }

  if (row.currentUser === runtimeRole) {
    throw new Error("The admin URL must not use the PR11 runtime role.");
  }

  const publicObjects = await pool.query<{ name: string }>(
    `SELECT relation.relname AS name
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        AND relation.relpersistence <> 't'
      LIMIT 1`
  );
  if (publicObjects.rowCount !== 0) {
    throw new Error(
      "The target public schema already has a persistent relation. Use the fresh disposable project created for this gate."
    );
  }

  const existing = await pool.query<{
    relation: string | null;
    role: string | null;
  }>(
    `SELECT to_regclass('public.rls_poc_operations')::text AS relation,
            (SELECT rolname FROM pg_roles WHERE rolname = $1) AS role`,
    [runtimeRole]
  );

  if (existing.rows[0]?.relation || existing.rows[0]?.role) {
    throw new Error(
      "The fixture or runtime role already exists. Bootstrap only a fresh disposable project; use a new one for a repeat run."
    );
  }

  const cfAuth = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "cf auth whoami --quiet",
    ],
    { cwd: webDirectory, encoding: "utf8", env: cfEnvironment }
  );
  if (cfAuth.status !== 0) {
    throw new Error(
      `The cf CLI authentication check failed (exit ${cfAuth.status ?? "unknown"}).`
    );
  }

  let cfIdentity: {
    accounts?: Array<{ id?: string }>;
    authenticated?: boolean;
    tokenValid?: boolean;
  };
  try {
    cfIdentity = JSON.parse(cfAuth.stdout ?? "") as typeof cfIdentity;
  } catch (error) {
    throw new Error(
      "The cf CLI returned an unreadable authentication result.",
      {
        cause: error,
      }
    );
  }
  if (
    cfIdentity.authenticated !== true ||
    cfIdentity.tokenValid !== true ||
    cfIdentity.accounts?.length !== 1 ||
    !cfIdentity.accounts[0]?.id
  ) {
    throw new Error(
      "The cf CLI must have a valid token and exactly one selected Cloudflare account before bootstrap."
    );
  }

  await pool.query(
    `CREATE ROLE ${runtimeRole}
       LOGIN PASSWORD '${runtimePassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`
  );
  await pool.query(
    `GRANT CONNECT ON DATABASE ${databaseName} TO ${runtimeRole}`
  );

  const migrationClient = await pool.connect();
  try {
    await migrationClient.query("BEGIN");
    await migrationClient.query(migrationSql);
    await migrationClient.query("COMMIT");
  } catch (error) {
    await migrationClient.query("ROLLBACK");
    throw error;
  } finally {
    migrationClient.release();
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config($1, $2, true)", [
      "app.organization_id",
      "org_a",
    ]);
    await client.query(
      `INSERT INTO public.rls_poc_operations (organization_id, token, value)
       VALUES ('org_a', 'seed-a', 'synthetic data for org_a')`
    );
    await client.query("SELECT set_config($1, $2, true)", [
      "app.organization_id",
      "org_b",
    ]);
    await client.query(
      `INSERT INTO public.rls_poc_operations (organization_id, token, value)
       VALUES ('org_b', 'seed-b', 'synthetic data for org_b')`
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const roleCheck = await pool.query<{
    bypassRls: boolean;
    ownsTable: boolean;
    superuser: boolean;
  }>(
    `SELECT role.rolsuper AS "superuser",
            role.rolbypassrls AS "bypassRls",
            relation.relowner = role.oid AS "ownsTable"
       FROM pg_roles AS role
       JOIN pg_class AS relation
         ON relation.oid = 'public.rls_poc_operations'::regclass
      WHERE role.rolname = $1`,
    [runtimeRole]
  );
  const [security] = roleCheck.rows;

  if (
    !security ||
    security.superuser ||
    security.bypassRls ||
    security.ownsTable
  ) {
    throw new Error(
      "The runtime role must be non-superuser, NOBYPASSRLS, and not the fixture owner."
    );
  }

  const cfBody = JSON.stringify({
    name: "polaris-pr11-rls-gate",
    origin: {
      database: databaseName,
      host: adminUrl.hostname,
      password: runtimePassword,
      port: Number(adminUrl.port || "5432"),
      scheme: "postgresql",
      user: runtimeRole,
    },
    caching: { disabled: true },
    origin_connection_limit: 5,
    mtls: { sslmode: "require" },
  });
  cfEnvironment.POLARIS_RLS_CF_BODY = cfBody;

  const cf = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "cf hyperdrive create --quiet --body $env:POLARIS_RLS_CF_BODY",
    ],
    {
      cwd: webDirectory,
      encoding: "utf8",
      env: cfEnvironment,
    }
  );

  const cliOutput = `${cf.stdout ?? ""}${cf.stderr ?? ""}`
    .replaceAll(runtimePassword, "[redacted]")
    .replaceAll(adminConnectionString, "[redacted]");

  if (cf.status !== 0) {
    throw new Error(
      `The Cloudflare cf CLI could not create the Hyperdrive resource (exit ${cf.status ?? "unknown"}). ${cliOutput}`
    );
  }

  interface HyperdriveResource {
    caching?: { disabled?: boolean };
    id?: string;
  }
  interface HyperdriveResponse extends HyperdriveResource {
    data?: HyperdriveResource;
    result?: HyperdriveResource;
    success?: boolean;
  }
  let response: HyperdriveResponse;
  try {
    response = JSON.parse(cf.stdout ?? "") as typeof response;
  } catch (error) {
    throw new Error(
      `The Cloudflare cf CLI returned an unreadable Hyperdrive response. ${cliOutput}`,
      { cause: error }
    );
  }
  const resource: HyperdriveResource =
    response.result ?? response.data ?? response;

  if (
    response.success === false ||
    !resource.id ||
    resource.caching?.disabled !== true
  ) {
    throw new Error(
      `Cloudflare did not confirm a Hyperdrive resource with SQL response caching disabled. ${cliOutput}`
    );
  }

  let binding: { binding?: string; id?: string; remote?: boolean } | undefined;
  try {
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      hyperdrive?: Array<{
        binding?: string;
        id?: string;
        remote?: boolean;
      }>;
    };
    binding = config.hyperdrive?.find(
      (candidate) => candidate.binding === "HYPERDRIVE"
    );

    if (!binding) {
      throw new Error(
        "The PR11 Wrangler config is missing its HYPERDRIVE binding."
      );
    }

    binding.id = resource.id;
    binding.remote = true;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    if (binding.id !== resource.id || binding.remote !== true) {
      throw new Error("The PR11 Hyperdrive binding did not update correctly.");
    }
  } catch (error) {
    throw new Error(
      `Hyperdrive ${resource.id} was created but the PR11 config was not updated. Inspect it with cf hyperdrive get ${resource.id} before recovery.`,
      { cause: error }
    );
  }

  console.log(
    JSON.stringify({
      database: databaseName,
      hyperdriveBinding: binding.binding,
      hyperdriveResourceId: binding.id,
      hyperdriveOriginConnectionLimit: 5,
      postgresMajor: serverMajor,
      region: "aws-sa-east-1",
      runtimeRole,
      runtimeRoleBypassRls: security.bypassRls,
      runtimeRoleIsOwner: security.ownsTable,
      sqlQueryCaching: "disabled",
      workerConnectionPooling: "enabled",
    })
  );
} finally {
  await pool.end();
}
