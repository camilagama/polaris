/**
 * The local stack of verify-polaris: a PostgreSQL 18 (an own disposable cluster, or the owner URL of one given in
 * POLARIS_E2E_DATABASE_URL), a database made for this launch and migrated from zero, the deployable bundle in
 * `vite preview` (local workerd) through apps/web/e2e-real/serve.ts, and stores seeded through the Worker's own
 * `/rpc`. Runs under Bun (scripts/verify.sh calls it); serve.ts runs under Node 24.
 *
 * Usage: bun stack.ts launch [--runtime] [--assinatura] | doctor | seed <loja> | sql "<SELECT>" | cleanup
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createJourneyUser } from "../../../../apps/web/e2e-real/fixtures";
import { journeyClientIp } from "../../../../apps/web/e2e-real/journey-names";
import {
  createRunDatabase,
  dropRunDatabase,
  runDatabase,
  databaseUrl,
} from "../../../../apps/web/e2e-real/run-database";
import {
  ensureRunEnvironment,
  ownerDatabaseUrl,
  previewEnvironment,
  type RunEnvironment,
} from "../../../../apps/web/e2e-real/run-environment";
import {
  seedCashSale,
  seedProduct,
  seedStock,
  startCommandIds,
} from "../../../../apps/web/e2e-real/seed";
import { PREFERRED_ORGANIZATION_KEY } from "../../../../apps/web/src/lib/current-organization-model";
import { createDatabase } from "../../../../packages/db/src/client";
import { appendLeiame, commitLabel, evidenceDir } from "./leiame";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const webRoot = join(repoRoot, "apps/web");
const ZONE = "America/Sao_Paulo";
const LOJAS = ["vazia", "vendas", "limite", "pro"] as const;
type Loja = (typeof LOJAS)[number];
/** Worker secrets the offline runtime needs and the closed environment of the e2e-real does not carry. */
const RUNTIME_SECRETS = ["OFFLINE_LEASE_SECRET", "SYNC_PAYLOAD_HASH_SECRET"];
/** The variants of the Free plan (packages/domain/src/billing/entitlements.ts). */
const FREE_VARIANT_LIMIT = 50;
const LISTENER_PID = /pid=(\d+)/;
const PID_ENTRY = /^\d+$/;

interface Store {
  clientIp: string;
  name: string;
  organizationId: string;
  storageState: string;
  userId: string;
}

interface State {
  /** BILLING_SELF_SERVICE_ENABLED on in the preview (the Assinatura tab reads the plan; checkout needs a provider). */
  billing: boolean;
  build?: { head: string; source: string };
  createdRuntimeRole?: boolean;
  database?: boolean;
  id: string;
  owner: string;
  pg?: { data: string; port: number };
  port: number;
  project: string;
  run: RunEnvironment;
  runtime: boolean;
  servePid?: number;
  /** Ports this instance reserved under /tmp/polaris-verify/ports (the preview's and the cluster's). */
  ports?: number[];
  /** The role `verify.sh sql` reads as: read-all and BYPASSRLS, never superuser. */
  reader?: string;
  /** Seeding attempts per store: a failed seed leaves its user behind, the next one takes a new name. */
  attempts?: Partial<Record<Loja, number>>;
  stores: Partial<Record<Loja, Store>>;
}

const id = process.env.VERIFY_ID ?? "";
if (!/^[a-z0-9-]+$/.test(id)) {
  throw new Error("VERIFY_ID is missing: run through scripts/verify.sh.");
}
const stateDir = process.env.VERIFY_STATE_DIR ?? `/tmp/polaris-verify/${id}`;
const statePath = join(stateDir, "state.json");

function log(message: string): void {
  console.log(`[verify-polaris] ${message}`);
}

function readState(): State | undefined {
  return existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, "utf8")) as State)
    : undefined;
}

function writeState(state: State): void {
  mkdirSync(stateDir, { mode: 0o700, recursive: true });
  // the run secret and the login passwords of a throwaway database: readable by this user only
  writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(statePath, 0o600);
}

function requireState(): State {
  const state = readState();
  if (!state) {
    throw new Error(`No instance for ${id}: run "verify.sh launch" first.`);
  }
  return state;
}

