import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { LEGAL_DOCUMENTS } from "@polaris/domain/legal/legal-documents";
import type { Pool, PoolClient } from "pg";
import {
  TENANT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  TENANT_LOCK_TIMEOUT_MS,
  TENANT_STATEMENT_TIMEOUT_MS,
} from "../src/tenant-transaction";
import {
  type GateQueryable,
  inCommittedTransaction,
  inRolledBackTransaction,
  withGateRole,
} from "./gate-roles";
import { sqlState } from "./sales-gate-support";

/**
 * The checks of `public.begin_tenant_request` called directly, the way the Worker never calls it: lists of roles and
 * timeouts it must refuse, its catalog entry and, with its body replaced in a rolled-back transaction, the proof that
 * each probe tells a body without the check from the real one.
 */

const TENANT_ENTRY_ARGUMENTS =
  "p_user text, p_organization text, p_roles text[], p_require_legal boolean, p_min_terms integer, p_min_privacy integer, p_statement_timeout_ms integer, p_lock_timeout_ms integer, p_idle_timeout_ms integer";
const signature =
  "text, text, text[], boolean, integer, integer, integer, integer, integer";
/** The entry of 0136, without the acceptance: kept for the Worker of before until its contract migration. */
const PREVIOUS_TENANT_ENTRY_ARGUMENTS =
  "p_user text, p_organization text, p_roles text[], p_statement_timeout_ms integer, p_lock_timeout_ms integer, p_idle_timeout_ms integer";
const runtimeRole = "polaris_pr11_runtime";
const pendingHelper = "public.legal_acceptance_pending(text, integer, integer)";
const MINIMUMS: [number, number] = [
  LEGAL_DOCUMENTS.terms.minAcceptedVersion,
  LEGAL_DOCUMENTS.privacy.minAcceptedVersion,
];

export interface EntryCall {
  /** The minimum accepted versions of the terms and of the privacy policy; those of `LEGAL_DOCUMENTS` by default. */
  minimums?: [number | null, number | null];
  organization: string | null;
  /** Whether the entry checks the legal acceptance; `false` by default, as the gates without a request pass it. */
  requireLegal?: boolean | null;
  roles: (string | null)[] | null;
  timeouts?: [number | null, number | null, number | null];
  user: string | null;
}

/**
 * `ok:<role>` or `<SQLSTATE>:<message>` (with `:<detail>` when the error has one), under a savepoint, so the caller's
 * transaction stays usable.
 */
export async function entryOutcome(
  client: GateQueryable,
  call: EntryCall
): Promise<string> {
  const timeouts = call.timeouts ?? [
    TENANT_STATEMENT_TIMEOUT_MS,
    TENANT_LOCK_TIMEOUT_MS,
    TENANT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  ];
  await client.query("SAVEPOINT tenant_entry_probe");
  try {
    const result = (await client.query(
      "SELECT member_role FROM public.begin_tenant_request($1, $2, $3::text[], $4::boolean, $5::integer, $6::integer, $7::integer, $8::integer, $9::integer)",
      [
        call.user,
        call.organization,
        call.roles,
        call.requireLegal === undefined ? false : call.requireLegal,
        ...(call.minimums ?? MINIMUMS),
        ...timeouts,
      ]
    )) as { rows: { member_role: string }[] };
    assert.equal(result.rows.length, 1, "the entry answers one row");
    return `ok:${result.rows[0]?.member_role}`;
  } catch (error) {
    const state = sqlState(error);
    if (!state) {
      throw error;
    }
    const { detail } = error as { detail?: unknown };
    return `${state}:${error instanceof Error ? error.message : String(error)}${
      typeof detail === "string" ? `:${detail}` : ""
    }`;
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT tenant_entry_probe");
  }
}

/**
 * Records the acceptance of a version of a document for a user, as the authentication runtime does at the sign-up or
 * the new acceptance (committed: the record is append-only, and the user is one the gate made).
 */
