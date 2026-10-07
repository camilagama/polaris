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
  "POLARIS_RLS_CF_BODY",
  "POLARIS_RLS_EXPECTED_HOSTNAME",
]);
const cfEnvironment: NodeJS.ProcessEnv = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !excludedCloudflareEnvironment.has(key)) {
    cfEnvironment[key] = value;
  }
}
const cfRuntimeCheck = spawnSync(
  "powershell.exe",
  [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$cfShim = (Get-Command cf -ErrorAction Stop).Source; $cfDirectory = Split-Path $cfShim -Parent; $node = Join-Path $cfDirectory 'node.exe'; if (-not (Test-Path $node)) { $node = (Get-Command node.exe -ErrorAction Stop).Source }; $entry = Join-Path $cfDirectory 'node_modules\\cf\\bin\\cf'; if (-not (Test-Path $entry)) { throw 'The cf JavaScript entrypoint was not found.' }; [pscustomobject]@{ node = $node; entry = $entry } | ConvertTo-Json -Compress",
  ],
  { cwd: webDirectory, encoding: "utf8", env: cfEnvironment }
);
if (cfRuntimeCheck.status !== 0 || !cfRuntimeCheck.stdout?.trim()) {
  throw new Error(
    "The cf CLI Node entrypoint could not be resolved; no database changes were made."
  );
}
let cfRuntime: { entry?: string; node?: string };
try {
  cfRuntime = JSON.parse(cfRuntimeCheck.stdout.trim()) as typeof cfRuntime;
} catch (error) {
  throw new Error(
    "The cf CLI Node entrypoint check returned unreadable output; no database changes were made.",
    { cause: error }
  );
}
if (!(cfRuntime.node && cfRuntime.entry)) {
  throw new Error(
    "The cf CLI Node entrypoint was incomplete; no database changes were made."
  );
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

  const publicObjects = await pool.query<{ kind: string; name: string }>(
    `SELECT relation.relname AS name,
            relation.relkind AS kind
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        AND relation.relpersistence <> 't'
      ORDER BY relation.relname`
  );
  const existing = await pool.query<{
    relation: string | null;
    role: string | null;
  }>(
    `SELECT to_regclass('public.rls_poc_operations')::text AS relation,
            (SELECT rolname FROM pg_roles WHERE rolname = $1) AS role`,
    [runtimeRole]
  );
  const [fixture] = existing.rows;
  const isFresh =
    publicObjects.rows.length === 0 && !fixture?.relation && !fixture?.role;
  const isRecoverableFixture =
    publicObjects.rows.length === 1 &&
    publicObjects.rows[0]?.name === "rls_poc_operations" &&
    publicObjects.rows[0]?.kind === "r" &&
    Boolean(fixture?.relation) &&
    fixture?.role === runtimeRole;

  if (!(isFresh || isRecoverableFixture)) {
    throw new Error(
      "The target must be empty or contain only the complete PR11 fixture from an interrupted bootstrap. Unknown existing state is never changed."
    );
  }

  if (isRecoverableFixture) {
    const roleResult = await pool.query<{
      bypassRls: boolean;
      canCreateDatabase: boolean;
      canCreateInSchema: boolean;
      canCreateRole: boolean;
      hasMemberships: boolean;
      inherit: boolean;
      login: boolean;
      ownsTable: boolean;
      superuser: boolean;
    }>(
      `SELECT role.rolsuper AS "superuser",
              role.rolcreatedb AS "canCreateDatabase",
              role.rolcreaterole AS "canCreateRole",
              EXISTS (
                SELECT 1
                  FROM pg_namespace AS public_schema
                 WHERE public_schema.nspname = 'public'
                   AND has_schema_privilege(role.oid, public_schema.oid, 'CREATE')
              ) AS "canCreateInSchema",
              role.rolinherit AS "inherit",
              role.rolcanlogin AS "login",
              role.rolbypassrls AS "bypassRls",
              EXISTS (
                SELECT 1
                  FROM pg_auth_members AS membership
                 WHERE membership.member = role.oid
                    OR membership.roleid = role.oid
              ) AS "hasMemberships",
              relation.relowner = role.oid AS "ownsTable"
         FROM pg_roles AS role
         JOIN pg_class AS relation
           ON relation.oid = 'public.rls_poc_operations'::regclass
        WHERE role.rolname = $1`,
      [runtimeRole]
    );
    const tableResult = await pool.query<{
      columns: string[];
      constraints: string[];
      externalGrantees: string[];
      forceRls: boolean;
      kind: string;
      owner: string;
      rls: boolean;
      runtimeHasGrantOptions: boolean;
      runtimePrivileges: string[];
      triggerCount: number;
      types: string[];
    }>(
      `SELECT relation.relkind AS kind,
              relation.relrowsecurity AS "rls",
              relation.relforcerowsecurity AS "forceRls",
              owner.rolname AS owner,
              ARRAY(
                SELECT attribute.attname
                  FROM pg_attribute AS attribute
                 WHERE attribute.attrelid = relation.oid
                   AND attribute.attnum > 0
                   AND NOT attribute.attisdropped
                 ORDER BY attribute.attnum
              ) AS columns,
              ARRAY(
                SELECT pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
                  FROM pg_attribute AS attribute
                 WHERE attribute.attrelid = relation.oid
                   AND attribute.attnum > 0
                   AND NOT attribute.attisdropped
                 ORDER BY attribute.attnum
              ) AS types,
              ARRAY(
                SELECT pg_get_constraintdef(constraint_row.oid)
                  FROM pg_constraint AS constraint_row
                 WHERE constraint_row.conrelid = relation.oid
                 ORDER BY constraint_row.conname
              ) AS constraints,
              ARRAY(
                SELECT DISTINCT privilege.grantee
                  FROM information_schema.table_privileges AS privilege
                WHERE privilege.table_schema = 'public'
                   AND privilege.table_name = 'rls_poc_operations'
                   AND privilege.grantee NOT IN (current_user::text, $1)
              ) AS "externalGrantees",
              ARRAY(
                SELECT DISTINCT privilege.privilege_type
                  FROM information_schema.table_privileges AS privilege
                 WHERE privilege.table_schema = 'public'
                   AND privilege.table_name = 'rls_poc_operations'
                   AND privilege.grantee = $1
                 ORDER BY privilege.privilege_type
              ) AS "runtimePrivileges",
              EXISTS (
                SELECT 1
                  FROM information_schema.table_privileges AS privilege
                 WHERE privilege.table_schema = 'public'
                   AND privilege.table_name = 'rls_poc_operations'
                   AND privilege.grantee = $1
                   AND privilege.is_grantable = 'YES'
              ) AS "runtimeHasGrantOptions",
              (
                SELECT count(*)::integer
                  FROM pg_trigger AS trigger_row
                 WHERE trigger_row.tgrelid = relation.oid
                   AND NOT trigger_row.tgisinternal
              ) AS "triggerCount"
         FROM pg_class AS relation
         JOIN pg_roles AS owner ON owner.oid = relation.relowner
        WHERE relation.oid = 'public.rls_poc_operations'::regclass`,
      [runtimeRole]
    );
    const policyResult = await pool.query<{
      checkExpression: string | null;
      command: string;
      includesPublic: boolean;
      name: string;
      permissive: boolean;
      usingExpression: string | null;
    }>(
      `SELECT policy.polname AS name,
              policy.polcmd AS command,
              policy.polpermissive AS permissive,
              0::oid = ANY(policy.polroles) AS "includesPublic",
              pg_get_expr(policy.polqual, policy.polrelid) AS "usingExpression",
              pg_get_expr(policy.polwithcheck, policy.polrelid) AS "checkExpression"
         FROM pg_policy AS policy
        WHERE policy.polrelid = 'public.rls_poc_operations'::regclass`
    );
    const [roleState] = roleResult.rows;
    const [tableState] = tableResult.rows;
    const [policy] = policyResult.rows;
    const normalizePolicyExpression = (expression: string) => {
      let normalized = expression
        .replaceAll('"', "")
        .replace(/::\s*text\b/g, "")
        .replace(/\((organization_id)\)/g, "$1")
        .replace(/\s+/g, "")
        .toLowerCase();

      while (normalized.startsWith("(") && normalized.endsWith(")")) {
        let depth = 0;
        let wrapsWholeExpression = true;
        for (let index = 0; index < normalized.length; index += 1) {
          if (normalized[index] === "(") {
            depth += 1;
          }
          if (normalized[index] === ")") {
            depth -= 1;
          }
          if (depth === 0 && index < normalized.length - 1) {
            wrapsWholeExpression = false;
            break;
          }
        }
        if (!wrapsWholeExpression) {
          break;
        }
        normalized = normalized.slice(1, -1);
      }

      return normalized;
    };
    const expectedPolicyExpression =
      "organization_id=current_setting('app.organization_id',true)";
    const expressionIsExpected = (expression: string | null | undefined) =>
      Boolean(
        expression &&
          normalizePolicyExpression(expression) === expectedPolicyExpression
      );

    if (
      !roleState ||
      roleState.superuser ||
      roleState.canCreateDatabase ||
      roleState.canCreateInSchema ||
      roleState.canCreateRole ||
      roleState.hasMemberships ||
      roleState.inherit ||
      !roleState.login ||
      roleState.bypassRls ||
      roleState.ownsTable ||
      !tableState ||
      tableState.kind !== "r" ||
      !tableState.rls ||
      !tableState.forceRls ||
      tableState.owner === runtimeRole ||
      tableState.columns.join(",") !== "organization_id,token,value" ||
      tableState.types.join(",") !== "text,text,text" ||
      tableState.externalGrantees.length !== 0 ||
      tableState.runtimePrivileges.join(",") !==
        "DELETE,INSERT,SELECT,UPDATE" ||
      tableState.runtimeHasGrantOptions ||
      tableState.constraints.length !== 1 ||
      tableState.constraints[0] !== "PRIMARY KEY (organization_id, token)" ||
      tableState.triggerCount !== 0 ||
      policyResult.rows.length !== 1 ||
      policy?.name !== "rls_poc_operations_organization_isolation" ||
      policy.command !== "*" ||
      !policy.permissive ||
      !policy.includesPublic ||
      !expressionIsExpected(policy.usingExpression) ||
      !expressionIsExpected(policy.checkExpression)
    ) {
      throw new Error(
        "Existing PR11 fixture does not match the expected safe recovery state; no database objects were changed."
      );
    }

    const expectedSeeds = [
      {
        organizationId: "org_a",
        token: "seed-a",
        value: "synthetic data for org_a",
      },
      {
        organizationId: "org_b",
        token: "seed-b",
        value: "synthetic data for org_b",
      },
    ] as const;
    const validationClient = await pool.connect();
    try {
      await validationClient.query("BEGIN");
      await validationClient.query("SET LOCAL row_security = off");
      const allFixtureRows = await validationClient.query<{
        organization_id: string;
        token: string;
        value: string;
      }>(
        `SELECT organization_id, token, value
           FROM public.rls_poc_operations
          ORDER BY organization_id, token`
      );
      if (
        allFixtureRows.rows.length !== expectedSeeds.length ||
        allFixtureRows.rows.some((fixtureRow, index) => {
          const seed = expectedSeeds[index];
          return (
            !seed ||
            fixtureRow.organization_id !== seed.organizationId ||
            fixtureRow.token !== seed.token ||
            fixtureRow.value !== seed.value
          );
        })
      ) {
        throw new Error(
          "Existing PR11 fixture must contain exactly the two expected synthetic seed rows."
        );
      }
      const assertSeed = async (seed: (typeof expectedSeeds)[number]) => {
        await validationClient.query("SELECT set_config($1, $2, true)", [
          "app.organization_id",
          seed.organizationId,
        ]);
        const result = await validationClient.query<{
          organization_id: string;
          token: string;
          value: string;
        }>(
          `SELECT organization_id, token, value
             FROM public.rls_poc_operations
            WHERE organization_id = $1`,
          [seed.organizationId]
        );
        if (
          result.rows.length !== 1 ||
          result.rows[0]?.organization_id !== seed.organizationId ||
          result.rows[0]?.token !== seed.token ||
          result.rows[0]?.value !== seed.value
        ) {
          throw new Error(
            "Existing PR11 fixture seeds do not match the expected synthetic rows."
          );
        }
      };
      const [orgASeed, orgBSeed] = expectedSeeds;
      await assertSeed(orgASeed);
      await assertSeed(orgBSeed);
      await validationClient.query("COMMIT");
    } catch (error) {
      await validationClient.query("ROLLBACK");
      throw error;
    } finally {
      validationClient.release();
    }
    console.log(
      "Resuming the verified PR11 fixture after an interrupted Hyperdrive bootstrap; rotating the runtime role password."
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

  if (isRecoverableFixture) {
    await pool.query(
      `ALTER ROLE ${runtimeRole}
         WITH LOGIN PASSWORD '${runtimePassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`
    );
  } else {
    await pool.query(
      `CREATE ROLE ${runtimeRole}
         LOGIN PASSWORD '${runtimePassword}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`
    );
  }
  await pool.query(
    `GRANT CONNECT ON DATABASE ${databaseName} TO ${runtimeRole}`
  );

  if (!isRecoverableFixture) {
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
  }
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
  await pool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE
       ON public.rls_poc_operations
       TO ${runtimeRole}`
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config($1, $2, true)", [
      "app.organization_id",
      "org_a",
    ]);
    await client.query(
      `INSERT INTO public.rls_poc_operations (organization_id, token, value)
       VALUES ('org_a', 'seed-a', 'synthetic data for org_a')
       ON CONFLICT (organization_id, token) DO NOTHING`
    );
    await client.query("SELECT set_config($1, $2, true)", [
      "app.organization_id",
      "org_b",
    ]);
    await client.query(
      `INSERT INTO public.rls_poc_operations (organization_id, token, value)
       VALUES ('org_b', 'seed-b', 'synthetic data for org_b')
       ON CONFLICT (organization_id, token) DO NOTHING`
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
    canCreateInSchema: boolean;
    ownsTable: boolean;
    superuser: boolean;
  }>(
    `SELECT role.rolsuper AS "superuser",
            role.rolbypassrls AS "bypassRls",
            EXISTS (
              SELECT 1
                FROM pg_namespace AS public_schema
               WHERE public_schema.nspname = 'public'
                 AND has_schema_privilege(role.oid, public_schema.oid, 'CREATE')
            ) AS "canCreateInSchema",
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
    security.canCreateInSchema ||
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
  const cf = spawnSync(
    cfRuntime.node,
    [cfRuntime.entry, "hyperdrive", "create", "--quiet", "--body", cfBody],
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