/** Puts the run values where e2e-real's helpers read them (the fixtures read process.env). */
function exportRun(state: State): void {
  process.env.CI = "true";
  process.env.POLARIS_E2E_DATABASE_URL = state.owner;
  process.env.E2E_RUN_ID = state.run.runId;
  process.env.E2E_RUN_SECRET = state.run.secret;
  for (const [binding, password] of Object.entries(state.run.passwords)) {
    process.env[`E2E_LOGIN_PASSWORD_${binding}`] = password;
  }
}

function origin(state: State): string {
  return `http://127.0.0.1:${state.port}`;
}

function alive(pid: number | undefined): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
  });
}

const portsDir = join(dirname(stateDir), "ports");

/**
 * Reserves a port for this instance: an atomic `mkdir` under /tmp/polaris-verify/ports, so two worktrees launching
 * at once never pick the same one while the first is still building. A reservation whose instance has no state any
 * more is stale and taken over.
 */
function reservePort(port: number): boolean {
  const lock = join(portsDir, String(port));
  mkdirSync(portsDir, { recursive: true });
  try {
    mkdirSync(lock);
  } catch {
    const owner = existsSync(join(lock, "owner"))
      ? readFileSync(join(lock, "owner"), "utf8")
      : "";
    if (
      owner !== id &&
      existsSync(join(dirname(stateDir), owner, "state.json"))
    ) {
      return false;
    }
  }
  writeFileSync(join(lock, "owner"), id);
  return true;
}

function releasePorts(state: State): void {
  for (const port of state.ports ?? []) {
    const lock = join(portsDir, String(port));
    if (
      existsSync(join(lock, "owner")) &&
      readFileSync(join(lock, "owner"), "utf8") === id
    ) {
      rmSync(lock, { force: true, recursive: true });
    }
  }
}

async function freePort(
  state: State,
  wanted: string | undefined,
  from: number
): Promise<number> {
  const candidates = wanted
    ? [Number(wanted)]
    : Array.from({ length: 400 }, (_, index) => from + index);
  for (const port of candidates) {
    // biome-ignore lint/performance/noAwaitInLoops: the first free port, in order
    if ((await portIsFree(port)) && reservePort(port)) {
      state.ports = [...(state.ports ?? []), port];
      writeState(state);
      return port;
    }
  }
  throw new Error(
    wanted
      ? `Port ${wanted} is taken: choose another one.`
      : `No free port from ${from}.`
  );
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** HEAD and a hash of every change of the worktree under apps/ and packages/ (tracked and untracked). */
function sourceVersion(): { head: string; source: string } {
  const head = git(["rev-parse", "HEAD"]).trim();
  const hash = createHash("sha256");
  hash.update(git(["diff", "HEAD", "--binary", "--", "apps", "packages"]));
  const untracked = git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "apps",
    "packages",
  ])
    .split("\n")
    .filter(Boolean)
    .sort();
  for (const file of untracked) {
    hash.update(file);
    hash.update(readFileSync(join(repoRoot, file)));
  }
  return { head, source: hash.digest("hex") };
}

function pgBinary(name: string): string {
  const dir = process.env.PG_BIN;
  return dir ? join(dir, name) : name;
}