export async function recordAcceptance(
  adminPool: Pool,
  user: string,
  document: "privacy" | "terms",
  version: number
): Promise<void> {
  const { rows } = (await inCommittedTransaction(adminPool, (client) =>
    withGateRole(client, "polaris_auth_runtime", () =>
      client.query(
        "SELECT public.record_legal_acceptance($1, $2, $3, $4, 'reaceite', $5) AS result",
        [
          user,
          document,
          version,
          "0".repeat(64),
          randomUUID().replaceAll("-", ""),
        ]
      )
    )
  )) as { rows: { result: string }[] };
  assert.equal(rows[0]?.result, "recorded", `${document} v${version}`);
}

/**
 * What the entry answers as the tenant runtime once the runtime has lost EXECUTE on the helper of the acceptance (the
 * owner revokes it, in a transaction that is rolled back): the privilege error, never a pass nor one of the refusals.
 */
export async function outcomeWithoutPendingHelper(
  adminPool: Pool,
  call: EntryCall
): Promise<string> {
  const client = await adminPool.connect();
  try {
    return await inRolledBackTransaction(client, async () => {
      await withGateRole(client, "polaris_legal_acceptance_owner", () =>
        client.query(
          `REVOKE EXECUTE ON FUNCTION ${pendingHelper} FROM ${runtimeRole}`
        )
      );
      const can = await client.query<{ ok: boolean }>(
        "SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok",
        [runtimeRole, pendingHelper]
      );
      assert.equal(can.rows[0]?.ok, false, "the revoke took the privilege");
      return withGateRole(client, runtimeRole, () =>
        entryOutcome(client, call)
      );
    });
  } finally {
    client.release();
  }
}

/**
 * Two overloads, both invoker, with their search_path pinned; besides their owner, only the tenant runtime is granted
 * EXECUTE. The one of six arguments is the entry of before, kept until its contract migration.
 */
export async function checkTenantEntryCatalog(adminPool: Pool): Promise<void> {
  const catalog = await adminPool.query<{
    args: string;
    config: string[] | null;
    executors: string[];
    public_execute: boolean;
    result: string;
    security_definer: boolean;
    volatility: string;
  }>(
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
      WHERE n.nspname = 'public' AND p.proname = 'begin_tenant_request'
      ORDER BY p.pronargs`
  );
  const entry = {
    config: ["search_path=pg_catalog, public, pg_temp"],
    executors: [runtimeRole],
    public_execute: false,
    result: "TABLE(member_role text)",
    security_definer: false,
    volatility: "v",
  };
  assert.deepEqual(catalog.rows, [
    { ...entry, args: PREVIOUS_TENANT_ENTRY_ARGUMENTS },
    { ...entry, args: TENANT_ENTRY_ARGUMENTS },
  ]);
}

/** Another runtime gets the privilege error, never one of the refusals. */
export async function checkOtherRuntimeCannotEnter(
  adminPool: Pool,
  call: EntryCall
): Promise<void> {
  const client = await adminPool.connect();
  try {
    const outcome = await inRolledBackTransaction(client, () =>
      withGateRole(client, "polaris_auth_runtime", () =>
        entryOutcome(client, call)
      )
    );
    assert.equal(
      outcome,
      "42501:permission denied for function begin_tenant_request"
    );
  } finally {
    client.release();
  }
}

/**
 * Replaces one fragment of the body, as the owner, in a transaction that is rolled back, and returns what the probe
 * answers as the tenant runtime under that body. A fragment not found fails: the mutant must really differ.
 */
export async function outcomeUnderMutant(
  adminPool: Pool,
  fragment: string,
  replacement: string,
  call: EntryCall
): Promise<string> {
  const client: PoolClient = await adminPool.connect();
  try {
    return await inRolledBackTransaction(client, async () => {
      const definition = await client.query<{ body: string }>(
        `SELECT pg_catalog.pg_get_functiondef('public.begin_tenant_request(${signature})'::regprocedure) AS body`
      );
      const body = definition.rows[0]?.body ?? "";
      assert.ok(
        body.includes(fragment),
        `the body of begin_tenant_request has ${JSON.stringify(fragment)}`
      );
      await client.query(body.replace(fragment, replacement));
      return withGateRole(client, runtimeRole, () =>
        entryOutcome(client, call)
      );
    });
  } finally {
    client.release();
  }
}
