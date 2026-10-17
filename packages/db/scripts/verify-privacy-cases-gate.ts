// biome-ignore-all lint/performance/noAwaitInLoops: the matrix probes run one after another on one connection, on purpose
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  InvalidSupportRequestError,
  TenantAccessDeniedError,
} from "@polaris/domain/admin/support-access";
import {
  assertActionAllowed,
  assertDecisionAllowed,
  InvalidPrivacyStepError,
  PRIVACY_DECISION_REASONS,
  PRIVACY_DECISIONS,
  PRIVACY_REQUESTER_KINDS,
} from "@polaris/domain/admin/privacy-case";
import { Client } from "pg";
import {
  closeSupportCase,
  grantTenantAccess,
  listPrivacyCases,
  openPrivacyCase,
  openSupportCase,
  readPrivacyCase,
  readSupportCase,
  recordPrivacyAction,
  recordPrivacyDecision,
  recordPrivacyIdentity,
  recordPrivacyRole,
  recordPrivacyScope,
  resolvePrivacyCase,
} from "../src/admin-support-repository";
import { createDatabase } from "../src/client";
import {
  createTenantFixture,
  disposableHostPattern,
  expectSqlState,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  temporaryRuntimeUrl,
} from "./sales-gate-support";

/**
 * The privacy-case workflow on a real PostgreSQL 18 (plan PR103, ADR 0077): a case is
 * opened with its request and then moves one step at a time (identity, role, scope,
 * decision, action, resolution), each step audited in the same transaction; the database
 * refuses a step out of order, a decision the case does not allow and any change to a
 * step already recorded or to a resolved case; a privacy case is opened and closed only
 * through its own workflow; and nothing personal is stored.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const issuer = "https://polaris-privacy-gate.cloudflareaccess.com";
const NOTE_MARKER = "NOTA-PRIVADA-9731";
const DAY_MS = 86_400_000;
const AUDIT_DETAIL_CODES =
  /^(privacy|revoked=\d+|stage=[a-z_]+(;[a-z_]+=[a-z_0-9]+)*|action=[a-z_]+)$/;

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const owner = createDatabase(adminUrl, { maxConnections: 2 });
  const logins: [string, string][] = [];
  const tests: string[] = [];

  try {
    const server = await owner.pool.query<{
      database_name: string;
      server_version: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num"
    );
    const [serverRow] = server.rows;
    assert.ok(serverRow);
    assert.equal(serverRow.database_name, expectedDatabase);
    assert.ok(Number(serverRow.server_version_num) >= 180_000);
    const migrations = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "disposable direct Neon connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    const role = `polaris_priv_admin_${randomUUID().replaceAll("-", "")}`;
    const password = randomBytes(24).toString("hex");
    await owner.pool.query(
      `CREATE ROLE "${role}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
    );
    await owner.pool.query(`GRANT "polaris_admin_runtime" TO "${role}"`);
    logins.push([role, "polaris_admin_runtime"]);
    const adminLoginUrl = temporaryRuntimeUrl(adminUrl, role, password);
    const asAdmin = async <T>(operation: (client: Client) => Promise<T>) => {
      const client = new Client({
        connectionString: adminLoginUrl,
        connectionTimeoutMillis: 5000,
      });
      await client.connect();
      try {
        return await operation(client);
      } finally {
        await client.end();
      }
    };

    const principal = async (status = "active") =>
      (
        await owner.pool.query<{ id: string }>(
          "INSERT INTO public.platform_principals (issuer, subject, role, status) VALUES ($1, $2, 'platform_owner', $3) RETURNING id",
          [issuer, `sub-${randomUUID()}`, status]
        )
      ).rows[0]?.id as string;
    const p1 = await principal();
    const disabled = await principal("disabled");
    const suffix = randomUUID().slice(0, 8);
    const orgA = await createTenantFixture(owner.pool, `priv A ${suffix}`);
    const subject = randomUUID();

    const open = (
      over: Partial<Parameters<typeof openPrivacyCase>[2]> = {},
      who = p1
    ) =>
      asAdmin((client) =>
        openPrivacyCase(client, who, {
          channel: "email",
          dueDays: 15,
          note: `Pedido ${NOTE_MARKER}`,
          organizationId: orgA.organizationId,
          reason: "Pedido de privacidade",
          receivedAt: null,
          requesterKind: "data_subject",
          requestType: "deletion",
          ...over,
        })
      );
    const identity = (
      caseId: string,
      status = "verified",
      method = "owner_confirmation"
    ) =>
      asAdmin((client) =>
        recordPrivacyIdentity(client, p1, caseId, { method, status })
      );
    const roleOf = (caseId: string, value: string) =>
      asAdmin((client) => recordPrivacyRole(client, p1, caseId, value));
    const scope = (caseId: string, categories = ["customers"]) =>
      asAdmin((client) =>
        recordPrivacyScope(client, p1, caseId, {
          categories,
          subjectReference: subject,
        })
      );
    const decide = (
      caseId: string,
      decision: string,
      reason: string | null = null
    ) =>
      asAdmin((client) =>
        recordPrivacyDecision(client, p1, caseId, {
          decision,
          note: null,
          reason,
        })
      );
    const act = (caseId: string, action = "customer_anonymized") =>
      asAdmin((client) =>
        recordPrivacyAction(client, p1, caseId, { action, entityId: subject })
      );
    const resolve = (caseId: string, resolution: string | null = "Feito") =>
      asAdmin((client) => resolvePrivacyCase(client, p1, caseId, resolution));
    const stageOf = async (caseId: string) =>
      (
        await owner.pool.query<{ stage: string }>(
          "SELECT stage FROM public.privacy_cases WHERE support_case_id = $1",
          [caseId]
        )
      ).rows[0]?.stage;
    const refused = (code: string) => (error: unknown) =>
      error instanceof InvalidSupportRequestError && error.code === code;
    /** A case taken up to the step before the decision. */
    const scoped = async (
      identityStatus: string,
      polarisRole: string,
      requesterKind = "data_subject"
    ) => {
      const created = await open({ requesterKind });
      assert.ok(created);
      await identity(created.id, identityStatus);
      await roleOf(created.id, polarisRole);
      await scope(created.id);
      return created.id;
    };

    // ------------------------------------------------- 1. opening a case
    await assert.rejects(() => open({}, disabled), TenantAccessDeniedError);
    for (const [label, over, code] of [
      [
        "an unknown request type",
        { requestType: "sell" },
        "invalid_privacy_request",
      ],
      [
        "an unknown requester",
        { requesterKind: "friend" },
        "invalid_privacy_request",
      ],
      ["an unknown channel", { channel: "pigeon" }, "invalid_privacy_request"],
      ["a response time of zero", { dueDays: 0 }, "invalid_privacy_request"],
      [
        "a response time over 90 days",
        { dueDays: 91 },
        "invalid_privacy_request",
      ],
      [
        "a request from the future",
        { receivedAt: new Date(Date.now() + 3_600_000) },
        "invalid_privacy_request",
      ],
      [
        "a note over 500 characters",
        { note: "x".repeat(501) },
        "invalid_privacy_request",
      ],
      ["an empty reason", { reason: "  " }, "invalid_case_reason"],
      [
        "an unknown organization",
        { organizationId: "nope" },
        "unknown_organization",
      ],
    ] as const) {
      await assert.rejects(
        () => open(over as never),
        refused(code),
        `${label} is refused`
      );
    }
    const arrived = new Date(Date.now() - 3 * DAY_MS);
    const first = await open({ receivedAt: arrived });
    assert.ok(first);
    assert.equal(first.stage, "requested");
    const [supportCase] = (
      await owner.pool.query<{
        kind: string;
        status: string;
        opened_by: string;
      }>(
        "SELECT kind, status, opened_by FROM public.support_cases WHERE id = $1",
        [first.id]
      )
    ).rows;
    assert.equal(supportCase?.kind, "privacy");
    assert.equal(supportCase?.status, "open");
    assert.equal(supportCase?.opened_by, p1);
    const [row] = (
      await owner.pool.query<{
        stage: string;
        due_ms: string;
        received_ms: string;
      }>(
        "SELECT stage, (extract(epoch FROM due_at) * 1000)::bigint::text AS due_ms, (extract(epoch FROM received_at) * 1000)::bigint::text AS received_ms FROM public.privacy_cases WHERE support_case_id = $1",
        [first.id]
      )
    ).rows;
    assert.equal(row?.stage, "requested");
    assert.equal(
      Number(row?.due_ms) - Number(row?.received_ms),
      15 * DAY_MS,
      "it is due fifteen days after it arrived (not after it was typed in)"
    );
    assert.ok(
      Math.abs(Number(row?.received_ms) - arrived.getTime()) < 1000,
      "and the moment it arrived is the one given"
    );
    // a privacy case is opened and closed only through its own workflow
    await assert.rejects(
      () =>
        asAdmin((client) =>
          openSupportCase(client, p1, {
            context: null,
            kind: "privacy",
            organizationId: orgA.organizationId,
            reason: "x",
          })
        ),
      refused("privacy_case_workflow_required"),
      "the generic opening refuses a privacy case"
    );
    await assert.rejects(
      () => asAdmin((client) => closeSupportCase(client, p1, first.id, "x")),
      refused("privacy_case_workflow_required"),
      "and the generic closing refuses it too"
    );
    assert.equal(await stageOf(first.id), "requested");
    tests.push(
      "opening needs an active operator and a valid request (type, requester, channel, a response time of 1 to 90 days, a moment in the past, a short note and reason, a known organization); it creates the support case and the privacy case together, due fifteen days after the request arrived; the generic support functions refuse to open or close a privacy case"
    );

    await assert.rejects(
      () => identity(randomUUID()),
      refused("unknown_case"),
      "a case that does not exist is not a case that is closed"
    );
    // a privacy case opened before the workflow existed (no privacy record) can still be closed the generic way
    const legacy = (
      await owner.pool.query<{ id: string }>(
        "INSERT INTO public.support_cases (organization_id, kind, reason, opened_by) VALUES ($1, 'privacy', 'Anterior ao fluxo', $2) RETURNING id",
        [orgA.organizationId, p1]
      )
    ).rows[0]?.id as string;
    assert.equal(
      (
        await asAdmin((client) =>
          closeSupportCase(client, p1, legacy, "Encerrado")
        )
      )?.status,
      "closed"
    );
    // ------------------------------------------------- 2. the order of the steps
    const base = first.id;
    await assert.rejects(
      () => roleOf(base, "controller"),
      refused("privacy_stage_conflict")
    );
    await assert.rejects(() => scope(base), refused("privacy_stage_conflict"));
    await assert.rejects(
      () => decide(base, "reject", "other"),
      refused("privacy_stage_conflict")
    );
    await assert.rejects(() => act(base), refused("privacy_stage_conflict"));
    await assert.rejects(
      () => resolve(base),
      refused("privacy_stage_conflict")
    );
    await assert.rejects(
      () => identity(base, "maybe"),
      refused("invalid_privacy_step")
    );
    await assert.rejects(
      () => identity(base, "verified", "telepathy"),
      refused("invalid_privacy_step")
    );
    assert.equal(await stageOf(base), "requested");
    await identity(base);
    await assert.rejects(
      () => identity(base),
      refused("privacy_stage_conflict"),
      "a step is recorded once"
    );
    await assert.rejects(() => scope(base), refused("privacy_stage_conflict"));
    await assert.rejects(
      () => roleOf(base, "joint"),
      refused("invalid_privacy_step")
    );
    await roleOf(base, "controller");
    for (const categories of [[], ["customers", "customers"], ["pictures"]]) {
      await assert.rejects(
        () => scope(base, categories),
        refused("invalid_privacy_step")
      );
    }
    await assert.rejects(
      () =>
        asAdmin((client) =>
          recordPrivacyScope(client, p1, base, {
            categories: ["account"],
            subjectReference: "x".repeat(65),
          })
        ),
      refused("invalid_privacy_step")
    );
    for (const reference of ["maria@example.com", "Maria Souza"]) {
      await assert.rejects(
        () =>
          asAdmin((client) =>
            recordPrivacyScope(client, p1, base, {
              categories: ["account"],
              subjectReference: reference,
            })
          ),
        refused("invalid_privacy_step"),
        "an opaque reference is an identifier, not text a person wrote"
      );
    }
    await scope(base, ["account", "authentication"]);
    assert.equal(await stageOf(base), "scoped");
    tests.push(
      "each step is recorded once and only when the one before it is done (identity, role, scope, decision, action, resolution); an unknown code, a repeated or unknown category and an over-long subject reference are refused"
    );

    // ------------------------------------------------- 3. what may be decided
    await assert.rejects(
      () => decide(base, "maybe"),
      refused("invalid_privacy_step")
    );
    await assert.rejects(
      () => decide(base, "reject"),
      refused("invalid_privacy_step"),
      "a refusal needs a reason"
    );
    await assert.rejects(
      () => decide(base, "partially_accept"),
      refused("invalid_privacy_step"),
      "a partial acceptance says why too"
    );
    for (const decision of ["accept", "partially_accept", "reject"]) {
      await assert.rejects(
        () => decide(base, decision, "identity_not_verified"),
        refused("privacy_decision_not_allowed"),
        `that is a reason only for a failed identity check (${decision})`
      );
    }
    await assert.rejects(
      () => decide(base, "redirect_to_controller", "controller_is_reseller"),
      refused("privacy_decision_not_allowed"),
      "Polaris is the controller here: there is no one to redirect to"
    );
    assert.equal(await stageOf(base), "scoped");

    const failedId = await scoped("failed", "controller");
    for (const decision of ["accept", "partially_accept"]) {
      await assert.rejects(
        () => decide(failedId, decision),
        refused("privacy_decision_not_allowed"),
        `a failed identity check never accepts (${decision})`
      );
    }
    await assert.rejects(
      () => decide(failedId, "reject", "legal_retention"),
      refused("privacy_decision_not_allowed"),
      "and its refusal says why"
    );
    await decide(failedId, "reject", "identity_not_verified");
    await assert.rejects(
      () => act(failedId),
      refused("privacy_stage_conflict"),
      "a refusal has nothing to carry out"
    );
    const failedResolved = await resolve(failedId, "Identidade não confirmada");
    assert.equal(
      failedResolved?.stage,
      "resolved",
      "a refusal is resolved without execution"
    );

    for (const requesterKind of ["data_subject", "authority"]) {
      const processorId = await scoped("verified", "processor", requesterKind);
      for (const decision of ["accept", "partially_accept"]) {
        await assert.rejects(
          () => decide(processorId, decision, "other"),
          refused("privacy_decision_not_allowed"),
          `Polaris does not accept data it only processes on a ${requesterKind}'s word (${decision})`
        );
      }
      await decide(
        processorId,
        "redirect_to_controller",
        "controller_is_reseller"
      );
      const redirected = await resolve(
        processorId,
        "Encaminhado ao revendedor"
      );
      assert.equal(
        redirected?.stage,
        "resolved",
        "a redirect needs no execution"
      );
    }
    const ownerAsks = await scoped(
      "verified",
      "processor",
      "organization_owner"
    );
    await decide(ownerAsks, "accept");
    await assert.rejects(
      () => resolve(ownerAsks),
      refused("privacy_stage_conflict"),
      "an acceptance is resolved only after it was carried out"
    );
    tests.push(
      "a decision is refused when the case does not allow it: a failed identity check only rejects, with its own reason; a refusal needs a reason; a redirect needs Polaris to be the processor; Polaris does not accept data it only processes on the word of a data subject or an authority (only the organization's owner can ask); a refusal or a redirect resolves without execution, an acceptance only after it was carried out"
    );

    // ------------------------------------------------- 3b. the database agrees with the domain, combination by combination
    // (the domain is the executable specification of the rules: the function and the table must say the same)
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a test matrix, read as a table of combinations
    const parity = await asAdmin(async (client) => {
      const prepare = async (
        identityStatus: string,
        polarisRole: string,
        requesterKind: string
      ) => {
        const created = await openPrivacyCase(client, p1, {
          channel: "email",
          dueDays: 15,
          note: null,
          organizationId: orgA.organizationId,
          reason: "Paridade",
          receivedAt: null,
          requesterKind,
          requestType: "access",
        });
        assert.ok(created);
        await recordPrivacyIdentity(client, p1, created.id, {
          method: "other",
          status: identityStatus,
        });
        await recordPrivacyRole(client, p1, created.id, polarisRole);
        await recordPrivacyScope(client, p1, created.id, {
          categories: ["customers"],
          subjectReference: null,
        });
        return created.id;
      };
      let allowed = 0;
      let refusedCount = 0;
      for (const identityStatus of ["verified", "failed"] as const) {
        for (const polarisRole of ["controller", "processor"] as const) {
          for (const requesterKind of PRIVACY_REQUESTER_KINDS) {
            const facts = { identityStatus, polarisRole, requesterKind };
            const waiting = await prepare(
              identityStatus,
              polarisRole,
              requesterKind
            );
            for (const decision of PRIVACY_DECISIONS) {
              for (const reason of [
                null,
                "other",
                "identity_not_verified",
                "controller_is_reseller",
              ] as const) {
                let expected: string | null = null;
                try {
                  assertDecisionAllowed(facts, decision, reason);
                } catch (error) {
                  expected =
                    error instanceof InvalidPrivacyStepError
                      ? error.code
                      : "other";
                }
                const label = `${identityStatus}/${polarisRole}/${requesterKind}: ${decision} (${reason ?? "no reason"})`;
                if (expected === null) {
                  const fresh = await prepare(
                    identityStatus,
                    polarisRole,
                    requesterKind
                  );
                  const decided = await recordPrivacyDecision(
                    client,
                    p1,
                    fresh,
                    {
                      decision,
                      note: null,
                      reason,
                    }
                  );
                  assert.equal(
                    decided?.stage,
                    "decided",
                    `the database allows what the domain allows: ${label}`
                  );
                  allowed += 1;
                } else {
                  await assert.rejects(
                    () =>
                      recordPrivacyDecision(client, p1, waiting, {
                        decision,
                        note: null,
                        reason,
                      }),
                    refused(expected),
                    `the database refuses what the domain refuses, with the same code: ${label}`
                  );
                  refusedCount += 1;
                }
              }
            }
          }
        }
      }
      // what may be recorded as carried out, for each decision
      const decidedAs = async (decision: string, reason: string | null) => {
        const processor = decision === "redirect_to_controller";
        const id = await prepare(
          "verified",
          processor ? "processor" : "controller",
          "data_subject"
        );
        await recordPrivacyDecision(client, p1, id, {
          decision,
          note: null,
          reason,
        });
        return id;
      };
      const actionCases = {
        accept: await decidedAs("accept", null),
        partially_accept: await decidedAs("partially_accept", "other"),
        redirect_to_controller: await decidedAs(
          "redirect_to_controller",
          "controller_is_reseller"
        ),
        reject: await decidedAs("reject", "other"),
      } as const;
      let actionsChecked = 0;
      for (const [decision, caseId] of Object.entries(actionCases)) {
        for (const action of [
          "customer_anonymized",
          "organization_closed",
          "export_delivered",
          "purge_scheduled",
          "redirected_to_reseller",
          "no_action_required",
          "other",
        ] as const) {
          let expected: string | null = null;
          try {
            assertActionAllowed(decision as never, action);
          } catch (error) {
            expected =
              error instanceof InvalidPrivacyStepError ? error.code : "other";
          }
          if (expected === null) {
            const recorded = await recordPrivacyAction(client, p1, caseId, {
              action,
              entityId: null,
            });
            assert.equal(recorded?.stage, "executed", `${decision}: ${action}`);
          } else {
            await assert.rejects(
              () =>
                recordPrivacyAction(client, p1, caseId, {
                  action,
                  entityId: null,
                }),
              refused(expected),
              `${decision}: ${action} is refused with the domain's code`
            );
          }
          actionsChecked += 1;
        }
      }
      return { actionsChecked, allowed, refusedCount };
    });
    assert.ok(
      parity.allowed > 50 && parity.refusedCount > 100,
      "the matrix covers both sides"
    );
    assert.equal(parity.actionsChecked, 28);
    assert.equal(PRIVACY_DECISION_REASONS.length, 7);
    tests.push(
      `the database and the domain agree on every combination of identity result, Polaris's role, requester, decision and reason (${parity.allowed} allowed, ${parity.refusedCount} refused with the same code), and on what may be recorded as carried out for each decision (${parity.actionsChecked} pairs): a redirect is carried out by telling the controller, an acceptance does not redirect, a refusal has nothing to carry out`
    );

    // ------------------------------------------------- 4. carrying it out and resolving
    await decide(base, "accept");
    await assert.rejects(
      () => decide(base, "reject", "other"),
      refused("privacy_stage_conflict")
    );
    await assert.rejects(
      () => resolve(base),
      refused("privacy_stage_conflict")
    );
    await assert.rejects(
      () =>
        asAdmin((client) =>
          recordPrivacyAction(client, p1, base, {
            action: "erase_everything",
            entityId: null,
          })
        ),
      refused("invalid_privacy_step")
    );
    await assert.rejects(
      () =>
        asAdmin((client) =>
          recordPrivacyAction(client, p1, base, {
            action: "other",
            entityId: "Maria Souza",
          })
        ),
      refused("invalid_privacy_step"),
      "an action names a record only by its UUID"
    );
    const acted = await act(base);
    assert.equal(acted?.stage, "executed");
    await act(base, "export_delivered");
    // the case's access to the organization (granted for the case) ends with the case
    const access = await asAdmin((client) =>
      grantTenantAccess(client, p1, base, 30)
    );
    assert.ok(access);
    const done = await resolve(base, "Atendido");
    assert.equal(done?.stage, "resolved");
    assert.equal(
      done?.revokedGrants,
      1,
      "the temporary access granted for the case is revoked with it"
    );
    const [closed] = (
      await owner.pool.query<{ status: string; resolution: string | null }>(
        "SELECT status, resolution FROM public.support_cases WHERE id = $1",
        [base]
      )
    ).rows;
    assert.equal(closed?.status, "closed");
    assert.equal(closed?.resolution, "Atendido");
    for (const attempt of [
      () => identity(base),
      () => roleOf(base, "controller"),
      () => scope(base),
      () => decide(base, "accept"),
      () => act(base),
      () => resolve(base),
    ]) {
      await assert.rejects(
        attempt,
        refused("case_not_open"),
        "a resolved case takes no step"
      );
    }
    const detail = await asAdmin((client) => readPrivacyCase(client, base));
    assert.ok(detail);
    assert.equal(detail.privacy.stage, "resolved");
    assert.equal(detail.privacy.decision, "accept");
    assert.equal(detail.privacy.polarisRole, "controller");
    assert.equal(detail.privacy.identityStatus, "verified");
    assert.deepEqual(detail.privacy.scopeCategories, [
      "account",
      "authentication",
    ]);
    assert.equal(detail.privacy.subjectReference, subject);
    assert.equal(detail.privacy.overdue, false);
    assert.equal(detail.case.status, "closed");
    assert.deepEqual(
      detail.actions.map((entry) => entry.action),
      ["customer_anonymized", "export_delivered"]
    );
    assert.ok(detail.actions.every((entry) => entry.entityId === subject));
    assert.deepEqual(
      detail.audit.map((entry) => entry.eventType),
      [
        "support_case.opened",
        ...new Array<string>(5).fill("privacy_case.stage_recorded"),
        "privacy_case.action_recorded",
        "privacy_case.action_recorded",
        "tenant_access.granted",
        "privacy_case.stage_recorded",
        "support_case.closed",
      ],
      "every step left its audit record, in order"
    );
    assert.equal(
      await asAdmin((client) => readPrivacyCase(client, randomUUID())),
      null
    );
    tests.push(
      "an accepted request is carried out by recording each action (a known code and, at most, the UUID of the record acted on), and resolving it closes the support case, revokes the temporary access granted for it and leaves every step in the audit, in order; a resolved case takes no further step and its detail reads back whole"
    );

    // ------------------------------------------------- 5. the database refuses what the functions would not
    const poke = (sql: string, values: unknown[]) =>
      owner.pool.query(sql, values);
    const processorCase = await scoped("verified", "processor");
    await expectSqlState(
      () =>
        poke(
          "UPDATE public.privacy_cases SET stage = 'decided', decision = 'accept' WHERE support_case_id = $1",
          [processorCase]
        ),
      "23514",
      "the table itself refuses an acceptance of data Polaris only processes",
      "privacy_cases_decision_fits_facts"
    );
    const requestedOnly = await open();
    assert.ok(requestedOnly);
    await expectSqlState(
      () =>
        poke(
          "UPDATE public.privacy_cases SET stage = 'decided', identity_status = 'verified', identity_method = 'other', polaris_role = 'controller', scope_categories = ARRAY['account'], decision = 'reject', decision_reason = 'other' WHERE support_case_id = $1",
          [requestedOnly.id]
        ),
      "23514",
      "the table refuses a step that skips the ones before it, even with their data filled in"
    );
    await expectSqlState(
      () =>
        poke(
          "UPDATE public.privacy_cases SET stage = 'identity_checked' WHERE support_case_id = $1",
          [requestedOnly.id]
        ),
      "23514",
      "and a step without what it records",
      "privacy_cases_steps_in_order"
    );
    await expectSqlState(
      () =>
        poke(
          "UPDATE public.privacy_cases SET stage = 'requested' WHERE support_case_id = $1",
          [processorCase]
        ),
      "23514",
      "a case never moves backwards"
    );
    await expectSqlState(
      () =>
        poke(
          "UPDATE public.privacy_cases SET polaris_role = 'controller' WHERE support_case_id = $1",
          [processorCase]
        ),
      "23514",
      "a step already recorded is not changed"
    );
    await expectSqlState(
      () =>
        poke(
          "UPDATE public.privacy_cases SET due_at = due_at + interval '1 day' WHERE support_case_id = $1",
          [processorCase]
        ),
      "23514",
      "the due date does not move"
    );
    await expectSqlState(
      () =>
        poke(
          "UPDATE public.privacy_cases SET stage = 'scoped', note = 'x' WHERE support_case_id = $1",
          [processorCase]
        ),
      "23514",
      "nor does the note"
    );
    await expectSqlState(
      () =>
        poke(
          "UPDATE public.privacy_cases SET decision_note = 'x' WHERE support_case_id = $1",
          [base]
        ),
      "23514",
      "a resolved case is final"
    );
    await expectSqlState(
      () =>
        poke(
          "UPDATE public.privacy_case_actions SET action = 'other' WHERE support_case_id = $1",
          [base]
        ),
      "23514",
      "the actions are append-only (no update)"
    );
    await expectSqlState(
      () =>
        poke(
          "DELETE FROM public.privacy_case_actions WHERE support_case_id = $1",
          [base]
        ),
      "23514",
      "(no delete)"
    );
    await expectSqlState(
      () => poke("TRUNCATE public.privacy_case_actions", []),
      "23514",
      "(no truncate)"
    );
    tests.push(
      "straight at the database nothing can skip a step, go backwards, change a step already recorded or the due date or the note, change a resolved case, accept data Polaris only processes on a third party's word, or change or delete an action"
    );

    // ------------------------------------------------- 6. reading and being late
    const late = await open({ receivedAt: new Date(Date.now() - 20 * DAY_MS) });
    assert.ok(late);
    const lateDetail = await asAdmin((client) =>
      readPrivacyCase(client, late.id)
    );
    assert.equal(
      lateDetail?.privacy.overdue,
      true,
      "twenty days after it arrived, a fifteen-day case is late"
    );
    const overdue = await asAdmin((client) =>
      listPrivacyCases(client, { after: null, filter: "overdue", limit: 50 })
    );
    assert.ok(
      overdue.cases.some((entry) => entry.id === late.id && entry.overdue)
    );
    assert.ok(
      overdue.cases.every(
        (entry) => entry.overdue && entry.stage !== "resolved"
      )
    );
    assert.ok(
      !overdue.cases.some((entry) => entry.id === base),
      "a resolved case is never late"
    );
    const openCases = await asAdmin((client) =>
      listPrivacyCases(client, { after: null, filter: "open", limit: 50 })
    );
    assert.ok(openCases.cases.every((entry) => entry.status === "open"));
    assert.ok(openCases.cases.some((entry) => entry.id === late.id));
    const closedCases = await asAdmin((client) =>
      listPrivacyCases(client, { after: null, filter: "closed", limit: 50 })
    );
    assert.ok(closedCases.cases.some((entry) => entry.id === base));
    assert.ok(closedCases.cases.every((entry) => entry.status === "closed"));
    const everything = await asAdmin((client) =>
      listPrivacyCases(client, { after: null, filter: null, limit: 50 })
    );
    const ids = everything.cases.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
    const firstPage = await asAdmin((client) =>
      listPrivacyCases(client, { after: null, filter: null, limit: 2 })
    );
    assert.equal(firstPage.cases.length, 2);
    assert.ok(firstPage.next);
    const secondPage = await asAdmin((client) =>
      listPrivacyCases(client, {
        after: firstPage.next,
        filter: null,
        limit: 2,
      })
    );
    assert.ok(
      secondPage.cases.every(
        (entry) => !firstPage.cases.some((seen) => seen.id === entry.id)
      ),
      "paging does not repeat a case"
    );
    await assert.rejects(
      () =>
        asAdmin((client) =>
          listPrivacyCases(client, { after: null, filter: "open", limit: 0 })
        ),
      refused("invalid_request")
    );
    // the generic support case list still shows a privacy case, with its kind
    const supportDetail = await asAdmin((client) =>
      readSupportCase(client, late.id)
    );
    assert.equal(supportDetail?.case.kind, "privacy");
    tests.push(
      "the list filters open, closed and late cases and pages without repeating; a case is late when it is still open past its due date (counted from when the request arrived), and a resolved case never is; the generic case read still shows a privacy case"
    );

    // ------------------------------------------------- 7. nothing personal is kept, and who may reach what
    const audit = await owner.pool.query<{
      detail: string | null;
      event_type: string;
    }>(
      "SELECT event_type, detail FROM public.platform_audit_events WHERE support_case_id = $1 AND (event_type LIKE 'privacy_case.%' OR event_type LIKE 'support_case.%')",
      [base]
    );
    assert.ok(audit.rows.length > 0);
    for (const entry of audit.rows) {
      assert.ok(
        entry.detail === null || AUDIT_DETAIL_CODES.test(entry.detail),
        `an audit detail holds codes only (${entry.event_type})`
      );
    }
    const leaked = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.platform_audit_events WHERE to_jsonb(platform_audit_events)::text LIKE '%' || $1 || '%'",
      [NOTE_MARKER]
    );
    assert.equal(
      Number(leaked.rows[0]?.count),
      0,
      "the note stays on the case and never reaches the audit"
    );
    const tableReach = await owner.pool.query<{ allowed: boolean }>(
      `SELECT (has_any_column_privilege('polaris_admin_runtime', 'public.privacy_cases', 'SELECT, INSERT, UPDATE, REFERENCES')
            OR has_any_column_privilege('polaris_admin_runtime', 'public.privacy_case_actions', 'SELECT, INSERT, UPDATE, REFERENCES')
            OR has_table_privilege('polaris_admin_runtime', 'public.privacy_cases', 'DELETE, TRUNCATE')) AS allowed`
    );
    assert.equal(
      tableReach.rows[0]?.allowed,
      false,
      "the Admin role reads and writes none of the privacy tables"
    );
    const functions = [
      "admin_open_privacy_case(uuid, text, text, text, text, text, timestamptz, text, integer)",
      "admin_privacy_record_identity(uuid, uuid, text, text)",
      "admin_privacy_record_role(uuid, uuid, text)",
      "admin_privacy_record_scope(uuid, uuid, text[], text)",
      "admin_privacy_record_decision(uuid, uuid, text, text, text)",
      "admin_privacy_record_action(uuid, uuid, text, text)",
      "admin_privacy_resolve(uuid, uuid, text)",
      "admin_privacy_case_detail(uuid)",
      "admin_list_privacy_cases(text, integer, uuid)",
    ];
    const grantee = async (name: string, signature: string) =>
      (
        await owner.pool.query<{ allowed: boolean }>(
          "SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS allowed",
          [name, `public.${signature}`]
        )
      ).rows[0]?.allowed;
    await Promise.all(
      functions.flatMap((signature) =>
        [
          "polaris_pr11_runtime",
          "polaris_billing_runtime",
          "polaris_catalog_runtime",
          "polaris_privacy_runtime",
          "polaris_admin_runtime",
        ].map(async (name) =>
          assert.equal(
            await grantee(name, signature),
            name === "polaris_admin_runtime",
            `${name} on ${signature}`
          )
        )
      )
    );
    assert.equal(
      await grantee("polaris_admin_runtime", "admin_lock_privacy_case(uuid)"),
      false,
      "the internal lock is not callable"
    );
    const ownerPolicies = await owner.pool.query<{ policyname: string }>(
      "SELECT policyname FROM pg_policies WHERE tablename IN ('privacy_cases', 'privacy_case_actions') ORDER BY policyname"
    );
    assert.deepEqual(
      ownerPolicies.rows.map((entry) => entry.policyname),
      [
        "privacy_case_actions_admin_owner_insert",
        "privacy_case_actions_admin_owner_select",
        "privacy_cases_admin_owner_insert",
        "privacy_cases_admin_owner_select",
        "privacy_cases_admin_owner_update",
      ]
    );
    const forced = await owner.pool.query<{
      relname: string;
      relforcerowsecurity: boolean;
    }>(
      "SELECT relname, relforcerowsecurity FROM pg_class WHERE oid IN ('public.privacy_cases'::regclass, 'public.privacy_case_actions'::regclass) ORDER BY relname"
    );
    assert.ok(forced.rows.every((entry) => entry.relforcerowsecurity));
    const updatable = await owner.pool.query<{ column_name: string }>(
      `SELECT DISTINCT column_name FROM information_schema.column_privileges
        WHERE grantee = 'polaris_admin_owner' AND table_schema = 'public' AND table_name = 'privacy_cases' AND privilege_type = 'UPDATE'
        ORDER BY column_name`
    );
    assert.deepEqual(
      updatable.rows.map((entry) => entry.column_name),
      [
        "decision",
        "decision_note",
        "decision_reason",
        "identity_method",
        "identity_status",
        "polaris_role",
        "resolved_at",
        "scope_categories",
        "stage",
        "subject_reference",
        "updated_at",
      ]
    );
    tests.push(
      "the audit holds codes only and never the note typed on the case; the Admin role reads and writes none of the privacy tables and executes exactly the nine workflow functions (no other service role does, and the internal lock is not callable); the tables are row-level secured and forced, the function owner has only the policies and the updatable columns the workflow needs"
    );

    console.log(
      JSON.stringify(
        {
          branch,
          database: serverRow.database_name,
          serverVersion: serverRow.server_version,
          status: "passed",
          tests,
        },
        null,
        2
      )
    );
  } finally {
    for (const [role, group] of logins) {
      await owner.pool.query(`REVOKE "${group}" FROM "${role}"`);
      await owner.pool.query(`DROP ROLE IF EXISTS "${role}"`);
    }
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Privacy cases PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
