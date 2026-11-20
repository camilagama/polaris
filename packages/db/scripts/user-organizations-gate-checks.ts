import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  type GateQueryable,
  inRolledBackTransaction,
  rollbackQuietly,
  withGateRole,
} from "./gate-roles";
import { runtimeRole, sqlState } from "./sales-gate-support";

/**
 * The checks of `public.list_user_organizations`: its catalog entry, its refusals, the settings it leaves behind and
 * the equality of its answer with the list read as separate statements, the way `listUserOrganizations` read it
 * before the function (one `set_config` and one SELECT per organization, under the same policies).
 */

export interface ListedOrganization {
  id: string;
  name: string;
  role: string;
  timezone: string;
}

const FUNCTION_CALL =
  "SELECT id, name, role, timezone FROM public.list_user_organizations($1)";

async function underSavepoint<T>(
  client: GateQueryable,
  work: () => Promise<T>
): Promise<T> {
  await client.query("SAVEPOINT user_organizations_probe");
  try {
    return await work();
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT user_organizations_probe");
  }
}

/** The list read as separate statements, exactly as the query of the Worker read it before the function. */
export async function listedBySeparateStatements(
  client: GateQueryable,
  user: string
): Promise<ListedOrganization[]> {
  return await underSavepoint(client, async () => {
    await client.query("SELECT set_config('app.user_id', $1, true)", [user]);
    const memberships = (await client.query(
      `SELECT organization_id, role FROM public.memberships
        WHERE user_id = $1 AND status = 'active'
        ORDER BY created_at ASC, organization_id ASC`,
      [user]
    )) as { rows: { organization_id: string; role: string }[] };
    const listed: ListedOrganization[] = [];
    for (const membership of memberships.rows) {
      // biome-ignore lint/performance/noAwaitInLoops: each organization is read under its own scope, in order
      await client.query("SELECT set_config('app.organization_id', $1, true)", [
        membership.organization_id,
      ]);
      const organization = (await client.query(
        "SELECT id, name, status, timezone FROM public.organizations WHERE id = $1 LIMIT 1",
        [membership.organization_id]
      )) as {
        rows: { id: string; name: string; status: string; timezone: string }[];
      };
      const [row] = organization.rows;
      if (row?.status === "active") {
        listed.push({
          id: row.id,
          name: row.name,
          role: membership.role,
          timezone: row.timezone,
        });
      }
    }
    return listed;
  });
}

/** The list the function answers, in its own order. */
export async function listedByFunction(
  client: GateQueryable,
  user: string | null
): Promise<ListedOrganization[]> {
  return await underSavepoint(
    client,
    async () =>
      (
        (await client.query(FUNCTION_CALL, [user])) as {
          rows: ListedOrganization[];
        }
      ).rows
  );
}

/** `ok:<count>` or `<SQLSTATE>:<message>`, under a savepoint. */
async function functionOutcome(
  client: GateQueryable,
  user: string | null
): Promise<string> {
  try {
    return `ok:${(await listedByFunction(client, user)).length}`;
  } catch (error) {
    const state = sqlState(error);
    if (!state) {
      throw error;
    }
    return `${state}:${error instanceof Error ? error.message : String(error)}`;
  }
}

/** One function, invoker, pinned search_path, the four fields of today; besides its owner, only the tenant runtime may run it. */
export async function checkUserOrganizationsCatalog(
  adminPool: Pool
): Promise<void> {
  const catalog = await adminPool.query(
    `SELECT pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
            p.proconfig AS config,
            ARRAY(
              SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END
                FROM pg_catalog.aclexplode(p.proacl) AS acl
               WHERE acl.privilege_type = 'EXECUTE' AND acl.grantee <> p.proowner
               ORDER BY 1
            ) AS executors,
            pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
            pg_catalog.pg_get_function_result(p.oid) AS result,
            p.prosecdef AS security_definer,
            p.provolatile::text AS volatility
       FROM pg_catalog.pg_proc AS p
       JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'list_user_organizations'`
  );
  assert.deepEqual(catalog.rows, [
    {
      args: "p_user text",
      config: ["search_path=pg_catalog, public, pg_temp"],
      executors: [runtimeRole],
      public_execute: false,
      result: "TABLE(id text, name text, role text, timezone text)",
      security_definer: false,
      volatility: "v",
    },
  ]);
}

