import assert from "node:assert/strict";

/**
 * How a gate runs against the job's Postgres when the owner is not a superuser (as on Neon) and a superuser URL is
 * given for the cases only a superuser can plant.
 *
 * - `only`: the gate needs a superuser by design (it creates what only one may), so it runs as the superuser.
 * - `also`: the gate proves part of its cases only as a superuser, so it runs as the owner and again as the superuser.
 *
 * Without the URL every gate runs once, as the owner.
 */
export type SuperuserNeed = "also" | "only";

export interface GateRun {
  asSuperuser: boolean;
  label: string;
  /** The owner run of an `also` gate: the superuser run that proves the rest comes right after. */
  superuserRunFollows: boolean;
}

export const AS_SUPERUSER = "POLARIS_GATE_AS_SUPERUSER";
export const SUPERUSER_RUN_FOLLOWS = "POLARIS_GATE_SUPERUSER_RUN_FOLLOWS";

export function runsOf(
  name: string,
  need: SuperuserNeed | undefined,
  hasSuperuserUrl: boolean
): GateRun[] {
  if (!(need && hasSuperuserUrl)) {
    return [{ asSuperuser: false, label: name, superuserRunFollows: false }];
  }
  if (need === "only") {
    return [{ asSuperuser: true, label: name, superuserRunFollows: false }];
  }
  return [
    { asSuperuser: false, label: name, superuserRunFollows: true },
    {
      asSuperuser: true,
      label: `${name} (superuser)`,
      superuserRunFollows: false,
    },
  ];
}

/** The markers a run hands its gate, so the gate can tell which run it is in. */
export function runMarkers(run: GateRun): Record<string, string> {
  return {
    ...(run.asSuperuser ? { [AS_SUPERUSER]: "1" } : {}),
    ...(run.superuserRunFollows ? { [SUPERUSER_RUN_FOLLOWS]: "1" } : {}),
  };
}

/**
 * For an `also` gate, at the point where it skips what only a superuser proves: a run meant as the superuser must be
 * one, and in CI a run that is not one must be followed by the superuser run, or the skipped cases are proved nowhere.
 */
export function assertSuperuserCasesProved(
  isSuperuser: boolean,
  gate: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (env[AS_SUPERUSER] === "1") {
    assert.equal(
      isSuperuser,
      true,
      `${gate}: the superuser run is not connected as a superuser`
    );
  }
  if (!isSuperuser && env.CI === "true") {
    assert.equal(
      env[SUPERUSER_RUN_FOLLOWS],
      "1",
      `${gate}: in CI the cases only a superuser proves need the owner to be one or a superuser run after this one`
    );
  }
}

export const SUPERUSER_URL = "POLARIS_GATE_SUPERUSER_URL";

export const CI_SUPERUSER_FIX =
  "in CI, set POLARIS_GATE_SUPERUSER_URL in the gates step and create the owner without superuser (see .github/workflows/ci.yml; by hand with CI=true, runbook gate-4, step 1)";

const runOnlyMarkers = [SUPERUSER_URL, AS_SUPERUSER, SUPERUSER_RUN_FOLLOWS];

/**
 * The environment a gate child inherits: the superuser URL and the run markers are the executor's to set per child, so
 * a value exported in the shell never reaches a gate.
 */
export function inheritedEnvironment(
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !runOnlyMarkers.includes(name))
  );
}

/**
 * Fail-closed setup of the job's Postgres: against the local Postgres of the CI the executor needs the superuser URL
 * and an owner that is not a superuser, so a job that loses the URL or gets a superuser owner back stops instead of
 * running the whole suite as a superuser. Outside the CI the owner is whatever the machine has.
 */
export function assertCiOwnerSetup(input: {
  hasSuperuserUrl: boolean;
  isLocalCi: boolean;
  ownerIsSuperuser: boolean;
}): void {
  if (!input.isLocalCi) {
    return;
  }
  if (!input.hasSuperuserUrl) {
    throw new Error(
      `POLARIS_GATE_SUPERUSER_URL is required against the local Postgres of the CI${
        input.ownerIsSuperuser ? ", and the owner is a superuser" : ""
      }: ${CI_SUPERUSER_FIX}.`
    );
  }
  if (input.ownerIsSuperuser) {
    throw new Error(
      `The owner of POLARIS_GATE_DATABASE_URL must not be a superuser: ${CI_SUPERUSER_FIX}.`
    );
  }
}

