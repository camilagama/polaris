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

/** The suite of every gate the CI proves against its own Postgres 18; `gates:ci` runs all of it in one job. */
export const CI_SUITE = "ci";

/** The suite of the job that keeps everything the other jobs do not take. */
export const CI_MAIN_JOB = "ci-database";

/**
 * Gates that run in a job of their own in the CI, each job with its own Postgres 18, beside the main job: a serial gate
 * whose wall is the floor of the gates' job (the fuzz of 240 role graphs of `definer-hardening` is ~45 s, then 16 to 60 s
 * in the main job after the parallel phase). Each key is a suite name and a `gates:<suite>` script of `package.json`; the
 * main job takes the rest of `ci`, so a gate added to `ci` lands in the main job unless it is listed here.
 */
export const CI_SEPARATE_JOBS: Readonly<Record<string, readonly string[]>> = {
  "ci-definer-hardening": ["definer-hardening"],
};

/**
 * The suites of the CI jobs: every key of `separate` with its gates, and `CI_MAIN_JOB` with the rest of `ci`, in the
 * order of `ci`. A separate gate that is not in `ci`, or that two jobs list, is a mistake, not a gate that silently
 * stops running.
 */
export function ciJobSuites(
  ci: readonly string[],
  separate: Readonly<Record<string, readonly string[]>> = CI_SEPARATE_JOBS
): Record<string, string[]> {
  const taken = new Map<string, string>();
  for (const [job, names] of Object.entries(separate)) {
    for (const name of names) {
      assert.ok(
        ci.includes(name),
        `${job} lists ${name}, which is not a gate of the ${CI_SUITE} suite`
      );
      const other = taken.get(name);
      assert.equal(
        other,
        undefined,
        `${name} is listed by ${other} and by ${job}`
      );
      taken.set(name, job);
    }
  }
  return {
    [CI_MAIN_JOB]: ci.filter((name) => !taken.has(name)),
    ...Object.fromEntries(
      Object.entries(separate).map(([job, names]) => [job, [...names]])
    ),
  };
}

/**
 * What the union of the jobs' gates gets wrong against the suite: a gate that no job runs, a gate that two runs
 * cover, and a gate of a job that the suite does not have. Empty when every gate of `suite` runs exactly once.
 */
export function coverageProblems(
  suite: readonly string[],
  runs: readonly string[]
): string[] {
  const counts = new Map<string, number>();
  for (const name of runs) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const inSuite = new Set(suite);
  return [
    ...suite
      .filter((name) => !counts.has(name))
      .map((name) => `${name} is in ${CI_SUITE} and no job runs it`),
    ...[...counts]
      .filter(([, count]) => count > 1)
      .map(([name, count]) => `${name} runs ${count} times`),
    ...[...counts.keys()]
      .filter((name) => !inSuite.has(name))
      .map((name) => `${name} runs in a job and is not in ${CI_SUITE}`),
  ];
}

const WORKFLOW_GATES_RUN_ONE =
  /bun run --filter @polaris\/db gates:ci[\w-]*(?=\s|$)/m;
const TRAILING_COMMENT = /\s#.*$/;

function withoutComments(workflow: string): string {
  return workflow
    .split("\n")
    .map((line) => line.replace(TRAILING_COMMENT, ""))
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}
const WORKFLOW_GATES_RUN =
  /bun run --filter @polaris\/db (gates:ci[\w-]*)(?=\s|$)/g;
const RUN_GATES_SCRIPT = /^bun scripts\/run-gates\.ts((?: [\w-]+)+)$/;

/**
 * The gates the `gates:ci*` commands of a workflow run, one name per run, in the order the workflow lists them. A
 * command that resolves to a script or a suite that does not exist throws: a typo must not read as a job that runs
 * nothing. Comment lines do not count.
 */
export function workflowGateRuns(
  workflow: string,
  packageScripts: Readonly<Record<string, string>>,
  suites: Readonly<Record<string, readonly string[]>>
): string[] {
  const text = withoutComments(workflow);
  const runs: string[] = [];
  for (const [, script] of text.matchAll(WORKFLOW_GATES_RUN)) {
    const command = packageScripts[script as string];
    assert.ok(command, `the workflow runs ${script}, which package.json lacks`);
    const suiteNames = RUN_GATES_SCRIPT.exec(command)?.[1]?.trim().split(" ");
    assert.ok(
      suiteNames,
      `${script} is not a run-gates.ts command: ${command}`
    );
    for (const suite of suiteNames) {
      const names = suites[suite];
      assert.ok(
        names,
        `${script} runs the suite ${suite}, which does not exist`
      );
      runs.push(...names);
    }
  }
  return runs;
}

export interface WorkflowJob {
  id: string;
  name: string;
  needs: string[];
  text: string;
}

const JOB_HEADER = /^ {2}([\w-]+):\s*$/;
const NEEDS_LINE = /^ {4}needs:\s*(.*)$/m;
const NAME_LINE = /^ {4}name:\s*(.*)$/m;

/** The jobs of a workflow, `jobs:` section only: id, `name:`, `needs:` (a name or an inline list) and the text. */
export function workflowJobs(workflow: string): WorkflowJob[] {
  const lines = workflow.split("\n");
  const from = lines.indexOf("jobs:");
  assert.notEqual(from, -1, "the workflow has no jobs: section");
  const jobs: WorkflowJob[] = [];
  let current: { id: string; lines: string[] } | undefined;
  const close = () => {
    if (current) {
      const text = current.lines.join("\n");
      const needs = (NEEDS_LINE.exec(text)?.[1] ?? "")
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      jobs.push({
        id: current.id,
        name: NAME_LINE.exec(text)?.[1]?.trim() ?? current.id,
        needs,
        text,
      });
    }
  };
  for (const line of lines.slice(from + 1)) {
    const header = JOB_HEADER.exec(line);
    if (header) {
      close();
      current = { id: header[1] as string, lines: [line] };
    } else {
      current?.lines.push(line);
    }
  }
  close();
  return jobs;
}

/**
 * What stops a job that runs gates from blocking the deploys: every job with a `gates:ci*` command must be the job named
 * `collector`, or be in its `needs`, since the deploys and the required check read only that name.
 */
export function collectorProblems(
  workflow: string,
  collector: string
): string[] {
  const jobs = workflowJobs(withoutComments(workflow));
  const named = jobs.find((job) => job.name === collector);
  if (!named) {
    return [`no job is named ${collector}`];
  }
  return jobs
    .filter(
      (job) => job.id !== named.id && WORKFLOW_GATES_RUN_ONE.test(job.text)
    )
    .filter((job) => !named.needs.includes(job.id))
    .map(
      (job) => `${job.id} runs gates and is not in the needs of ${collector}`
    );
}
