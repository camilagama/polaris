import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { PolarisRpcClient } from "@polaris/contracts";
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

interface TemporaryLogin {
  baseRole: string;
  connectionString: string;
  name: string;
  password: string;
}

const expectedHostnamePattern =
  /^ep-[a-z-]+-[a-z0-9]+\.c-2\.sa-east-1\.aws\.neon\.tech$/;
const temporaryRoleNamePattern = /^polaris_g2_[a-z0-9_]+$/;
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const sensitiveValues = new Set<string>();

function redact(value: string): string {
  let result = value;
  for (const secret of sensitiveValues) {
    if (secret.length > 0) {
      result = result.replaceAll(secret, "[redacted]");
    }
  }
  return result;
}

function summarizeError(error: unknown): string {
  const visited = new Set<object>();
  const details: string[] = [];
  let current = error;
  while (typeof current === "object" && current !== null) {
    if (visited.has(current)) {
      break;
    }
    visited.add(current);
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      message?: unknown;
      name?: unknown;
    };
    details.push(
      `${String(candidate.name ?? "Error")}[${String(candidate.code ?? "-")}]: ${String(candidate.message ?? "")}`
    );
    current = candidate.cause;
  }
  return redact(details.join(" <- ")).slice(-2000);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error("Missing Gate 2 Worker configuration.");
  }
  return value;
}

function hasRpcCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function rpcClient(workerUrl: URL, authHeaders?: Headers): PolarisRpcClient {
  const link = new RPCLink({
    method: "POST",
    url: new URL("/rpc", workerUrl),
    fetch: (request) => {
      if (!authHeaders) {
        return fetch(request);
      }
      const requestHeaders = new Headers(request.headers);
      authHeaders.forEach((value, key) => {
        requestHeaders.set(key, value);
      });
      return fetch(new Request(request, { headers: requestHeaders }));
    },
  });
  return createORPCClient(link);
}

function quoteTemporaryRole(name: string): string {
  if (!temporaryRoleNamePattern.test(name)) {
    throw new Error("Invalid temporary Gate 2 role name.");
  }
  return `"${name}"`;
}