/**
 * `assertCiOwnerSetup` with the owner's superuser flag read only where it decides something: outside the local Postgres
 * of the CI the check returns before looking at it, so the probe is not run there.
 */
export async function checkCiOwnerSetup(input: {
  hasSuperuserUrl: boolean;
  isLocalCi: boolean;
  ownerIsSuperuser: () => Promise<boolean>;
}): Promise<void> {
  assertCiOwnerSetup({
    hasSuperuserUrl: input.hasSuperuserUrl,
    isLocalCi: input.isLocalCi,
    ownerIsSuperuser: input.isLocalCi ? await input.ownerIsSuperuser() : false,
  });
}

/**
 * Runs `work`, then `cleanup`. A failure of `cleanup` never hides the failure of `work`: it goes to `onCleanupError`
 * and the error of `work` is the one that propagates. After a successful `work`, a failure of `cleanup` propagates.
 */
export async function runThenCleanUp<T>(
  work: () => Promise<T>,
  cleanup: () => Promise<void>,
  onCleanupError: (error: unknown) => void
): Promise<T> {
  let result: T;
  try {
    result = await work();
  } catch (error) {
    await cleanup().catch(onCleanupError);
    throw error;
  }
  await cleanup();
  return result;
}

/**
 * Gates that never share the cluster with another gate: they run after the parallel ones, one at a time, in the
 * database the job migrated, in the order of the runner's list.
 *
 * Roles are objects of the cluster, not of a database, so a copy of the database isolates the tables but not the roles.
 * A gate is here, with the reason, when it does one of these (a gate with a `superuser` need is serial too, see
 * `runsSerially`):
 * - `grant`: grants a role to the session user (`withGateRole`, `becomeGateRole`, `queryAsFunctionOwner`,
 *   `replaceFunctionAsOwner`), in its script or in a gate helper it imports: two gates with the same role would revoke
 *   it under each other;
 * - `cluster`: reads the roles or memberships of the cluster as a whole (`pg_roles`, `pg_auth_members`, `pg_has_role`
 *   over a list, `pg_locks` without the database), where the temporary logins of a gate in another database would show
 *   up, or acts on the cluster itself (a database of its own, the backends of the server, a local server: `rls`);
 * - `order`: depends on the gates before it, or reads every store it finds (the activation gates, the Workers' gates and the
 *   notices last), or wants the database as the migrations left it (`rls-forced-catalog`, first).
 * When in doubt, a gate goes here.
 */
export type SerialReason = "cluster" | "grant" | "order";

export const SERIAL_GATES: Readonly<Record<string, SerialReason>> = {
  "access-log": "grant",
  "access-log-login": "grant",
  "activation-candidates": "grant",
  "activation-funnel": "order",
  "activation-returns": "grant",
  "activation-sweep": "order",
  "admin-diagnostics": "cluster",
  "admin-support": "cluster",
  "admin-worker": "order",
  "audit-retention": "grant",
  "auth-tables-row-security": "grant",
  "billing-notices": "order",
  "billing-self-service": "grant",
  "billing-trial-claims": "cluster",
  "catalog-worker": "order",
  "closed-organization-readonly": "grant",
  customers: "cluster",
  "definer-hardening": "grant",
  "definer-owners": "grant",
  "deletion-ledger": "grant",
  "device-sessions": "grant",
  "environment-marker": "cluster",
  "gate2-runtime": "grant",
  inventory: "cluster",
  "legal-acceptance": "grant",
  "login-lock": "grant",
  "media-derivatives": "cluster",
  "migrations-without-superuser": "cluster",
  "organization-purge": "grant",
  "read-models": "grant",
  "renewal-cancellation": "grant",
  rls: "cluster",
  "rls-forced-catalog": "order",
  "scheduled-jobs": "cluster",
  "tenant-context": "grant",
  "unverified-user-purge": "grant",
  "web-worker": "order",
};

export function runsSerially(
  name: string,
  need: SuperuserNeed | undefined
): boolean {
  return need !== undefined || Object.hasOwn(SERIAL_GATES, name);
}

export interface PlannedRun<G> {
  gate: G;
  run: GateRun;
}

/**
 * Splits the runs of the selected gates, in their order, into the ones that share a queue across the copies of the
 * database and the ones that run afterwards, one at a time, in the migrated database. With one worker every run is
 * serial, in one database and in order.
 */
export function planGateRuns<
  G extends { name: string; superuser?: SuperuserNeed },