function runPg(args: string[], what: string): void {
  const [command, ...rest] = args as [string, ...string[]];
  const result = spawnSync(pgBinary(command), rest, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${what} failed: ${result.stderr || result.stdout}`);
  }
}

/** An own PostgreSQL cluster in the state directory, on the loopback only, with a password for its owner. */
async function startOwnCluster(state: State): Promise<string> {
  const data = join(stateDir, "pg");
  const port = await freePort(state, process.env.VERIFY_PG_PORT, 55_400);
  const password = randomBytes(24).toString("hex");
  const passwordFile = join(stateDir, "pg-password");
  writeFileSync(passwordFile, password, { mode: 0o600 });
  runPg(
    [
      "initdb",
      "-D",
      data,
      "-U",
      "verify_owner",
      "--auth=scram-sha-256",
      `--pwfile=${passwordFile}`,
      "--encoding=UTF8",
      "--locale=C.UTF-8",
    ],
    "initdb"
  );
  rmSync(passwordFile);
  state.pg = { data, port };
  writeState(state);
  runPg(
    [
      "pg_ctl",
      "-D",
      data,
      "-l",
      join(stateDir, "pg.log"),
      "-o",
      `-p ${port} -c listen_addresses=127.0.0.1 -k ${stateDir}`,
      "-w",
      "start",
    ],
    "pg_ctl start"
  );
  return `postgresql://verify_owner:${password}@127.0.0.1:${port}/postgres`;
}

function startPreview(state: State): ChildProcess {
  const logFile = openSync(join(stateDir, "preview.log"), "a");
  const node = process.env.VERIFY_NODE ?? "node";
  const env = previewEnvironment(
    new URL(state.owner),
    state.run,
    origin(state),
    state.runtime
  );
  if (state.billing) {
    // only this local preview: the top of wrangler.jsonc keeps it off, as production does today
    env.BILLING_SELF_SERVICE_ENABLED = "true";
    env.E2E_PREVIEW_VARIABLES = `${env.E2E_PREVIEW_VARIABLES},BILLING_SELF_SERVICE_ENABLED`;
  }
  if (state.runtime) {
    // the keys the Worker signs the offline lease and hashes the commands of `sync.push` with, made from the secret of
    // the run and thrown away with it. Without them a Pro store also gets "Offline indisponível neste aparelho"
    // (issueLease answers 503) and a sale kept on the device is never accepted (sync.push answers 503)
    for (const name of RUNTIME_SECRETS) {
      env[name] = createHash("sha256")
        .update(`${name}:${state.run.secret}`)
        .digest("hex");
    }
    env.E2E_PREVIEW_VARIABLES = `${env.E2E_PREVIEW_VARIABLES},${RUNTIME_SECRETS.join(",")}`;
  }
  const child = spawn(
    node,
    ["e2e-real/serve.ts", state.project, String(state.port)],
    {
      cwd: webRoot,
      detached: true,
      env,
      stdio: ["ignore", logFile, logFile],
    }
  );
  child.unref();
  return child;
}

async function waitForHealth(state: State, child: ChildProcess) {
  const deadline = Date.now() + 480_000;
  let exited: number | null = null;
  child.once("exit", (code) => {
    exited = code ?? 1;
  });
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(
        `The preview exited (${exited}) before answering. Log: ${join(stateDir, "preview.log")}`
      );
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: polled until it answers
      const response = await fetch(`${origin(state)}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // not listening yet: the build comes first
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw new Error("The preview did not answer /health in 8 min.");
}

function localOwnerUrl(url: string): string {
  return ownerDatabaseUrl({
    CI: "true",
    POLARIS_E2E_DATABASE_URL: url,
  }).toString();
}

async function withOwnerPool<T>(
  owner: string,
  database: string,
  work: (pool: ReturnType<typeof createDatabase>["pool"]) => Promise<T>
): Promise<T> {
  const { pool } = createDatabase(databaseUrl(new URL(owner), database), {
    maxConnections: 1,
  });
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
}

/** The role the e2e harness creates when the cluster lacks it (run-database.ts); the gates job creates it too. */
function runtimeRoleExists(owner: string): Promise<boolean> {
  return withOwnerPool(owner, "postgres", async (pool) => {
    const { rows } = await pool.query(
      "SELECT 1 FROM pg_roles WHERE rolname = 'polaris_pr11_runtime'"
    );
    return rows.length > 0;
  });
}

/**
 * The role of `verify.sh sql`: reads every table (pg_read_all_data) and past the row policies (BYPASSRLS), but is
 * no superuser, so pg_read_file, COPY TO PROGRAM and the like are refused. Not `polaris_*`: the migrations check
 * the grants of that prefix.
 */
async function createReader(state: State): Promise<string> {
  const reader = `verify_reader_${state.run.runId}`;
  await withOwnerPool(state.owner, "postgres", async (pool) => {
    await pool.query(
      `CREATE ROLE ${reader} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS`
    );
    await pool.query(`GRANT pg_read_all_data TO ${reader}`);
  });
  writeState({ ...state, reader });
  return reader;
}

async function launch(runtime: boolean, billing: boolean): Promise<void> {
  const existing = readState();
  if (existing) {
    throw new Error(
      `An instance of ${id} exists (${statePath}): "verify.sh doctor" to use it, "verify.sh cleanup" to remove it.`
    );
  }
  const node = spawnSync(process.env.VERIFY_NODE ?? "node", ["--version"], {
    encoding: "utf8",
  });
  if (!node.stdout?.startsWith("v24.")) {
    throw new Error(
      "Node 24 is required for vite preview (miniflare under Bun never answers): set VERIFY_NODE."
    );
  }
  // the e2e harness's own guard: only localhost or 127.0.0.1, never Neon, before anything is created
  const external = process.env.POLARIS_E2E_DATABASE_URL
    ? localOwnerUrl(process.env.POLARIS_E2E_DATABASE_URL)
    : undefined;
  const run = ensureRunEnvironment({});
  const state: State = {
    billing,
    id,
    owner: "",
    port: 0,
    project: runtime ? "verify-runtime" : "verify",
    run,
    runtime,
    stores: {},
  };
  writeState(state);
  state.port = await freePort(state, process.env.VERIFY_PORT, 4400);
  state.owner = external ?? localOwnerUrl(await startOwnCluster(state));
  writeState(state);
  exportRun(state);
  log(`database e2e_${run.runId}: create and migrate`);
  // known before the run creates it: a migration that fails afterwards still leaves cleanup knowing to drop it
  state.createdRuntimeRole = !(await runtimeRoleExists(state.owner));
  state.database = true;
  writeState(state);
  await createRunDatabase(new URL(state.owner), run);
  state.reader = await createReader(state);
  state.build = sourceVersion();
  writeState(state);
  log(
    `build ${state.project} and preview on ${origin(state)} (log ${join(stateDir, "preview.log")})`
  );
  const child = startPreview(state);
  if (child.pid === undefined) {
    throw new Error("the preview process did not start: see preview.log");
  }
  state.servePid = child.pid;
  writeState(state);
  await waitForHealth(state, child);
  log("preview answers /health");
  await seed(state, "vazia");
  log(`ready: ${origin(state)}`);
}

/* -------------------------------------------------------------------------- */
/* Stores                                                                     */
/* -------------------------------------------------------------------------- */

type StoreUser = Awaited<ReturnType<typeof createJourneyUser>>;

async function createStore(
  state: State,
  loja: Loja
): Promise<{ store: Store; user: StoreUser }> {
  const attempt = state.attempts?.[loja] ?? 0;
  state.attempts = { ...state.attempts, [loja]: attempt + 1 };
  writeState(state);
  const name = `qa-verify-${loja}-t${attempt}`;
  const user = await quietly(() => createJourneyUser(origin(state), name));
  const created = await user.rpc.organization.createInitial({
    name,
    timezone: ZONE,
  });
  const organizationId = created.organization.id;
  const storageState = join(stateDir, `loja-${loja}.json`);
  writeFileSync(
    storageState,
    JSON.stringify({
      cookies: user.cookies.map((cookie) => ({
        ...cookie,
        expires: cookie.expires ?? -1,
      })),
      origins: [
        {
          localStorage: [
            { name: PREFERRED_ORGANIZATION_KEY, value: organizationId },
          ],
          origin: origin(state),
        },
      ],
    }),
    { mode: 0o600 }
  );
  return {
    store: {
      clientIp: journeyClientIp(name),
      name,
      organizationId,
      storageState,
      userId: user.id,
    },
    user,
  };
}

function isoDay(daysAgo: number): { at: string; on: string } {
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  const on = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(at);
  return { at: at.toISOString(), on };
}

/** Three products with price and stock, and eight cash sales over the last seven days. */
async function seedSales(user: StoreUser, store: Store) {
  startCommandIds(`verify/${store.name}`);
  const today = isoDay(0).on;
  const catalog = [
    { name: "Camiseta básica", price: "59.90", stock: 30 },
    { name: "Caneca esmaltada", price: "35.00", stock: 20 },
    { name: "Vela aromática", price: "45.00", stock: 15 },
  ];
  const variants: { price: string; variantId: string }[] = [];
  for (const item of catalog) {
    // biome-ignore lint/performance/noAwaitInLoops: one command after the other, as the screens send them
    const product = await seedProduct(
      user.rpc,
      store.organizationId,
      item.name,
      item.price
    );
    await seedStock(
      user.rpc,
      store.organizationId,
      product.variantId,
      item.stock,
      "12.00",
      today
    );
    variants.push({ price: item.price, variantId: product.variantId });
  }
  const plan = [0, 0, 1, 2, 3, 4, 5, 6];
  for (const [index, daysAgo] of plan.entries()) {
    const variant = variants[index % variants.length] as (typeof variants)[0];
    // biome-ignore lint/performance/noAwaitInLoops: the sales in order of time
    await seedCashSale(
      user.rpc,
      store.organizationId,
      [
        {
          price: variant.price,
          quantity: 1 + (index % 2),
          variantId: variant.variantId,
        },
      ],
      isoDay(daysAgo).at
    );
  }
}

/** The Free plan at its limit: exactly as many active variants as the plan allows. */
async function seedLimit(user: StoreUser, store: Store) {
  for (let index = 1; index <= FREE_VARIANT_LIMIT; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: one command after the other (the limit of 120 writes a minute)
    await seedProduct(
      user.rpc,
      store.organizationId,
      `Produto ${String(index).padStart(2, "0")}`,
      "10.00"
    );
  }
}

/**
 * A paid store: two products with stock and the billing record of an active Pro subscription written straight into
 * the run database. No provider, no checkout and no webhook exist in this stack, and the plan reads only this record
 * (state `active` with the end of the access), so it is the same row the billing lifecycle would leave. Pro is what
 * allows offline writes, which the Free stores refuse.
 */
async function seedPro(state: State, user: StoreUser, store: Store) {
  startCommandIds(`verify/${store.name}`);
  const today = isoDay(0).on;
  for (const item of [
    { name: "Camiseta básica", price: "59.90", stock: 30 },
    { name: "Caneca esmaltada", price: "35.00", stock: 20 },
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one command after the other, as the screens send them
    const product = await seedProduct(
      user.rpc,
      store.organizationId,
      item.name,
      item.price
    );
    await seedStock(
      user.rpc,
      store.organizationId,
      product.variantId,
      item.stock,
      "12.00",
      today
    );
  }
  const { pool } = runDatabase(new URL(state.owner), state.run);
  try {
    await pool.query(
      `INSERT INTO organization_billing (organization_id, state, access_ends_at, cycle_months)
       VALUES ($1, 'active', now() + interval '365 days', 1)
       ON CONFLICT (organization_id) DO UPDATE
         SET state = 'active', access_ends_at = now() + interval '365 days', cycle_months = 1,
             updated_at = now(), version = organization_billing.version + 1`,
      [store.organizationId]
    );
  } finally {
    await pool.end();
  }
}

async function seed(state: State, loja: Loja): Promise<void> {
  if (state.stores[loja]) {
    log(`loja ${loja} already seeded`);
    return;
  }
  exportRun(state);
  const { store, user } = await createStore(state, loja);
  if (loja === "vendas") {
    await seedSales(user, store);
  } else if (loja === "limite") {
    await seedLimit(user, store);
  } else if (loja === "pro") {
    await seedPro(state, user, store);
  }
  state.stores[loja] = store;
  writeState(state);
  log(`loja ${loja}: ${store.name} (organization ${store.organizationId})`);
}

/** Better Auth in this process logs every sign-in it signs: the seed's output keeps only its own lines. */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const { info, log: print, warn } = console;
  console.info = () => undefined;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    return await work();
  } finally {
    Object.assign(console, { info, log: print, warn });
  }
}

/* -------------------------------------------------------------------------- */
/* Read-only SQL                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One query on the run database, as the reader role, inside a READ ONLY transaction that is rolled back: the side
 * effect of a drive (a row inserted, a balance), never a way to make state. The extended protocol takes a single
 * statement, so `COMMIT; INSERT ...` cannot end the transaction. Kept in the evidence with a line in LEIAME.md.
 */
async function readOnlySql(query: string): Promise<void> {
  const state = requireState();
  if (!state.reader) {
    throw new Error(
      "This instance has no reader role: cleanup and launch again."
    );
  }
  exportRun(state);
  const { pool } = runDatabase(new URL(state.owner), state.run);
  const client = await pool.connect();
  let result: { rows: unknown[] };
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL ROLE ${state.reader}`);
    // pg runs a bare text query on the simple protocol unless queryMode says otherwise (the typings lack the field)
    const request = { queryMode: "extended", text: query };
    result = await client.query(request);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
  }
  const output = JSON.stringify(result.rows, null, 2);
  console.log(output);
  const file = `sql/${Date.now()}.txt`;
  mkdirSync(join(evidenceDir(), "sql"), { recursive: true });
  writeFileSync(join(evidenceDir(), file), `${query}\n\n${output}\n`);
  appendLeiame({
    address: "",
    file,
    loja: "",
    project: "banco do run (só leitura)",
    sha: commitLabel(),
    state: `consulta: ${query.slice(0, 120)}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Doctor                                                                     */
/* -------------------------------------------------------------------------- */

/** The pid listening on the port (ss), or undefined. */
function listenerPid(port: number): number | undefined {
  const result = spawnSync("ss", ["-ltnpH", `sport = :${port}`], {
    encoding: "utf8",
  });
  const match = LISTENER_PID.exec(result.stdout ?? "");
  return match ? Number(match[1]) : undefined;
}

function parentOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return undefined;
  }
}

function descendsFrom(pid: number | undefined, ancestor: number): boolean {
  let current = pid;
  for (let depth = 0; current && current > 1 && depth < 10; depth += 1) {
    if (current === ancestor) {
      return true;
    }
    current = parentOf(current);
  }
  return false;
}

type Check = [string, boolean, string];

async function servedBuild(state: State): Promise<Check> {
  const built = join(webRoot, "dist-e2e", state.project, "client/index.html");
  const served = await fetch(`${origin(state)}/`)
    .then((response) => response.text())
    .catch(() => "");
  const assets = (html: string) =>
    [...html.matchAll(/\/assets\/[\w.-]+\.js/g)]
      .map((match) => match[0])
      .sort();
  const same =
    existsSync(built) &&
    assets(served).join() === assets(readFileSync(built, "utf8")).join() &&
    assets(served).length > 0;
  return [`the preview serves dist-e2e/${state.project}`, same, built];
}

function buildIsCurrent(state: State): Check {
  const now = sourceVersion();
  const same =
    state.build?.head === now.head && state.build?.source === now.source;
  return [
    "the build is the worktree's (HEAD and local changes)",
    same,
    same
      ? now.head.slice(0, 12)
      : `built ${state.build?.head.slice(0, 12)}, worktree ${now.head.slice(0, 12)} or changed files: cleanup and launch again`,
  ];
}

async function storeChecks(state: State): Promise<Check[]> {
  const checks: Check[] = [];
  const { pool } = runDatabase(new URL(state.owner), state.run);
  try {
    for (const [loja, store] of Object.entries(state.stores)) {
      const cookie = (
        JSON.parse(readFileSync(store.storageState, "utf8")) as {
          cookies: { name: string; value: string }[];
        }
      ).cookies
        .map((item) => `${item.name}=${item.value}`)
        .join("; ");
      // biome-ignore lint/performance/noAwaitInLoops: a few stores, one after the other
      const session = (await fetch(`${origin(state)}/api/auth/get-session`, {
        headers: { "cf-connecting-ip": store.clientIp, cookie },
      })
        .then((response) => response.json())
        .catch(() => null)) as { user?: { id?: string } } | null;
      checks.push([
        `loja ${loja}: the session signs in`,
        session?.user?.id === store.userId,
        store.name,
      ]);
      const { rows } = await pool.query<{
        members: number;
        plan: string | null;
        sales: number;
        variants: number;
      }>(
        `SELECT (SELECT count(*)::int FROM memberships WHERE organization_id = $1 AND user_id = $2) AS members,
                (SELECT state FROM organization_billing WHERE organization_id = $1) AS plan,
                (SELECT count(*)::int FROM sales WHERE organization_id = $1) AS sales,
                (SELECT count(*)::int FROM product_variants v JOIN products p ON p.id = v.product_id
                  WHERE p.organization_id = $1) AS variants`,
        [store.organizationId, store.userId]
      );
      const row = rows[0] ?? { members: 0, plan: null, sales: 0, variants: 0 };
      checks.push([
        `loja ${loja}: seeded`,
        row.members === 1 && seededAsExpected(loja as Loja, row),
        `${row.variants} variantes, ${row.sales} vendas, plano ${row.plan ?? "free"}`,
      ]);
    }
  } finally {
    await pool.end();
  }
  return checks;
}

function seededAsExpected(
  loja: Loja,
  row: { plan: string | null; sales: number; variants: number }
): boolean {
  if (loja === "pro") {
    return row.variants >= 2 && row.plan === "active";
  }
  if (loja === "vendas") {
    return row.variants >= 3 && row.sales >= 8;
  }
  if (loja === "limite") {
    return row.variants >= FREE_VARIANT_LIMIT;
  }
  return true;
}

async function doctor(): Promise<boolean> {
  const state = requireState();
  exportRun(state);
  const checks: Check[] = [];
  checks.push([
    "the instance process is alive",
    alive(state.servePid),
    `pid ${state.servePid}`,
  ]);
  const listener = listenerPid(state.port);
  checks.push([
    `port ${state.port} belongs to this instance`,
    state.servePid !== undefined && descendsFrom(listener, state.servePid),
    `listener pid ${listener ?? "none"}`,
  ]);
  const health = await fetch(`${origin(state)}/health`)
    .then((response) => response.json())
    .catch(() => null);
  checks.push([
    "/health answers ok",
    (health as { status?: string } | null)?.status === "ok",
    origin(state),
  ]);
  checks.push(await servedBuild(state));
  checks.push(buildIsCurrent(state));
  if (Object.keys(state.stores).length === 0) {
    checks.push(["at least one store is seeded", false, "seed vazia"]);
  }
  checks.push(
    ...(await storeChecks(state).catch((error: unknown): Check[] => [
      ["the run database answers", false, String(error)],
    ]))
  );
  for (const [what, ok, detail] of checks) {
    console.log(`${ok ? "ok  " : "FAIL"} ${what} (${detail})`);
  }
  const healthy = checks.every(([, ok]) => ok);
  console.log(
    healthy
      ? `DOCTOR OK ${origin(state)} build ${state.project}`
      : "DOCTOR FAIL: do not drive this instance"
  );
  return healthy;
}

/* -------------------------------------------------------------------------- */
/* Cleanup                                                                    */
/* -------------------------------------------------------------------------- */

/** The processes of a process group, by /proc (the 5th field of `stat`), with their command lines. */
function groupMembers(group: number): { cmdline: string; pid: number }[] {
  const members: { cmdline: string; pid: number }[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!PID_ENTRY.test(entry)) {
      continue;
    }
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === group) {
        const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
        members.push({
          cmdline: cmdline.replaceAll("\0", " "),
          pid: Number(entry),
        });
      }
    } catch {
      // the process ended while it was read
    }
  }
  return members;
}

/**
 * Stops the process group launch started (serve.ts, vite preview, workerd), even when serve.ts itself is gone, and
 * only when the group is still this instance's: a recycled pid of someone else's group is left alone.
 */
async function stopPreview(state: State) {
  const group = state.servePid;
  if (!group) {
    return;
  }
  const ours = (members: { cmdline: string }[]) =>
    members.some(
      (member) =>
        member.cmdline.includes(`serve.ts ${state.project} ${state.port}`) ||
        member.cmdline.includes(`dist-e2e/${state.project} `)
    );
  if (!ours(groupMembers(group))) {
    return;
  }
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-group, name);
    } catch {
      // the group is already gone
    }
  };
  signal("SIGTERM");
  for (let wait = 0; wait < 30 && groupMembers(group).length > 0; wait += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: waits for the group to go
    await new Promise((done) => setTimeout(done, 500));
  }
  signal("SIGKILL");
}

function removeBuild(state: State) {
  rmSync(join(webRoot, "dist-e2e", state.project), {
    force: true,
    recursive: true,
  });
  // the deploy pointer the plugin wrote for the preview: a later `wrangler deploy` must not follow it
  const pointer = join(webRoot, ".wrangler/deploy/config.json");
  if (
    existsSync(pointer) &&
    readFileSync(pointer, "utf8").includes(`dist-e2e/${state.project}/`)
  ) {
    rmSync(join(webRoot, ".wrangler/deploy"), { force: true, recursive: true });
  }
  const builds = join(webRoot, "dist-e2e");
  if (existsSync(builds) && readdirSync(builds).length === 0) {
    rmSync(builds, { force: true, recursive: true });
  }
}

/** The scratch drives go to the evidence before they are removed: a drive that never ran is not lost. */
function keepLocalDrives(): void {
  const local = join(repoRoot, ".claude/skills/verify-polaris/drives/local");
  if (!existsSync(local)) {
    return;
  }
  const kept = join(evidenceDir(), "drives");
  mkdirSync(kept, { recursive: true });
  for (const file of readdirSync(local)) {
    copyFileSync(join(local, file), join(kept, file));
  }
  rmSync(local, { force: true, recursive: true });
}

async function cleanup(): Promise<void> {
  const state = readState();
  if (!state) {
    log(`nothing to clean for ${id}`);
    return;
  }
  await stopPreview(state);
  if (state.database && state.owner) {
    exportRun(state);
    await dropRunDatabase(
      new URL(state.owner),
      state.run,
      state.createdRuntimeRole === true
    ).catch((error: unknown) => {
      if (!state.pg) {
        throw error;
      }
      // the own cluster goes away whole below
    });
  }
  const { reader } = state;
  if (reader && !state.pg) {
    await withOwnerPool(state.owner, "postgres", (pool) =>
      pool.query(`DROP ROLE IF EXISTS ${reader}`)
    );
  }
  if (state.pg && existsSync(join(state.pg.data, "postmaster.pid"))) {
    const stopped = spawnSync(
      pgBinary("pg_ctl"),
      ["-D", state.pg.data, "-m", "fast", "-w", "stop"],
      { encoding: "utf8" }
    );
    if (stopped.status !== 0) {
      throw new Error(
        `pg_ctl stop failed, state kept in ${stateDir}: ${stopped.stderr}`
      );
    }
  }
  removeBuild(state);
  const free = state.port === 0 || (await portIsFree(state.port));
  keepLocalDrives();
  releasePorts(state);
  rmSync(stateDir, { force: true, recursive: true });
  log(
    free
      ? `cleaned ${id}: preview stopped, database dropped, port ${state.port} free`
      : `cleaned ${id}, but port ${state.port} still answers: look with ss -ltnp`
  );
}

/* -------------------------------------------------------------------------- */

const [command, argument] = process.argv.slice(2);
try {
  if (command === "launch") {
    await launch(
      process.argv.includes("--runtime"),
      process.argv.includes("--assinatura")
    );
    process.exit((await doctor()) ? 0 : 1);
  } else if (command === "doctor") {
    process.exit((await doctor()) ? 0 : 1);
  } else if (command === "seed") {
    if (!LOJAS.includes(argument as Loja)) {
      throw new Error(`usage: seed ${LOJAS.join("|")}`);
    }
    await seed(requireState(), argument as Loja);
    process.exit(0);
  } else if (command === "sql") {
    if (!argument) {
      throw new Error('usage: sql "SELECT ..."');
    }
    await readOnlySql(argument);
    process.exit(0);
  } else if (command === "cleanup") {
    await cleanup();
    process.exit(0);
  } else {
    throw new Error(
      "usage: stack.ts launch [--runtime] [--assinatura] | doctor | seed <loja> | sql <query> | cleanup"
    );
  }
} catch (error) {
  const cause = error instanceof Error ? error.cause : undefined;
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `[verify-polaris] ${message}${cause instanceof Error ? `\ncause: ${cause.message}` : ""}`
  );
  process.exit(1);
}