/** Another runtime gets the privilege error, never a list. */
export async function checkOtherRuntimeCannotList(
  adminPool: Pool,
  user: string
): Promise<void> {
  const client = await adminPool.connect();
  try {
    const outcome = await inRolledBackTransaction(client, () =>
      withGateRole(client, "polaris_auth_runtime", () =>
        functionOutcome(client, user)
      )
    );
    assert.equal(
      outcome,
      "42501:permission denied for function list_user_organizations"
    );
  } finally {
    client.release();
  }
}

/** A user that is null, empty, blank or with blank space at an end is refused with the refusal of the Worker. */
export async function checkUserOrganizationsRefusals(
  runtimeClient: GateQueryable,
  user: string
): Promise<void> {
  const outcomes = await inRolledBackTransaction(runtimeClient, async () => {
    const result: Record<string, string> = {};
    const cases: [string, string | null][] = [
      ["null", null],
      ["empty", ""],
      ["blank", "   "],
      ["leading space", ` ${user}`],
      ["trailing space", `${user} `],
      ["trailing tab", `${user}\t`],
      ["leading newline", `\n${user}`],
      ["the user", user],
    ];
    for (const [name, candidate] of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: one savepoint at a time on the one connection
      result[name] = await functionOutcome(runtimeClient, candidate);
    }
    return result;
  });
  const denied = "42501:tenant_access_denied";
  assert.deepEqual(outcomes, {
    blank: denied,
    empty: denied,
    "leading newline": denied,
    "leading space": denied,
    null: denied,
    "the user": "ok:1",
    "trailing space": denied,
    "trailing tab": denied,
  });
}

const SETTINGS =
  "SELECT current_setting('app.user_id', true) AS user_id, current_setting('app.organization_id', true) AS organization_id";

/**
 * Inside the transaction, a statement after the function finds both settings empty; and two calls in a row on the same
 * connection, each in its own transaction, answer the same and the second starts with no setting of the first.
 */
export async function checkUserOrganizationsLeaveNoSetting(
  runtimeClient: GateQueryable,
  user: string,
  expected: ListedOrganization[]
): Promise<void> {
  const settingsOf = async () =>
    (
      (await runtimeClient.query(SETTINGS)) as {
        rows: { organization_id: string | null; user_id: string | null }[];
      }
    ).rows[0];
  const empty = (value: string | null | undefined) => (value ?? "") === "";

  for (const call of ["first", "second"]) {
    // biome-ignore lint/performance/noAwaitInLoops: the two calls run one after the other on the one connection
    const before = await settingsOf();
    assert.ok(
      empty(before?.user_id) && empty(before?.organization_id),
      `the ${call} call starts with no setting on the connection`
    );
    await runtimeClient.query("BEGIN");
    try {
      const listed = (await runtimeClient.query(FUNCTION_CALL, [user])) as {
        rows: ListedOrganization[];
      };
      assert.deepEqual(listed.rows, expected, `the ${call} call answers`);
      const after = await settingsOf();
      assert.deepEqual(
        after,
        { organization_id: "", user_id: "" },
        `after the ${call} call, a statement of the same transaction finds both settings empty`
      );
      await runtimeClient.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(runtimeClient);
      throw error;
    }
  }
}

interface EqualityCase {
  expected: string[];
  name: string;
  user: string;
}

/**
 * The function and the separate statements answer exactly the same, rows and order, as the tenant runtime, on users
 * with 0, 1 and 3 organizations, a membership that is not active, organizations in every status that is not active,
 * a role other than owner, and two memberships created at the same instant (the tie goes to the organization id).
 * The CHECKs that today hold memberships to one role and one status are dropped inside the rolled-back transaction, so
 * the filters of both readings are compared on rows a later status or role would write. Returns the cases it compared.
 */