>(
  gates: readonly G[],
  hasSuperuserUrl: boolean,
  workers: number
): { parallel: PlannedRun<G>[]; serial: PlannedRun<G>[] } {
  const parallel: PlannedRun<G>[] = [];
  const serial: PlannedRun<G>[] = [];
  for (const gate of gates) {
    const target =
      workers > 1 && !runsSerially(gate.name, gate.superuser)
        ? parallel
        : serial;
    for (const run of runsOf(gate.name, gate.superuser, hasSuperuserUrl)) {
      target.push({ gate, run });
    }
  }
  return { parallel, serial };
}

export const GATE_WORKERS = "POLARIS_GATE_WORKERS";
const DEFAULT_LOCAL_WORKERS = 4;
const MAX_WORKERS = 8;
const workerCount = /^[1-9]\d*$/;

/**
 * How many copies of the database the parallel gates share: 4 against the local Postgres of the job, 1 (every gate in
 * one database, in order) against Neon, where the runner creates no database. `POLARIS_GATE_WORKERS` overrides it
 * locally; against Neon only 1 is accepted.
 */
export function gateWorkers(env: NodeJS.ProcessEnv, isLocal: boolean): number {
  const raw = env[GATE_WORKERS];
  if (raw === undefined || raw === "") {
    return isLocal ? DEFAULT_LOCAL_WORKERS : 1;
  }
  const value = workerCount.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= 1 && value <= MAX_WORKERS)) {
    throw new Error(
      `${GATE_WORKERS} must be a whole number from 1 to ${MAX_WORKERS}.`
    );
  }
  if (value > 1 && !isLocal) {
    throw new Error(
      `${GATE_WORKERS} above 1 is for a local Postgres only: against Neon the gates run in one database.`
    );
  }
  return value;
}

/** The copy of the migrated database a worker runs its gates in. */
export function copyDatabaseName(database: string, worker: number): string {
  return `${database}_p${worker}`;
}

/** The same URL, pointed at another database of the same host. */
export function urlForDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

/**
 * Runs `work` over `items` with `workers` loops that each take the next item of one shared queue, so a long gate never
 * holds back the queue of another worker. The results keep the order of `items`. A rejected `work` stops nothing: the
 * runner's `work` turns a failed gate into a result, so a rejection is a broken runner and propagates once all end.
 */
export async function drainQueue<T, R>(
  items: readonly T[],
  workers: number,
  work: (item: T, worker: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const loop = async (worker: number) => {
    while (next < items.length) {
      const index = next;
      next += 1;
      // biome-ignore lint/performance/noAwaitInLoops: each worker runs its gates one at a time in its own database
      results[index] = await work(items[index] as T, worker);
    }
  };
  const loops = Array.from(
    { length: Math.max(1, Math.min(workers, items.length)) },
    (_, worker) => loop(worker + 1)
  );
  const settled = await Promise.allSettled(loops);
  const rejected = settled.find(
    (entry): entry is PromiseRejectedResult => entry.status === "rejected"
  );
  if (rejected) {
    throw rejected.reason;
  }
  return results;
}

export interface DatabaseAclEntry {
  grantee: string;
  grantor: string;
  is_grantable: boolean;
  privilege_type: string;
}

const PUBLIC_GRANTEE = "PUBLIC";

function quotedGrantee(name: string): string {
  return name === PUBLIC_GRANTEE ? name : `"${name.replaceAll('"', '""')}"`;
}

/**
 * The statements that give a copy the privileges of its template: `CREATE DATABASE … TEMPLATE` copies the contents but
 * not the database's own ACL (the migrations revoke TEMPORARY from PUBLIC on it). `null` is the default ACL, which a new
 * database already has. The runner then compares the two ACLs, so a grantor this cannot reproduce fails the run.
 */
export function databaseAclStatements(
  database: string,
  owner: string,
  acl: readonly DatabaseAclEntry[] | null
): string[] {
  if (acl === null) {
    return [];
  }
  const target = `"${database.replaceAll('"', '""')}"`;
  return [
    `REVOKE ALL ON DATABASE ${target} FROM PUBLIC, ${quotedGrantee(owner)}`,
    ...acl.map(
      (entry) =>
        `GRANT ${entry.privilege_type} ON DATABASE ${target} TO ${quotedGrantee(entry.grantee)}${
          entry.is_grantable ? " WITH GRANT OPTION" : ""
        }`
    ),
  ];
}
