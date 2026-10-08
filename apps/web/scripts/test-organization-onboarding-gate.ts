import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase } from "@polaris/db/client";
import {
  CreateInitialOrganizationError,
  createInitialOrganization,
} from "../src/server/use-cases/create-initial-organization";

const expectedNeonHostnamePattern =
  /^ep-[a-z-]+-[a-z0-9]+\.c-2\.sa-east-1\.aws\.neon\.tech$/;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

async function main() {
  const connectionString = requiredEnvironment(
    "POLARIS_ORGANIZATION_TEST_DATABASE_URL"
  );
  const expectedHostname = requiredEnvironment(
    "POLARIS_ORGANIZATION_TEST_EXPECTED_HOSTNAME"
  );
  if (
    process.env.POLARIS_ORGANIZATION_TEST_CONFIRM_DISPOSABLE !==
    "pr18-sessions-gate"
  ) {
    throw new Error(
      "Set POLARIS_ORGANIZATION_TEST_CONFIRM_DISPOSABLE=pr18-sessions-gate only for the disposable Neon branch."
    );
  }

  const databaseUrl = new URL(connectionString);
  assert.equal(databaseUrl.hostname, expectedHostname);
  assert.equal(databaseUrl.pathname, "/neondb");
  assert.equal(databaseUrl.hostname.includes("-pooler"), false);
  assert.match(databaseUrl.hostname, expectedNeonHostnamePattern);

  const { db, pool } = createDatabase(connectionString, { maxConnections: 5 });
  const fixtureUserIds: string[] = [];
  const fixtureOrganizationIds: string[] = [];

  async function createUser(emailVerified: boolean): Promise<string> {
    const id = randomUUID();
    fixtureUserIds.push(id);
    await pool.query(
      'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, $4)',
      [id, "PR20 onboarding gate", `pr20-${id}@example.invalid`, emailVerified]
    );
    return id;
  }

  try {
    const identity = await pool.query<{
      database: string;
      serverVersion: string;
    }>(
      `SELECT current_database() AS database,
              current_setting('server_version') AS "serverVersion"`
    );
    assert.equal(identity.rows[0]?.database, "neondb");
    assert.equal(
      Number.parseInt(identity.rows[0]?.serverVersion.split(".")[0] ?? "", 10),
      18,
      "The onboarding gate requires PostgreSQL 18."
    );
    const runtimePrivileges = await pool.query<{
      membershipsSelect: boolean;
      organizationsInsert: boolean;
      organizationsSelect: boolean;
    }>(`SELECT has_table_privilege('polaris_pr11_runtime', 'public.memberships', 'SELECT') AS "membershipsSelect",
             has_table_privilege('polaris_pr11_runtime', 'public.organizations', 'SELECT') AS "organizationsSelect",
             has_table_privilege('polaris_pr11_runtime', 'public.organizations', 'INSERT') AS "organizationsInsert"`);
    assert.deepEqual(runtimePrivileges.rows[0], {
      membershipsSelect: false,
      organizationsInsert: false,
      organizationsSelect: false,
    });

    const verifiedUserId = await createUser(true);
    const first = await createInitialOrganization(db, {
      authenticatedUserId: verifiedUserId,
      name: "  Polaris Gate  ",
      timezone: "America/Sao_Paulo",
    });
    assert.equal(first.created, true);
    assert.equal(first.organization.name, "Polaris Gate");
    assert.equal(first.organization.timezone, "America/Sao_Paulo");
    assert.equal(first.organization.currency, "BRL");
    assert.equal(first.organization.status, "active");
    fixtureOrganizationIds.push(first.organization.id);

    const retry = await createInitialOrganization(db, {
      authenticatedUserId: verifiedUserId,
      name: "A changed retry must not mutate the first organization",
      timezone: "Etc/UTC",
    });
    assert.equal(retry.created, false);
    assert.equal(retry.organization.id, first.organization.id);
    assert.equal(retry.organization.name, "Polaris Gate");
    assert.equal(retry.organization.timezone, "America/Sao_Paulo");

    const verifiedMemberships = await pool.query<{
      organizationId: string;
      role: string;
      status: string;
    }>(
      `SELECT organization_id AS "organizationId", role, status
       FROM public.memberships WHERE user_id = $1`,
      [verifiedUserId]
    );
    assert.deepEqual(verifiedMemberships.rows, [
      {
        organizationId: first.organization.id,
        role: "owner",
        status: "active",
      },
    ]);

    const concurrentUserId = await createUser(true);
    const concurrentResults = await Promise.all([
      createInitialOrganization(db, {
        authenticatedUserId: concurrentUserId,
        name: "Concurrent request A",
        timezone: "America/Sao_Paulo",
      }),
      createInitialOrganization(db, {
        authenticatedUserId: concurrentUserId,
        name: "Concurrent request B",
        timezone: "Etc/UTC",
      }),
    ]);
    assert.equal(
      concurrentResults[0].organization.id,
      concurrentResults[1].organization.id
    );
    assert.equal(
      concurrentResults.filter((result) => result.created).length,
      1
    );
    fixtureOrganizationIds.push(concurrentResults[0].organization.id);

    const concurrentMemberships = await pool.query<{
      organizationId: string;
    }>(
      `SELECT organization_id AS "organizationId"
       FROM public.memberships WHERE user_id = $1`,
      [concurrentUserId]
    );
    assert.deepEqual(concurrentMemberships.rows, [
      { organizationId: concurrentResults[0].organization.id },
    ]);

    const unverifiedUserId = await createUser(false);
    await assert.rejects(
      createInitialOrganization(db, {
        authenticatedUserId: unverifiedUserId,
        name: "Must be rejected",
        timezone: "America/Sao_Paulo",
      }),
      (error: unknown) =>
        error instanceof CreateInitialOrganizationError &&
        error.code === "email_not_verified"
    );

    await assert.rejects(
      createInitialOrganization(db, {
        authenticatedUserId: randomUUID(),
        name: "Missing user",
        timezone: "America/Sao_Paulo",
      }),
      (error: unknown) =>
        error instanceof CreateInitialOrganizationError &&
        error.code === "user_not_found"
    );

    await assert.rejects(
      createInitialOrganization(db, {
        authenticatedUserId: verifiedUserId,
        name: "Invalid timezone",
        timezone: "Mars/Olympus_Mons",
      }),
      (error: unknown) =>
        error instanceof CreateInitialOrganizationError &&
        error.code === "invalid_timezone"
    );

    const preexistingMultipleMembershipUserId = await createUser(true);
    const preexistingOrganizationIds = [randomUUID(), randomUUID()];
    fixtureOrganizationIds.push(...preexistingOrganizationIds);
    await pool.query(
      `INSERT INTO public.organizations (id, name, timezone)
       VALUES ($1, $2, 'Etc/UTC'), ($3, $4, 'Etc/UTC')`,
      [
        preexistingOrganizationIds[0],
        "Existing organization 1",
        preexistingOrganizationIds[1],
        "Existing organization 2",
      ]
    );
    await pool.query(
      `INSERT INTO public.memberships (organization_id, user_id)
       VALUES ($1, $3), ($2, $3)`,
      [
        preexistingOrganizationIds[0],
        preexistingOrganizationIds[1],
        preexistingMultipleMembershipUserId,
      ]
    );
    await assert.rejects(
      createInitialOrganization(db, {
        authenticatedUserId: preexistingMultipleMembershipUserId,
        name: "Must not create a third organization",
        timezone: "America/Sao_Paulo",
      }),
      (error: unknown) =>
        error instanceof CreateInitialOrganizationError &&
        error.code === "multiple_existing_organizations"
    );

    console.log("organization_create=passed");
    console.log("organization_retry_same_user=passed");
    console.log("organization_concurrent_same_user=passed");
    console.log("organization_verified_email_and_timezone=passed");
    console.log("organization_existing_multi_membership_guard=passed");
  } finally {
    try {
      const linkedOrganizations = fixtureUserIds.length
        ? await pool.query<{ organizationId: string }>(
            `SELECT organization_id AS "organizationId"
             FROM public.memberships WHERE user_id = ANY($1::text[])`,
            [fixtureUserIds]
          )
        : { rows: [] };
      const cleanupIds = [
        ...new Set([
          ...fixtureOrganizationIds,
          ...linkedOrganizations.rows.map((item) => item.organizationId),
        ]),
      ];
      if (cleanupIds.length) {
        await pool.query(
          "DELETE FROM public.organizations WHERE id = ANY($1::text[])",
          [cleanupIds]
        );
      }
      if (fixtureUserIds.length) {
        await pool.query(
          'DELETE FROM public."user" WHERE id = ANY($1::text[])',
          [fixtureUserIds]
        );
      }
      if (cleanupIds.length) {
        const remainingOrganizations = await pool.query(
          "SELECT id FROM public.organizations WHERE id = ANY($1::text[])",
          [cleanupIds]
        );
        assert.equal(remainingOrganizations.rows.length, 0);
      }
      if (fixtureUserIds.length) {
        const remainingUsers = await pool.query(
          'SELECT id FROM public."user" WHERE id = ANY($1::text[])',
          [fixtureUserIds]
        );
        assert.equal(remainingUsers.rows.length, 0);
      }
    } finally {
      await pool.end();
    }
  }
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : "UnknownError";
  const databaseUrl = process.env.POLARIS_ORGANIZATION_TEST_DATABASE_URL ?? "";
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(
    "organization_onboarding_gate=failed",
    name,
    message.replaceAll(databaseUrl, "[redacted]")
  );
  process.exitCode = 1;
});