export async function checkUserOrganizationsEquality(
  adminPool: Pool
): Promise<string[]> {
  const client = await adminPool.connect();
  try {
    return await inRolledBackTransaction(client, async () => {
      await client.query(
        "ALTER TABLE public.memberships DROP CONSTRAINT memberships_status_check, DROP CONSTRAINT memberships_role_check"
      );
      const user = async (label: string) => {
        const id = randomUUID();
        await client.query(
          'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
          [id, `list gate ${label}`, `list-${id}@example.invalid`]
        );
        return id;
      };
      const organization = async (
        name: string,
        status = "active",
        timezone = "America/Sao_Paulo"
      ) => {
        const id = randomUUID();
        await client.query(
          "INSERT INTO public.organizations (id, name, timezone, status) VALUES ($1, $2, $3, $4)",
          [id, name, timezone, status]
        );
        return id;
      };
      const member = async (
        userId: string,
        organizationId: string,
        createdAt: string,
        { role = "owner", status = "active" } = {}
      ) => {
        await client.query(
          "INSERT INTO public.memberships (organization_id, user_id, role, status, created_at) VALUES ($1, $2, $3, $4, $5::timestamptz)",
          [organizationId, userId, role, status, createdAt]
        );
      };

      const none = await user("none");
      const one = await user("one");
      const three = await user("three");
      const removed = await user("removed");
      const closed = await user("closed");
      const tied = await user("tied");

      const oneStore = await organization(
        "Loja única",
        "active",
        "America/Manaus"
      );
      await member(one, oneStore, "2026-01-05T12:00:00Z");

      const third = await organization("Terceira loja");
      const first = await organization(
        "Primeira loja",
        "active",
        "America/Recife"
      );
      const second = await organization("Segunda loja");
      await member(three, second, "2026-02-01T12:00:00Z", { role: "manager" });
      await member(three, third, "2026-03-01T12:00:00Z");
      await member(three, first, "2026-01-01T12:00:00Z");

      const kept = await organization("Loja mantida");
      const left = await organization("Loja deixada");
      await member(removed, left, "2026-01-01T12:00:00Z", {
        status: "removed",
      });
      await member(removed, kept, "2026-02-01T12:00:00Z");
      await member(one, left, "2026-01-01T12:00:00Z", { status: "suspended" });

      const open = await organization("Loja aberta");
      await member(closed, open, "2026-06-01T12:00:00Z");
      for (const [index, status] of [
        "suspended",
        "closing",
        "closed",
        "purge_pending",
        "purged",
      ].entries()) {
        // biome-ignore lint/performance/noAwaitInLoops: one fixture row per status
        const shut = await organization(`Loja ${status}`, status);
        await member(closed, shut, `2026-0${index + 1}-01T12:00:00Z`);
      }

      const tiedIds = [
        await organization("Empate A"),
        await organization("Empate B"),
      ];
      for (const id of tiedIds) {
        // biome-ignore lint/performance/noAwaitInLoops: two fixture rows
        await member(tied, id, "2026-04-01T12:00:00Z");
      }

      const cases: EqualityCase[] = [
        { expected: [], name: "no organization", user: none },
        { expected: [oneStore], name: "one organization", user: one },
        {
          expected: [first, second, third],
          name: "three organizations, by created_at",
          user: three,
        },
        {
          expected: [kept],
          name: "a membership that is not active",
          user: removed,
        },
        {
          expected: [open],
          name: "organizations that are not active",
          user: closed,
        },
        {
          expected: [...tiedIds].sort(),
          name: "memberships of the same instant, by organization id",
          user: tied,
        },
      ];

      const compared: string[] = [];
      await withGateRole(client, runtimeRole, async () => {
        for (const equality of cases) {
          // biome-ignore lint/performance/noAwaitInLoops: one reading at a time on the one connection
          const separate = await listedBySeparateStatements(
            client,
            equality.user
          );
          const single = await listedByFunction(client, equality.user);
          assert.deepEqual(
            single,
            separate,
            `${equality.name}: the function answers what the separate statements answer`
          );
          assert.deepEqual(
            single.map((row) => row.id),
            equality.expected,
            `${equality.name}: the organizations and their order`
          );
          compared.push(equality.name);
        }
        const threeRows = await listedByFunction(client, three);
        assert.deepEqual(
          threeRows.map((row) => [row.name, row.role, row.timezone]),
          [
            ["Primeira loja", "owner", "America/Recife"],
            ["Segunda loja", "manager", "America/Sao_Paulo"],
            ["Terceira loja", "owner", "America/Sao_Paulo"],
          ],
          "the name and time zone of each organization, with the role of its membership"
        );
        assert.deepEqual(
          Object.keys(threeRows[0] ?? {}).sort(),
          ["id", "name", "role", "timezone"],
          "only the four fields of today"
        );
      });
      assert.equal(compared.length, cases.length);
      return compared;
    });
  } finally {
    client.release();
  }
}