async function createTemporaryLogin(
  pool: ReturnType<typeof createDatabase>["pool"],
  connectionString: string,
  baseRole: "polaris_pr11_runtime" | "polaris_onboarding_runtime",
  purpose: "tenant" | "onboarding"
): Promise<TemporaryLogin> {
  const name = `polaris_g2_${purpose}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const password = randomBytes(32).toString("hex");
  const validUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const identifier = quoteTemporaryRole(name);
  sensitiveValues.add(password);

  await pool.query(
    `CREATE ROLE ${identifier} WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}' VALID UNTIL '${validUntil}'`
  );
  try {
    await pool.query(`GRANT ${baseRole} TO ${identifier}`);
  } catch (error) {
    await pool.query(`DROP ROLE IF EXISTS ${identifier}`);
    throw error;
  }

  const roleUrl = new URL(connectionString);
  roleUrl.username = name;
  roleUrl.password = password;
  const roleConnectionString = roleUrl.toString();
  sensitiveValues.add(roleConnectionString);

  const { pool: rolePool } = createDatabase(roleConnectionString, {
    connectionTimeoutMillis: 5000,
    maxConnections: 1,
  });
  let roleProbeFailed = false;
  let roleProbeError: unknown;
  try {
    const result = await rolePool.query<{
      categoryInsert: boolean;
      categoryDelete: boolean;
      categorySelect: boolean;
      categoryUpdate: boolean;
      productSelect: boolean;
      productInsert: boolean;
      productUpdate: boolean;
      productDelete: boolean;
      variantSelect: boolean;
      variantInsert: boolean;
      variantUpdate: boolean;
      variantDelete: boolean;
      currentUser: string;
      functionExecute: boolean;
      member: boolean;
    }>(
      'SELECT current_user AS "currentUser", ' +
        "pg_has_role(current_user, $1, 'MEMBER') AS member, " +
        "has_table_privilege(current_user, 'public.categories', 'SELECT') AS \"categorySelect\", " +
        "has_table_privilege(current_user, 'public.categories', 'INSERT') AS \"categoryInsert\", " +
        "has_table_privilege(current_user, 'public.categories', 'UPDATE') AS \"categoryUpdate\", " +
        "has_table_privilege(current_user, 'public.categories', 'DELETE') AS \"categoryDelete\", " +
        "has_table_privilege(current_user, 'public.products', 'SELECT') AS \"productSelect\", " +
        "has_table_privilege(current_user, 'public.products', 'INSERT') AS \"productInsert\", " +
        "has_table_privilege(current_user, 'public.products', 'UPDATE') AS \"productUpdate\", " +
        "has_table_privilege(current_user, 'public.products', 'DELETE') AS \"productDelete\", " +
        "has_table_privilege(current_user, 'public.product_variants', 'SELECT') AS \"variantSelect\", " +
        "has_table_privilege(current_user, 'public.product_variants', 'INSERT') AS \"variantInsert\", " +
        "has_table_privilege(current_user, 'public.product_variants', 'UPDATE') AS \"variantUpdate\", " +
        "has_table_privilege(current_user, 'public.product_variants', 'DELETE') AS \"variantDelete\", " +
        "EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace " +
        "WHERE n.nspname = 'public' AND p.proname = 'create_initial_organization' " +
        "AND has_function_privilege(current_user, p.oid, 'EXECUTE')) AS \"functionExecute\"",
      [baseRole]
    );
    const [row] = result.rows;
    assert.ok(row);
    assert.equal(row.currentUser, name);
    assert.equal(row.member, true);
    if (baseRole === "polaris_pr11_runtime") {
      assert.deepEqual(
        [
          row.categorySelect,
          row.categoryInsert,
          row.categoryUpdate,
          row.categoryDelete,
          row.productSelect,
          row.productInsert,
          row.productUpdate,
          row.productDelete,
          row.variantSelect,
          row.variantInsert,
          row.variantUpdate,
          row.variantDelete,
          row.functionExecute,
        ],
        [
          true,
          true,
          true,
          false,
          true,
          true,
          true,
          false,
          true,
          true,
          false,
          true,
          false,
        ]
      );
    } else {
      assert.deepEqual(
        [
          row.categorySelect,
          row.categoryInsert,
          row.categoryUpdate,
          row.categoryDelete,
          row.productSelect,
          row.productInsert,
          row.productUpdate,
          row.productDelete,
          row.variantSelect,
          row.variantInsert,
          row.variantUpdate,
          row.variantDelete,
          row.functionExecute,
        ],
        [
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          true,
        ]
      );
    }
  } catch (error) {
    roleProbeFailed = true;
    roleProbeError = error;
  } finally {
    await rolePool.end();
  }
  if (roleProbeFailed) {
    await pool.query(`REVOKE ${baseRole} FROM ${identifier}`);
    await pool.query(`DROP ROLE IF EXISTS ${identifier}`);
    throw roleProbeError;
  }

  return { baseRole, connectionString: roleConnectionString, name, password };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local Worker port."));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function workerEnvironment(
  tenantConnectionString: string,
  onboardingConnectionString: string,
  baseURL: string,
  secret: string
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const inheritedEnvironmentNames = new Set([
    "APPDATA",
    "BUN_CONFIG_DIR",
    "BUN_INSTALL",
    "HOME",
    "LOCALAPPDATA",
    "PATH",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR",
  ]);

  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      inheritedEnvironmentNames.has(name.toUpperCase())
    ) {
      environment[name] = value;
    }
  }

  return {
    // Local Hyperdrive emulation opens direct Neon connections during cold start.
    AUTH_DATABASE_CONNECT_TIMEOUT_MS: "30000",
    ...environment,
    BETTER_AUTH_BASE_URL: baseURL,
    BETTER_AUTH_SECRET: secret,
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:
      tenantConnectionString,
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_ONBOARDING_HYPERDRIVE:
      onboardingConnectionString,
  };
}

