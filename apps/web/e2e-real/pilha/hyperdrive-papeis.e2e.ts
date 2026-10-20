import { readFileSync } from "node:fs";
import config from "../../playwright.e2e-real.config";
import { closedEnvironment } from "../closed-environment";
import { createJourneyUser, expect, test } from "../fixtures";
import { journeyName } from "../journey-names";
import {
  assertRunHyperdrives,
  ensureRunEnvironment,
  HYPERDRIVE_BINDINGS,
  HYPERDRIVE_ROLES,
  type HyperdriveBinding,
  hyperdriveVariable,
  runLoginName,
} from "../run-environment";

/**
 * The seven Hyperdrive bindings of the preview connect as the run's logins, never as a superuser or a role that
 * bypasses RLS. Three of them have an HTTP path in the journeys (tenant, auth, onboarding): their live connection
 * is seen in `pg_stat_activity` while a request runs. The other four (billing, outbox, media cleanup, privacy) only
 * run from cron and queue, which the preview never schedules: their connection string is checked instead.
 */
const run = ensureRunEnvironment();
const BINDING = /"binding":\s*"(\w+)"/g;
const HTTP_PATH: HyperdriveBinding[] = [
  "HYPERDRIVE",
  "AUTH_HYPERDRIVE",
  "ONBOARDING_HYPERDRIVE",
];

test("os 7 bindings do wrangler.jsonc chegam a cada preview como os logins do run, nunca o fallback postgres:postgres", () => {
  // the top level of wrangler.jsonc has exactly these seven, each with the postgres:postgres fallback the run replaces
  const wrangler = readFileSync(
    new URL("../../wrangler.jsonc", import.meta.url),
    "utf8"
  );
  const topLevel = wrangler.slice(
    wrangler.indexOf('"hyperdrive"'),
    wrangler.indexOf('"images"')
  );
  expect(
    [...topLevel.matchAll(BINDING)].map((match) => match[1]).sort()
  ).toEqual([...HYPERDRIVE_BINDINGS].sort());
  // what each web server of the config really gets: Playwright's merge of the process environment and the
  // config's `env`, closed by serve.ts (closed-environment.ts)
  const servers = config.webServer as { env: Record<string, string> }[];
  expect(servers).toHaveLength(2);
  for (const server of servers) {
    const effective = closedEnvironment(
      { ...process.env, ...server.env },
      "preview"
    );
    expect(() => assertRunHyperdrives(effective, run.runId)).not.toThrow();
    for (const binding of HYPERDRIVE_BINDINGS) {
      const url = new URL(effective[hyperdriveVariable(binding)] as string);
      expect(url.username, binding).toBe(runLoginName(run.runId, binding));
      expect(url.username, binding).not.toBe("postgres");
      expect(url.pathname, binding).toBe(`/e2e_${run.runId}`);
    }
    expect(effective.POLARIS_E2E_DATABASE_URL).toBeUndefined();
  }
});

test("os 7 logins do run existem, sem superusuário nem BYPASSRLS, cada um no seu papel", async ({
  sql,
}) => {
  const rows = await sql.query<{
    login: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    member: boolean;
  }>(
    `SELECT r.rolname AS login, r.rolsuper, r.rolbypassrls, pg_has_role(r.rolname, b.role, 'MEMBER') AS member
       FROM unnest($1::text[], $2::text[]) AS b(login, role)
       JOIN pg_roles r ON r.rolname = b.login`,
    [
      HYPERDRIVE_BINDINGS.map((binding) => runLoginName(run.runId, binding)),
      HYPERDRIVE_BINDINGS.map((binding) => HYPERDRIVE_ROLES[binding]),
    ]
  );
  expect(rows.rows).toHaveLength(7);
  for (const row of rows.rows) {
    expect(row, row.login).toMatchObject({
      member: true,
      rolbypassrls: false,
      rolsuper: false,
    });
  }
});

test("as conexões vivas do preview são dos logins do run, sem superusuário nem BYPASSRLS", async ({
  request,
  sql,
}, testInfo) => {
  const origin = String(testInfo.project.use.baseURL);
  const user = await createJourneyUser(
    origin,
    journeyName("pilha", "papeis", testInfo.retry)
  );
  const seen = new Map<string, { rolsuper: boolean; rolbypassrls: boolean }>();
  let polling = true;
  // the local Hyperdrive opens a connection per request and closes it after: watch while the requests run
  const watcher = (async () => {
    while (polling) {
      // biome-ignore lint/performance/noAwaitInLoops: sampling pg_stat_activity while the requests run
      const result = await sql.query<{
        login: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(
        `SELECT r.rolname AS login, r.rolsuper, r.rolbypassrls
           FROM pg_stat_activity a JOIN pg_roles r ON r.oid = a.usesysid
          WHERE a.datname = current_database() AND a.usename <> current_user`
      );
      for (const row of result.rows) {
        seen.set(row.login, row);
      }
    }
  })();
  try {
    await expect
      .poll(
        async () => {
          await request.get("/api/auth/get-session", {
            headers: Object.fromEntries(user.headers),
          });
          const created = await user.rpc.organization.createInitial({
            name: user.name,
            timezone: "America/Sao_Paulo",
          });
          await user.rpc.category.list({
            organizationId: created.organization.id,
          });
          return HTTP_PATH.filter((binding) =>
            seen.has(runLoginName(run.runId, binding))
          );
        },
        { intervals: [100], timeout: 30_000 }
      )
      .toEqual(HTTP_PATH);
  } finally {
    polling = false;
    await watcher;
  }
  for (const [login, row] of seen) {
    expect(login).toMatch(new RegExp(`^polaris_e2e_${run.runId}_`));
    expect(row, login).toMatchObject({ rolbypassrls: false, rolsuper: false });
  }
});