function startLocalWorker(
  port: number,
  tenantConnectionString: string,
  onboardingConnectionString: string,
  baseURL: string,
  secret: string
): ChildProcess {
  return spawn(
    process.execPath,
    [
      "run",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: appRoot,
      env: workerEnvironment(
        tenantConnectionString,
        onboardingConnectionString,
        baseURL,
        secret
      ),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
}

async function waitForLocalWorker(
  worker: ChildProcess,
  workerUrl: URL,
  workerOutput: () => string,
  getStartError: () => Error | undefined
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const startError = getStartError();
    if (startError) {
      throw new Error(
        `Local Worker could not start: ${redact(startError.message)}`
      );
    }
    if (worker.exitCode !== null || worker.signalCode !== null) {
      throw new Error(
        `Local Worker exited before readiness. ${redact(workerOutput()).slice(-4000)}`
      );
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Readiness polling must stay sequential.
      const response = await fetch(new URL("/health", workerUrl), {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // The Vite and Workers runtimes need a short startup window.
    }
    await sleep(250);
  }

  throw new Error(
    `Local Worker readiness timed out. ${redact(workerOutput()).slice(-4000)}`
  );
}

async function stopLocalWorker(
  worker: ChildProcess | undefined
): Promise<void> {
  if (
    !worker ||
    worker.exitCode !== null ||
    worker.signalCode !== null ||
    worker.pid === undefined
  ) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/PID", String(worker.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true }
      );
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
  } else {
    worker.kill("SIGTERM");
  }

  if (worker.exitCode === null && worker.signalCode === null) {
    await Promise.race([
      new Promise<void>((resolve) => worker.once("exit", () => resolve())),
      sleep(5000),
    ]);
  }
  if (worker.exitCode === null && worker.signalCode === null) {
    worker.kill("SIGKILL");
  }
}

async function dropTemporaryLogin(
  pool: ReturnType<typeof createDatabase>["pool"],
  role: TemporaryLogin
): Promise<void> {
  const identifier = quoteTemporaryRole(role.name);
  await pool.query(`REVOKE ${role.baseRole} FROM ${identifier}`);
  await pool.query(`DROP ROLE IF EXISTS ${identifier}`);
}

async function main() {
  const connectionString = requiredEnvironment(
    "POLARIS_GATE2_TEST_DATABASE_URL"
  );
  if (
    process.env.POLARIS_GATE2_TEST_CONFIRM_DISPOSABLE !== "gate2-runtime-proof"
  ) {
    throw new Error(
      "Set POLARIS_GATE2_TEST_CONFIRM_DISPOSABLE=gate2-runtime-proof only for the auto-expiring disposable Neon branch."
    );
  }

  const databaseUrl = new URL(connectionString);
  assert.equal(databaseUrl.pathname, "/neondb");
  assert.equal(databaseUrl.hostname.includes("-pooler"), false);
  assert.match(databaseUrl.hostname, expectedHostnamePattern);
  sensitiveValues.add(connectionString);
  sensitiveValues.add(databaseUrl.password);

  const { db, pool } = createDatabase(connectionString, { maxConnections: 3 });
  const fixtureUsers: string[] = [];
  const fixtureOrganizations: string[] = [];
  const temporaryLogins: TemporaryLogin[] = [];
  const cleanupErrors: unknown[] = [];
  let helpers: TestAuthHelpers | undefined;
  let worker: ChildProcess | undefined;
  let workerOutput = "";
  let workerStartError: Error | undefined;
  let workerGatePassed = false;

  try {
    const server = await pool.query<{ database: string; version: string }>(
      "SELECT current_database() AS database, " +
        "current_setting('server_version') AS version"
    );
    assert.equal(server.rows[0]?.database, "neondb");
    assert.equal(
      Number.parseInt(server.rows[0]?.version.split(".")[0] ?? "", 10),
      18
    );

    const runtimeLogin = await createTemporaryLogin(
      pool,
      connectionString,
      "polaris_pr11_runtime",
      "tenant"
    );
    temporaryLogins.push(runtimeLogin);
    const onboardingLogin = await createTemporaryLogin(
      pool,
      connectionString,
      "polaris_onboarding_runtime",
      "onboarding"
    );
    temporaryLogins.push(onboardingLogin);
    console.log("gate2_worker_temporary_roles=passed");

    const port = await availablePort();
    const workerUrl = new URL(`http://127.0.0.1:${port}`);
    const baseURL = workerUrl.origin;
    const secret = randomBytes(32).toString("hex");
    sensitiveValues.add(secret);
    worker = startLocalWorker(
      port,
      runtimeLogin.connectionString,
      onboardingLogin.connectionString,
      baseURL,
      secret
    );
    worker.stdout?.on("data", (chunk: Buffer) => {
      workerOutput = `${workerOutput}${chunk.toString("utf8")}`.slice(-16_000);
    });
    worker.stderr?.on("data", (chunk: Buffer) => {
      workerOutput = `${workerOutput}${chunk.toString("utf8")}`.slice(-16_000);
    });
    worker.once("error", (error: Error) => {
      workerStartError = error;
    });
    await waitForLocalWorker(
      worker,
      workerUrl,
      () => workerOutput,
      () => workerStartError
    );
    console.log("gate2_worker_local_runtime=ready");

    const testPlugin = testUtils() as unknown as BetterAuthPlugin;
    const auth = createBetterAuth({
      baseURL,
      database: db,
      plugins: [testPlugin],
      secret,
    });
    helpers = (
      (await auth.$context) as unknown as {
        test: TestAuthHelpers;
      }
    ).test;

    const runId = randomUUID();
    const userA = await helpers.saveUser(
      helpers.createUser({
        email: `gate2-${runId}-user-a@example.invalid`,
        emailVerified: true,
        name: "Gate 2 User A",
      })
    );
    fixtureUsers.push(userA.id);
    const userB = await helpers.saveUser(
      helpers.createUser({
        email: `gate2-${runId}-user-b@example.invalid`,
        emailVerified: true,
        name: "Gate 2 User B",
      })
    );
    fixtureUsers.push(userB.id);
    const userUnverified = await helpers.saveUser(
      helpers.createUser({
        email: `gate2-${runId}-unverified@example.invalid`,
        emailVerified: false,
        name: "Gate 2 Unverified",
      })
    );
    fixtureUsers.push(userUnverified.id);

    const loginA = await helpers.login({ userId: userA.id });
    const loginB = await helpers.login({ userId: userB.id });
    const loginUnverified = await helpers.login({ userId: userUnverified.id });
    const anonymousClient = rpcClient(workerUrl);
    const clientA = rpcClient(workerUrl, loginA.headers);
    const clientB = rpcClient(workerUrl, loginB.headers);
    const unverifiedClient = rpcClient(workerUrl, loginUnverified.headers);
    console.log("gate2_worker_auth_fixtures=passed");

    await assert.rejects(
      anonymousClient.category.list({ organizationId: randomUUID() }),
      (error: unknown) => hasRpcCode(error, "UNAUTHORIZED"),
      "anonymous category list must be unauthorized"
    );
    console.log("gate2_worker_anonymous_denial=passed");

    const organizationA = await clientA.organization
      .createInitial({
        name: "Gate 2 Tenant A",
        timezone: "America/Sao_Paulo",
      })
      .catch((error: unknown) => {
        console.error(
          "gate2_worker_organization_a_error",
          summarizeError(error)
        );
        throw error;
      });
    fixtureOrganizations.push(organizationA.organization.id);
    assert.equal(organizationA.created, true);
    assert.equal(organizationA.organization.currency, "BRL");
    console.log("gate2_worker_organization_a=passed");

    const retryA = await clientA.organization.createInitial({
      name: "Changed retry",
      timezone: "Etc/UTC",
    });
    assert.equal(retryA.created, false);
    assert.equal(retryA.organization.id, organizationA.organization.id);
    assert.equal(retryA.organization.name, "Gate 2 Tenant A");
    console.log("gate2_worker_onboarding_retry=passed");

    const organizationB = await clientB.organization.createInitial({
      name: "Gate 2 Tenant B",
      timezone: "America/Sao_Paulo",
    });
    fixtureOrganizations.push(organizationB.organization.id);
    console.log("gate2_worker_organization_b=passed");

    await assert.rejects(
      unverifiedClient.organization.createInitial({
        name: "Unverified",
        timezone: "America/Sao_Paulo",
      }),
      (error: unknown) => hasRpcCode(error, "FORBIDDEN"),
      "unverified organization onboarding must be forbidden"
    );
    console.log("gate2_worker_unverified_denial=passed");

    const categoryA = await clientA.category.create({
      organizationId: organizationA.organization.id,
      name: "  Escritório  ",
    });
    assert.equal(categoryA.name, "Escritório");
    assert.equal(categoryA.status, "active");
    assert.equal(typeof categoryA.createdAt, "string");
    console.log("gate2_worker_category_a_create=passed");
    const sameNameInOtherOrganization = await clientB.category.create({
      organizationId: organizationB.organization.id,
      name: "Escritório",
    });
    assert.equal(sameNameInOtherOrganization.name, categoryA.name);
    console.log("gate2_worker_same_name_other_organization=passed");
    const renameConflictCategory = await clientA.category.create({
      organizationId: organizationA.organization.id,
      name: "Outro",
    });
    console.log("gate2_worker_same_organization_conflict_fixture=passed");
    await assert.rejects(
      clientA.category.create({
        organizationId: organizationA.organization.id,
        name: "escritório",
      }),
      (error: unknown) => hasRpcCode(error, "CONFLICT"),
      "duplicate category create in one organization must conflict"
    );
    await assert.rejects(
      clientA.category.rename({
        id: categoryA.id,
        name: "outro",
        organizationId: organizationA.organization.id,
      }),
      (error: unknown) => hasRpcCode(error, "CONFLICT"),
      "rename to a name in the same organization must conflict"
    );
    const renameConflictCleanup = await pool.query(
      "DELETE FROM public.categories WHERE id = $1 AND organization_id = $2",
      [renameConflictCategory.id, organizationA.organization.id]
    );
    assert.equal(renameConflictCleanup.rowCount, 1);
    const renamedCategory = await clientA.category.rename({
      id: categoryA.id,
      name: "Acessórios",
      organizationId: organizationA.organization.id,
    });
    assert.equal(renamedCategory.changed, true);
    assert.equal(renamedCategory.category.name, "Acessórios");
    console.log("gate2_worker_rename=passed");
    const renameRetry = await clientA.category.rename({
      id: categoryA.id,
      name: "Acessórios",
      organizationId: organizationA.organization.id,
    });
    assert.equal(renameRetry.changed, false);
    const categoriesA = await clientA.category.list({
      organizationId: organizationA.organization.id,
    });
    assert.deepEqual(categoriesA.categories, [renamedCategory.category]);
    const categoriesB = await clientB.category.list({
      organizationId: organizationB.organization.id,
    });
    assert.deepEqual(categoriesB.categories, [sameNameInOtherOrganization]);
    console.log("gate2_worker_tenant_category_lists=passed");

    await assert.rejects(
      clientA.category.list({
        organizationId: organizationB.organization.id,
      }),
      (error: unknown) => hasRpcCode(error, "FORBIDDEN"),
      "cross-tenant category list must be forbidden"
    );
    await assert.rejects(
      clientA.category.create({
        organizationId: organizationB.organization.id,
        name: "Cross-tenant",
      }),
      (error: unknown) => hasRpcCode(error, "FORBIDDEN"),
      "cross-tenant category create must be forbidden"
    );

    const productA = await clientA.product.create({
      categoryId: categoryA.id,
      description: "  ",
      name: "Bolsa",
      organizationId: organizationA.organization.id,
    });
    assert.equal(productA.description, null);
    assert.equal(productA.categoryId, categoryA.id);
    assert.equal(productA.status, "active");
    assert.equal(productA.version, 1);
    const duplicateProductA = await clientA.product.create({
      name: "Bolsa",
      organizationId: organizationA.organization.id,
    });
    const productB = await clientB.product.create({
      categoryId: sameNameInOtherOrganization.id,
      name: "Bolsa",
      organizationId: organizationB.organization.id,
    });
    assert.notEqual(productA.id, duplicateProductA.id);
    assert.equal(productA.name, duplicateProductA.name);
    assert.equal(productB.name, productA.name);

    const defaultVariants = await pool.query<{
      product_id: string;
      variant_count: string;
      all_default: boolean;
      id_version: number;
    }>(
      "SELECT product_id::text, count(*)::text AS variant_count, " +
        "bool_and(is_default) AS all_default, " +
        "min(uuid_extract_version(id)) AS id_version " +
        "FROM public.product_variants WHERE product_id = ANY($1::uuid[]) " +
        "GROUP BY product_id ORDER BY product_id",
      [[productA.id, duplicateProductA.id, productB.id]]
    );
    assert.equal(defaultVariants.rows.length, 3);
    assert.ok(
      defaultVariants.rows.every(
        (row) =>
          row.variant_count === "1" && row.all_default && row.id_version === 7
      )
    );
    console.log("gate2_worker_product_create_default_variant_uuidv7=passed");

    const productsA = await clientA.product.list({
      organizationId: organizationA.organization.id,
    });
    assert.deepEqual(
      productsA.products.map((product) => product.id).sort(),
      [productA.id, duplicateProductA.id].sort()
    );
    const productsB = await clientB.product.list({
      organizationId: organizationB.organization.id,
    });
    assert.deepEqual(
      productsB.products.map((product) => product.id),
      [productB.id]
    );
    await assert.rejects(
      clientA.product.list({
        organizationId: organizationB.organization.id,
      }),
      (error: unknown) => hasRpcCode(error, "FORBIDDEN"),
      "cross-tenant product list must be forbidden"
    );
    await assert.rejects(
      clientA.product.create({
        categoryId: sameNameInOtherOrganization.id,
        name: "Categoria cruzada",
        organizationId: organizationA.organization.id,
      }),
      (error: unknown) => hasRpcCode(error, "CONFLICT"),
      "product cannot use a category owned by another organization"
    );
    console.log(
      "gate2_worker_product_tenant_isolation_and_duplicate_names=passed"
    );

    const updatedProduct = await clientA.product.update({
      categoryId: categoryA.id,
      description: "Lona resistente",
      expectedVersion: 1,
      id: productA.id,
      name: "Bolsa transversal",
      organizationId: organizationA.organization.id,
    });
    assert.equal(updatedProduct.changed, true);
    assert.equal(updatedProduct.product.version, 2);
    await assert.rejects(
      clientA.product.update({
        categoryId: categoryA.id,
        description: "Concorrência obsoleta",
        expectedVersion: 1,
        id: productA.id,
        name: "Bolsa antiga",
        organizationId: organizationA.organization.id,
      }),
      (error: unknown) => hasRpcCode(error, "CONFLICT"),
      "stale product version must conflict"
    );
    const archivedProduct = await clientA.product.archive({
      expectedVersion: 2,
      id: productA.id,
      organizationId: organizationA.organization.id,
    });
    assert.equal(archivedProduct.changed, true);
    assert.equal(archivedProduct.product.status, "archived");
    assert.equal(archivedProduct.product.version, 3);
    const productArchiveRetry = await clientA.product.archive({
      expectedVersion: 2,
      id: productA.id,
      organizationId: organizationA.organization.id,
    });
    assert.equal(productArchiveRetry.changed, false);
    const archivedProducts = await clientA.product.list({
      organizationId: organizationA.organization.id,
      status: "archived",
    });
    assert.deepEqual(
      archivedProducts.products.map((product) => product.id),
      [productA.id]
    );
    const restoredProduct = await clientA.product.restore({
      expectedVersion: 3,
      id: productA.id,
      organizationId: organizationA.organization.id,
    });
    assert.equal(restoredProduct.changed, true);
    assert.equal(restoredProduct.product.status, "active");
    assert.equal(restoredProduct.product.version, 4);

    await assert.rejects(
      clientA.category.delete({
        id: categoryA.id,
        organizationId: organizationA.organization.id,
      }),
      (error: unknown) => hasRpcCode(error, "CONFLICT"),
      "category tombstone must be blocked while a product references it"
    );
    const unlinkedProduct = await clientA.product.update({
      categoryId: null,
      description: "Lona resistente",
      expectedVersion: 4,
      id: productA.id,
      name: "Bolsa transversal",
      organizationId: organizationA.organization.id,
    });
    assert.equal(unlinkedProduct.changed, true);
    assert.equal(unlinkedProduct.product.categoryId, null);
    assert.equal(unlinkedProduct.product.version, 5);

    const variantProduct = await clientA.product.create({
      name: "Produto com combinações explícitas",
      organizationId: organizationA.organization.id,
    });
    const variantConfiguration = await clientA.product.configureVariants({
      expectedVersion: 1,
      id: variantProduct.id,
      options: [
        { name: "color", values: ["Azul", "Preto"] },
        { name: "size", values: ["P", "M"] },
      ],
      organizationId: organizationA.organization.id,
      variants: [
        { values: { color: "Azul", size: "P" } },
        { values: { color: "Azul", size: "M" } },
        { values: { color: "Preto", size: "M" } },
      ],
    });
    assert.equal(variantConfiguration.product.version, 2);
    assert.equal(variantConfiguration.configuration.configured, true);
    assert.equal(variantConfiguration.configuration.variants.length, 3);
    assert.deepEqual(
      variantConfiguration.configuration.variants.map((variant) =>
        variant.values.map((value) => value.optionValueName)
      ),
      [
        ["Azul", "P"],
        ["Azul", "M"],
        ["Preto", "M"],
      ]
    );
    const rereadVariants = await clientA.product.getVariants({
      id: variantProduct.id,
      organizationId: organizationA.organization.id,
    });
    assert.deepEqual(rereadVariants, variantConfiguration.configuration);
    const variantAudit = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM public.tenant_audit_event " +
        "WHERE entity_id = $1 ORDER BY event_type",
      [variantProduct.id]
    );
    assert.deepEqual(
      variantAudit.rows.map((row) => row.event_type),
      ["product.created", "product.variants_configured"]
    );
    await assert.rejects(
      clientA.product.configureVariants({
        expectedVersion: 2,
        id: variantProduct.id,
        options: [{ name: "model", values: ["Modelo novo"] }],
        organizationId: organizationA.organization.id,
        variants: [{ values: { model: "Modelo novo" } }],
      }),
      (error: unknown) => hasRpcCode(error, "CONFLICT"),
      "configured variants cannot be replaced in PR26"
    );
    await assert.rejects(
      clientB.product.getVariants({
        id: variantProduct.id,
        organizationId: organizationB.organization.id,
      }),
      (error: unknown) => hasRpcCode(error, "NOT_FOUND"),
      "cross-tenant product variants are not visible"
    );
    console.log("gate2_worker_product_variants_explicit_and_audited=passed");
    console.log(
      "gate2_worker_product_update_lifecycle_and_tombstone_guard=passed"
    );

    const archivedCategory = await clientA.category.archive({
      id: categoryA.id,
      organizationId: organizationA.organization.id,
    });
    assert.equal(archivedCategory.changed, true);
    assert.equal(archivedCategory.category.status, "archived");
    const activeAfterArchive = await clientA.category.list({
      organizationId: organizationA.organization.id,
    });
    assert.deepEqual(activeAfterArchive.categories, []);
    const archivedCategories = await clientA.category.list({
      organizationId: organizationA.organization.id,
      status: "archived",
    });
    assert.deepEqual(archivedCategories.categories, [
      archivedCategory.category,
    ]);
    const archiveRetry = await clientA.category.archive({
      id: categoryA.id,
      organizationId: organizationA.organization.id,
    });
    assert.equal(archiveRetry.changed, false);

    const restoredCategory = await clientA.category.restore({
      id: categoryA.id,
      organizationId: organizationA.organization.id,
    });
    assert.equal(restoredCategory.changed, true);
    assert.equal(restoredCategory.category.status, "active");

    const deletedCategory = await clientA.category.delete({
      id: categoryA.id,
      organizationId: organizationA.organization.id,
    });
    assert.equal(deletedCategory.changed, true);
    assert.equal(deletedCategory.category.status, "deleted");
    await assert.rejects(
      clientA.category.restore({
        id: categoryA.id,
        organizationId: organizationA.organization.id,
      }),
      (error: unknown) => hasRpcCode(error, "CONFLICT"),
      "deleted category cannot be restored"
    );
    await assert.rejects(
      clientA.category.rename({
        id: categoryA.id,
        name: "Outro nome",
        organizationId: organizationA.organization.id,
      }),
      (error: unknown) => hasRpcCode(error, "CONFLICT"),
      "deleted category cannot be renamed"
    );
    await assert.rejects(
      clientA.category.create({
        organizationId: organizationA.organization.id,
        name: "acessórios",
      }),
      (error: unknown) => hasRpcCode(error, "CONFLICT"),
      "tombstoned category name remains reserved"
    );
    const tombstones = await clientA.category.list({
      organizationId: organizationA.organization.id,
      status: "all",
    });
    assert.deepEqual(tombstones.categories, [deletedCategory.category]);
    const deleteRetry = await clientA.category.delete({
      id: categoryA.id,
      organizationId: organizationA.organization.id,
    });
    assert.equal(deleteRetry.changed, false);
    console.log("gate2_worker_category_lifecycle=passed");

    const organizationEvents = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.tenant_audit_event " +
        "WHERE event_type = 'organization.created' " +
        "AND organization_id = ANY($1::text[])",
      [[organizationA.organization.id, organizationB.organization.id]]
    );
    assert.equal(organizationEvents.rows[0]?.count, "2");
    const categoryEvents = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.tenant_audit_event " +
        "WHERE event_type = 'category.created' AND organization_id = $1",
      [organizationA.organization.id]
    );
    assert.equal(categoryEvents.rows[0]?.count, "2");
    const lifecycleEvents = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.tenant_audit_event " +
        "WHERE event_type IN ('category.renamed', 'category.archived', 'category.restored', 'category.deleted') " +
        "AND entity_id = $1",
      [categoryA.id]
    );
    assert.equal(lifecycleEvents.rows[0]?.count, "4");
    const productLifecycleEvents = await pool.query<{
      event_type: string;
      count: string;
    }>(
      "SELECT event_type, count(*)::text AS count " +
        "FROM public.tenant_audit_event WHERE entity_id = $1 " +
        "GROUP BY event_type ORDER BY event_type",
      [productA.id]
    );
    assert.deepEqual(productLifecycleEvents.rows, [
      { event_type: "product.archived", count: "1" },
      { event_type: "product.created", count: "1" },
      { event_type: "product.restored", count: "1" },
      { event_type: "product.updated", count: "2" },
    ]);

    workerGatePassed = true;
    console.log("gate2_worker_authentication=passed");
    console.log("gate2_worker_onboarding_and_retry=passed");
    console.log(
      "gate2_worker_category_rename_lifecycle_and_offline_read=passed"
    );
    console.log("gate2_worker_unique_names_capability_and_audit=passed");
    console.log("gate2_worker_products_audit_and_tenant_lifecycle=passed");
  } finally {
    try {
      await stopLocalWorker(worker);
    } catch (error) {
      cleanupErrors.push(error);
    }

    try {
      if (fixtureUsers.length > 0) {
        await pool.query(
          "DELETE FROM public.organizations WHERE id = ANY($1::text[]) " +
            "OR id IN (SELECT organization_id FROM public.memberships " +
            "WHERE user_id = ANY($2::text[]))",
          [fixtureOrganizations, fixtureUsers]
        );
      }
    } catch (error) {
      cleanupErrors.push(error);
    }

    if (helpers && fixtureUsers.length > 0) {
      const userCleanup = await Promise.allSettled(
        fixtureUsers.map((userId) => helpers?.deleteUser(userId))
      );
      for (const result of userCleanup) {
        if (result.status === "rejected") {
          cleanupErrors.push(result.reason);
        }
      }
    }

    const roleCleanup = await Promise.allSettled(
      temporaryLogins.map((role) => dropTemporaryLogin(pool, role))
    );
    for (const result of roleCleanup) {
      if (result.status === "rejected") {
        cleanupErrors.push(result.reason);
      }
    }

    if (!workerGatePassed && workerOutput.length > 0) {
      console.error(
        "gate2_worker_runtime_logs",
        redact(workerOutput).slice(-4000)
      );
    }
    await pool.end();
    if (cleanupErrors.length > 0) {
      process.exitCode = 1;
      console.error("gate2_worker_cleanup=failed", cleanupErrors.length);
    }
    workerOutput = "";
  }
}

main()
  .then(() => sensitiveValues.clear())
  .catch((error: unknown) => {
    const message = redact(
      error instanceof Error ? error.message : "unknown error"
    );
    console.error(
      "gate2_worker=failed",
      error instanceof Error ? error.name : "UnknownError",
      message
    );
    process.exitCode = 1;
    sensitiveValues.clear();
  });
