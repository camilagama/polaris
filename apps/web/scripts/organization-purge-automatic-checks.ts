// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  cancelOrganizationPurge,
  grantTenantAccess,
  openPrivacyCase,
  openSupportCase,
  placeOrganizationLegalHold,
  recordPrivacyDecision,
  recordPrivacyIdentity,
  recordPrivacyRole,
  recordPrivacyScope,
  readSupportCase,
  releaseOrganizationLegalHold,
  scheduleOrganizationPurge,
} from "@polaris/db/admin-support-repository";
import type { createDatabase } from "@polaris/db/client";
import type { createPrivacyMaintenanceClient } from "@polaris/db/privacy-maintenance";
import {
  CLOSURE_PURGE_GRACE_HOURS,
  CLOSURE_PURGE_MIN_NOTICE_DAYS,
  closureDeadlines,
  closurePurgeNotBefore,
} from "@polaris/domain/organization/closure-deadlines";
import { ORGANIZATION_PURGE_REQUIRED_SCOPE } from "@polaris/domain/privacy/organization-purge";
import {
  createTenantFixture,
  expectSqlState,
} from "../../../packages/db/scripts/sales-gate-support";
import type { MediaBucketBinding } from "../src/server/environment";
import { runPrivacyMaintenance } from "../src/server/privacy/maintenance";
import { runOrganizationPurges } from "../src/server/privacy/organization-purge-job";

/**
 * The automatic purge of a closed organization (ADR 0102, AC-47, AC-59, AC-61 and AC-62) on a real PostgreSQL 18, with
 * the real job: the clock is the database's, and each closure is written with the request instant the case needs.
 * D is the local date of the request plus 90 calendar days; the purge is scheduled from D minus 7 local days and never
 * runs before the later of D plus 48 hours and the schedule plus 7 days.
 */

type Pool = ReturnType<typeof createDatabase>["pool"];

export interface AutomaticPurgeContext {
  admin: Pool;
  bucket: Pick<MediaBucketBinding, "delete" | "get" | "list" | "put">;
  /** A second connection of the privacy runtime, for the run that races the first. */
  concurrent: ReturnType<typeof createPrivacyMaintenanceClient>;
  maintenance: ReturnType<typeof createPrivacyMaintenanceClient>;
  owner: Pool;
  principal: string;
  /** Logins of the other runtimes, to prove they cannot run the schedule. */
  runtimes: { admin: Pool; tenant: Pool };
}

const ZONE = "America/Sao_Paulo";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Every organization this scenario writes, so the checks read only their own. */
const created: string[] = [];

async function dbNow(owner: Pool): Promise<Date> {
  const result = await owner.query<{ now: Date }>("SELECT now() AS now");
  const now = result.rows[0]?.now;
  assert.ok(now);
  return new Date(now);
}

/** The first instant of the local day `offset` days from today's local date in the zone, as the database counts it. */
async function localDayStart(
  owner: Pool,
  zone: string,
  offset: number
): Promise<Date> {
  const result = await owner.query<{ start: Date }>(
    "SELECT public.closure_local_day_start((now() AT TIME ZONE $1)::date + $2::integer, $1) AS start",
    [zone, offset]
  );
  const start = result.rows[0]?.start;
  assert.ok(start);
  return new Date(start);
}

/** A closed organization whose closure was requested at `requestedAt`, its recovery window over unless `recoverUntil` says otherwise. */
async function closedOrganization(
  owner: Pool,
  label: string,
  requestedAt: Date,
  options: { recoverUntil?: Date; zone?: string } = {}
): Promise<{ organizationId: string; userId: string }> {
  const zone = options.zone ?? ZONE;
  const tenant = await createTenantFixture(
    owner,
    `automatic purge ${label}`,
    zone
  );
  const recoverUntil =
    options.recoverUntil ?? new Date(requestedAt.getTime() + 30 * DAY_MS);
  const now = await dbNow(owner);
  await owner.query(
    `INSERT INTO public.organization_closures (organization_id, requested_at, recover_until, closed_at, requested_by_user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      tenant.organizationId,
      requestedAt,
      recoverUntil,
      recoverUntil < now ? recoverUntil : now,
      tenant.userId,
    ]
  );
  await owner.query(
    "UPDATE public.organizations SET status = 'closed' WHERE id = $1",
    [tenant.organizationId]
  );
  created.push(tenant.organizationId);
  return tenant;
}

async function statusOf(owner: Pool, organizationId: string): Promise<string> {
  const result = await owner.query<{ status: string }>(
    "SELECT status FROM public.organizations WHERE id = $1",
    [organizationId]
  );
  return result.rows[0]?.status ?? "";
}

interface PurgeRow {
  not_before: Date;
  privacy_case_id: string | null;
  scheduled_at: Date;
  scheduled_by: string | null;
  support_case_id: string | null;
  trigger: string;
}

async function purgeRow(
  owner: Pool,
  organizationId: string
): Promise<PurgeRow | undefined> {
  const result = await owner.query<PurgeRow>(
    "SELECT trigger, scheduled_by, support_case_id, privacy_case_id, scheduled_at, not_before FROM public.organization_purges WHERE organization_id = $1",
    [organizationId]
  );
  return result.rows[0];
}

async function scheduledAudit(owner: Pool, organizationId: string) {
  return (
    await owner.query<{
      actor: string;
      detail: string | null;
      entity_id: string;
      principal_id: string | null;
      support_case_id: string | null;
    }>(
      "SELECT actor, principal_id, support_case_id, entity_id, detail FROM public.platform_audit_events WHERE organization_id = $1 AND event_type = 'organization.purge_scheduled' ORDER BY id",
      [organizationId]
    )
  ).rows;
}

async function asRole(
  owner: Pool,
  role: string,
  statement: string,
  values: unknown[] = []
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    return await client.query(statement, values);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/** Waits past local midnight when the run is about to cross it: "today" must be the same day for the whole scenario. */
async function awayFromMidnight(owner: Pool) {
  const result = await owner.query<{ seconds: number }>(
    "SELECT EXTRACT(epoch FROM public.closure_local_day_start((now() AT TIME ZONE $1)::date + 1, $1) - now())::float8 AS seconds",
    [ZONE]
  );
  const seconds = Number(result.rows[0]?.seconds ?? 0);
  if (seconds < 300) {
    await new Promise((resolve) => setTimeout(resolve, (seconds + 2) * 1000));
  }
}

async function acceptedDeletionCase(
  context: AutomaticPurgeContext,
  organizationId: string
): Promise<string> {
  const { admin, principal } = context;
  const opened = await openPrivacyCase(admin, principal, {
    channel: "email",
    dueDays: 15,
    note: null,
    organizationId,
    reason: "Pedido de exclusão da organização",
    receivedAt: null,
    requesterKind: "organization_owner",
    requestType: "deletion",
  });
  assert.ok(opened);
  await recordPrivacyIdentity(admin, principal, opened.id, {
    method: "owner_confirmation",
    status: "verified",
  });
  await recordPrivacyRole(admin, principal, opened.id, "controller");
  await recordPrivacyScope(admin, principal, opened.id, {
    categories: [...ORGANIZATION_PURGE_REQUIRED_SCOPE],
    subjectReference: null,
  });
  await recordPrivacyDecision(admin, principal, opened.id, {
    decision: "accept",
    note: null,
    reason: null,
  });
  return opened.id;
}

async function supportCaseOf(
  context: AutomaticPurgeContext,
  organizationId: string
): Promise<string> {
  const opened = await openSupportCase(context.admin, context.principal, {
    context: null,
    kind: "support",
    organizationId,
    reason: "Acompanhar o apagamento automático",
  });
  assert.ok(opened);
  return opened.id;
}

export async function verifyAutomaticPurge(
  context: AutomaticPurgeContext
): Promise<string[]> {
  const { maintenance, owner } = context;
  const tests: string[] = [];
  await awayFromMidnight(owner);

  // other gates (and the purge above) may leave closed organizations past D minus 7: they must not be scheduled by
  // this run, so their closure is moved to a month ago (still closed, window over, D far ahead)
  await owner.query(
    `UPDATE public.organization_closures AS closure
        SET requested_at = now() - interval '31 days', recover_until = now() - interval '1 day'
       FROM public.organizations AS organization
      WHERE organization.id = closure.organization_id AND organization.status = 'closed'`
  );
  const schedule = () => maintenance.scheduleClosedOrganizationPurges(1000);
  assert.deepEqual((await schedule()).scheduled, 0);

  // the edge, to the second, in the organization's calendar: a request at 00:00:00 of the local day 82 days ago puts
  // D minus 7 at the start of tomorrow (not yet); one at 23:59:59 of the day before puts it at the start of today
  const day82 = await localDayStart(owner, ZONE, -82);
  const notYet = await closedOrganization(owner, "day 82", day82);
  const lastSecond = new Date(day82.getTime() - 1000);
  const onTime = await closedOrganization(owner, "day 83", lastSecond);
  // a sweep 5 days late: D minus 7 was 5 local days ago, D plus 48 hours is 4 days away, so the notice of 7 days rules
  const late = await closedOrganization(
    owner,
    "late sweep",
    await localDayStart(owner, ZONE, -88)
  );
  // Manaus (no daylight saving time) and New York (with it): D minus 7 is today in their own calendars
  const manausRequest = new Date(
    (await localDayStart(owner, "America/Manaus", -82)).getTime() - 1000
  );
  const manaus = await closedOrganization(owner, "manaus", manausRequest, {
    zone: "America/Manaus",
  });
  const newYorkRequest = new Date(
    (await localDayStart(owner, "America/New_York", -82)).getTime() - 1000
  );
  const newYork = await closedOrganization(owner, "new york", newYorkRequest, {
    zone: "America/New_York",
  });
  // the recovery window is not over (a second less than the end is enough): not scheduled, whatever D says
  const windowOpen = await closedOrganization(
    owner,
    "window open",
    await localDayStart(owner, ZONE, -85),
    { recoverUntil: new Date((await dbNow(owner)).getTime() + HOUR_MS) }
  );
  // closed, undone and closed again: the request of the new cycle counts, not the first one
  const reclosed = await closedOrganization(
    owner,
    "closed again",
    new Date((await dbNow(owner)).getTime() - 40 * DAY_MS)
  );

  const first = await schedule();
  const scheduledIds = [onTime, late, manaus, newYork].map(
    (tenant) => tenant.organizationId
  );
  for (const tenant of [notYet, windowOpen, reclosed]) {
    assert.equal(await statusOf(owner, tenant.organizationId), "closed");
    assert.equal(await purgeRow(owner, tenant.organizationId), undefined);
  }
  for (const organizationId of scheduledIds) {
    assert.equal(await statusOf(owner, organizationId), "purge_pending");
  }
  assert.equal(first.scheduled, scheduledIds.length);
  assert.ok(first.scheduledLastDay >= scheduledIds.length);
  tests.push(
    "the purge is scheduled from D minus 7 local days, to the second: a request at 00:00:00 of the local day 82 days ago is not, one at 23:59:59 of the day before is (also in America/Manaus and in a zone with daylight saving time); never while the recovery window is open, and a closure undone and requested again counts from its new request"
  );

  // the date it may run: the later of D plus 48 hours and the schedule plus 7 days, as the domain computes it
  const expectNotBefore = async (
    organizationId: string,
    requestedAt: Date,
    zone: string
  ) => {
    const row = await purgeRow(owner, organizationId);
    assert.ok(row);
    const expected = closurePurgeNotBefore(
      requestedAt,
      zone,
      new Date(row.scheduled_at)
    );
    assert.equal(
      new Date(row.not_before).toISOString(),
      expected.toISOString(),
      `${organizationId}: not_before`
    );
    const { deletableFrom } = closureDeadlines(requestedAt, zone);
    assert.ok(
      new Date(row.not_before).getTime() >=
        deletableFrom.getTime() + CLOSURE_PURGE_GRACE_HOURS * HOUR_MS
    );
    assert.ok(
      new Date(row.not_before).getTime() >=
        new Date(row.scheduled_at).getTime() +
          CLOSURE_PURGE_MIN_NOTICE_DAYS * DAY_MS
    );
    return row;
  };
  const onTimeRow = await expectNotBefore(
    onTime.organizationId,
    lastSecond,
    ZONE
  );
  assert.equal(
    new Date(onTimeRow.not_before).getTime(),
    closureDeadlines(lastSecond, ZONE).deletableFrom.getTime() +
      CLOSURE_PURGE_GRACE_HOURS * HOUR_MS,
    "on time, the purge waits until D plus 48 hours"
  );
  const lateRow = await expectNotBefore(
    late.organizationId,
    await localDayStart(owner, ZONE, -88),
    ZONE
  );
  assert.equal(
    new Date(lateRow.not_before).getTime(),
    new Date(lateRow.scheduled_at).getTime() +
      CLOSURE_PURGE_MIN_NOTICE_DAYS * DAY_MS,
    "late, the purge waits 7 days after the schedule"
  );
  await expectNotBefore(manaus.organizationId, manausRequest, "America/Manaus");
  await expectNotBefore(
    newYork.organizationId,
    newYorkRequest,
    "America/New_York"
  );
  tests.push(
    "not_before is exactly the later of D plus 48 hours and the schedule plus 7 days, as the domain computes it, with the sweep on time and with the sweep late"
  );

  // the row and the audit of the system: no operator, no case, no privacy case
  assert.deepEqual(
    {
      privacy: onTimeRow.privacy_case_id,
      scheduledBy: onTimeRow.scheduled_by,
      support: onTimeRow.support_case_id,
      trigger: onTimeRow.trigger,
    },
    {
      privacy: null,
      scheduledBy: null,
      support: null,
      trigger: "closure_period",
    }
  );
  assert.deepEqual(await scheduledAudit(owner, onTime.organizationId), [
    {
      actor: "system",
      detail: null,
      entity_id: onTime.organizationId,
      principal_id: null,
      support_case_id: null,
    },
  ]);
  tests.push(
    "the schedule of the closure period has no operator, no case and no privacy case, and is audited once as the system's, with IDs only"
  );

  // running again changes nothing, and two runs at once schedule each organization once
  assert.equal((await schedule()).scheduled, 0);
  const raced = await Promise.all([
    closedOrganization(owner, "race a", lastSecond),
    closedOrganization(owner, "race b", lastSecond),
    closedOrganization(owner, "race c", lastSecond),
  ]);
  const [left, right] = await Promise.all([
    maintenance.scheduleClosedOrganizationPurges(1000),
    context.concurrent.scheduleClosedOrganizationPurges(1000),
  ]);
  assert.equal(left.scheduled + right.scheduled, raced.length);
  for (const tenant of raced) {
    assert.equal(await statusOf(owner, tenant.organizationId), "purge_pending");
    assert.equal(
      (await scheduledAudit(owner, tenant.organizationId)).length,
      1
    );
  }
  tests.push(
    "a second run schedules nothing more, and two runs at once schedule each organization once, with one audit event each"
  );

  // what makes it wait: a legal hold, a live temporary access of the Admin, a cancellation of the Admin in this closure,
  // a renewal still alive at a provider. A cancellation of an earlier closure does not, nor a paid access that only
  // has to run out (no provider, or the renewal already cancelled)
  const held = await closedOrganization(owner, "held", lastSecond);
  await placeOrganizationLegalHold(
    context.admin,
    context.principal,
    await supportCaseOf(context, held.organizationId),
    held.organizationId,
    new Date(Date.now() + 30 * DAY_MS).toISOString()
  );
  const accessed = await closedOrganization(owner, "accessed", lastSecond);
  await grantTenantAccess(
    context.admin,
    context.principal,
    await supportCaseOf(context, accessed.organizationId),
    30
  );
  const cancelledNow = await closedOrganization(
    owner,
    "cancelled now",
    lastSecond
  );
  const cancelledBefore = await closedOrganization(
    owner,
    "cancelled before",
    lastSecond
  );
  const cancellation = async (organizationId: string, at: Date) => {
    const caseId = await supportCaseOf(context, organizationId);
    await owner.query(
      `INSERT INTO public.organization_purge_cancellations (organization_id, support_case_id, cancelled_by, reason, scheduled_at, cancelled_at)
       VALUES ($1, $2, $3, 'Cancelado no gate', $4, $4)`,
      [organizationId, caseId, context.principal, at]
    );
  };
  await cancellation(cancelledNow.organizationId, await dbNow(owner));
  await cancellation(
    cancelledBefore.organizationId,
    new Date(lastSecond.getTime() - DAY_MS)
  );
  const billing = async (
    organizationId: string,
    values: { cancelAtPeriodEnd: boolean; provider: boolean; state: string }
  ) => {
    await owner.query(
      `UPDATE public.organization_billing
          SET state = $2, provider = $3, provider_ref = $4, cancel_at_period_end = $5,
              trial_started_at = CASE WHEN $2 = 'trialing' THEN now() - interval '10 days' ELSE trial_started_at END
        WHERE organization_id = $1`,
      [
        organizationId,
        values.state,
        values.provider ? "asaas" : null,
        values.provider ? `sub_gate_${randomUUID().slice(0, 8)}` : null,
        values.cancelAtPeriodEnd,
      ]
    );
  };
  const renewalAliveActive = await closedOrganization(
    owner,
    "renewal alive",
    lastSecond
  );
  await billing(renewalAliveActive.organizationId, {
    cancelAtPeriodEnd: false,
    provider: true,
    state: "active",
  });
  const renewalAliveGrace = await closedOrganization(
    owner,
    "renewal alive in grace",
    lastSecond
  );
  await billing(renewalAliveGrace.organizationId, {
    cancelAtPeriodEnd: false,
    provider: true,
    state: "grace",
  });
  const renewalCancelled = await closedOrganization(
    owner,
    "renewal cancelled",
    lastSecond
  );
  await billing(renewalCancelled.organizationId, {
    cancelAtPeriodEnd: true,
    provider: true,
    state: "active",
  });
  // the fixture's billing: Pro until a year from now, no provider (paid access running, nothing to cancel)
  const paidNoProvider = await closedOrganization(
    owner,
    "paid without provider",
    lastSecond
  );
  await schedule();
  for (const tenant of [
    held,
    accessed,
    cancelledNow,
    renewalAliveActive,
    renewalAliveGrace,
  ]) {
    assert.equal(
      await statusOf(owner, tenant.organizationId),
      "closed",
      `${tenant.organizationId} waits`
    );
  }
  for (const tenant of [cancelledBefore, renewalCancelled, paidNoProvider]) {
    assert.equal(
      await statusOf(owner, tenant.organizationId),
      "purge_pending",
      `${tenant.organizationId} is scheduled`
    );
  }
  tests.push(
    "it does not schedule under a legal hold, with a temporary access of the Admin live, after a cancellation of the Admin in this closure, or with a renewal still alive at a provider (active or in grace); a cancellation of an earlier closure, a renewal already cancelled and a paid access with no provider do not stop it"
  );

  // only the privacy runtime runs it, and with no organization to name
  for (const [label, pool] of [
    ["tenant", context.runtimes.tenant],
    ["admin", context.runtimes.admin],
  ] as const) {
    await expectSqlState(
      () => pool.query("SELECT public.schedule_closed_organization_purges(10)"),
      "42501",
      `the ${label} runtime cannot schedule`
    );
  }
  await expectSqlState(
    () => maintenance.scheduleClosedOrganizationPurges(0),
    "22023",
    "a limit of 0 is refused"
  );
  await expectSqlState(
    () => maintenance.scheduleClosedOrganizationPurges(1001),
    "22023",
    "a limit above 1000 is refused"
  );
  // the purge owner keeps to its two moves, whatever its two UPDATE policies would add up to
  await expectSqlState(
    () =>
      asRole(
        owner,
        "polaris_purge_owner",
        "UPDATE public.organizations SET status = 'purged' WHERE id = $1",
        [notYet.organizationId]
      ),
    "42501",
    "the purge owner cannot take a closed organization straight to purged"
  );
  await expectSqlState(
    () =>
      asRole(
        owner,
        "polaris_purge_owner",
        "UPDATE public.organizations SET name = 'Outro nome' WHERE id = $1",
        [onTime.organizationId]
      ),
    "42501",
    "nor rename one that waits for its purge"
  );
  await expectSqlState(
    () =>
      asRole(
        owner,
        "polaris_purge_owner",
        "UPDATE public.organizations SET status = 'purge_pending', name = 'Outro nome' WHERE id = $1",
        [notYet.organizationId]
      ),
    "42501",
    "nor rename one while scheduling it"
  );
  await expectSqlState(
    () =>
      asRole(
        owner,
        "polaris_purge_owner",
        "INSERT INTO public.organization_purges (organization_id, not_before, trigger) VALUES ($1, now(), 'admin')",
        [notYet.organizationId]
      ),
    "42501",
    "the purge owner writes only a purge of the closure period"
  );
  // the purge owner sees a closed organization now: the purge of one that is not scheduled is refused by name
  await expectSqlState(
    () => maintenance.purgeOrganizationData(notYet.organizationId),
    "55000",
    "a closed organization is never purged"
  );
  tests.push(
    "only the privacy runtime schedules (the tenant and Admin runtimes are refused), within a limit; the purge owner moves an organization only from closed to purge_pending, unchanged, or from purge_pending to purged, writes only a purge of the closure period, and refuses to purge a closed organization"
  );

  // the switch: off, the job schedules nothing; on, it does (the real job, through the privacy runtime)
  const switched = await closedOrganization(owner, "switch", lastSecond);
  const offReport = await runPrivacyMaintenance(maintenance, {
    autoPurgeEnabled: false,
  });
  assert.equal(offReport.scheduledPurges, 0);
  assert.equal(await statusOf(owner, switched.organizationId), "closed");
  const onReport = await runPrivacyMaintenance(maintenance, {
    autoPurgeEnabled: true,
  });
  assert.equal(onReport.scheduledPurges, 1);
  assert.equal(await statusOf(owner, switched.organizationId), "purge_pending");
  assert.ok(onReport.scheduledPurgesLastDay > 5);
  tests.push(
    "with CLOSURE_AUTO_PURGE_ENABLED off the job schedules nothing; on, it schedules, and the count of the last 24 hours reaches the alert above 5"
  );

  // AC-61: a legal hold placed after the schedule keeps the run away; its release pushes the purge to the release plus
  // 7 days, never earlier than it was, once
  const holdCase = await supportCaseOf(context, onTime.organizationId);
  await placeOrganizationLegalHold(
    context.admin,
    context.principal,
    holdCase,
    onTime.organizationId,
    new Date(Date.now() + 30 * DAY_MS).toISOString()
  );
  await owner.query(
    "UPDATE public.organization_purges SET not_before = now() - interval '1 second' WHERE organization_id = $1",
    [onTime.organizationId]
  );
  const keepOthersAway = (except: string) =>
    owner.query(
      "UPDATE public.organization_purges SET locked_until = now() + interval '1 day' WHERE organization_id <> $1 AND swept_at IS NULL",
      [except]
    );
  await keepOthersAway(onTime.organizationId);
  assert.equal(
    await maintenance.claimOrganizationPurge(900),
    null,
    "a hold placed after the schedule keeps the run away"
  );
  const releasedAt = await dbNow(owner);
  await releaseOrganizationLegalHold(
    context.admin,
    context.principal,
    holdCase,
    onTime.organizationId
  );
  const afterRelease = await purgeRow(owner, onTime.organizationId);
  assert.ok(afterRelease);
  const minimum = releasedAt.getTime() + CLOSURE_PURGE_MIN_NOTICE_DAYS * DAY_MS;
  assert.ok(
    new Date(afterRelease.not_before).getTime() >= minimum,
    "the release gives the owner 7 days again"
  );
  assert.ok(
    new Date(afterRelease.not_before).getTime() < minimum + 60_000,
    "and no more than that"
  );
  assert.equal(
    await maintenance.claimOrganizationPurge(900),
    null,
    "the purge does not go on by itself after the release"
  );
  // a later not_before stays: the release never brings the purge closer
  const farther = new Date(minimum + 30 * DAY_MS);
  await owner.query(
    "UPDATE public.organization_purges SET not_before = $2 WHERE organization_id = $1",
    [onTime.organizationId, farther]
  );
  await placeOrganizationLegalHold(
    context.admin,
    context.principal,
    holdCase,
    onTime.organizationId,
    new Date(Date.now() + 30 * DAY_MS).toISOString()
  );
  await releaseOrganizationLegalHold(
    context.admin,
    context.principal,
    holdCase,
    onTime.organizationId
  );
  assert.equal(
    new Date(
      (await purgeRow(owner, onTime.organizationId))?.not_before ?? 0
    ).toISOString(),
    farther.toISOString()
  );
  tests.push(
    "a legal hold placed after the schedule keeps the run away; its release does not let the purge go on, but pushes it to the release plus 7 days, and never brings a later date closer"
  );

  // the clock reaches not_before (10 days pass: the closure is 93 days old): before it, the run waits; at it, the purge
  // runs with no operator
  await owner.query(
    `UPDATE public.organization_closures
        SET requested_at = requested_at - interval '10 days', recover_until = recover_until - interval '10 days',
            closed_at = closed_at - interval '10 days'
      WHERE organization_id = $1`,
    [onTime.organizationId]
  );
  await owner.query(
    "UPDATE public.organization_purges SET not_before = now() + interval '1 hour' WHERE organization_id = $1",
    [onTime.organizationId]
  );
  assert.equal(await maintenance.claimOrganizationPurge(900), null);
  await owner.query(
    "UPDATE public.organization_purges SET not_before = now() WHERE organization_id = $1",
    [onTime.organizationId]
  );
  assert.deepEqual(
    await runOrganizationPurges({
      bucket: context.bucket,
      client: maintenance,
      now: () => new Date(),
    }),
    { failed: 0, purged: 1, swept: 1 }
  );
  assert.equal(await statusOf(owner, onTime.organizationId), "purged");
  const completion = async () =>
    (
      await owner.query<{
        actor: string;
        principal_id: string | null;
        support_case_id: string | null;
      }>(
        "SELECT actor, principal_id, support_case_id FROM public.platform_audit_events WHERE organization_id = $1 AND event_type = 'organization.purge_completed' ORDER BY id",
        [onTime.organizationId]
      )
    ).rows;
  assert.deepEqual(await completion(), [
    { actor: "system", principal_id: null, support_case_id: null },
  ]);
  const tombstones = async () =>
    (
      await owner.query<{ privacy_case_id: string | null }>(
        "SELECT privacy_case_id FROM public.deletion_ledger WHERE organization_id = $1 AND entity_type = 'organization' AND operation = 'purge'",
        [onTime.organizationId]
      )
    ).rows;
  assert.deepEqual(await tombstones(), [{ privacy_case_id: null }]);
  tests.push(
    "with no operator, a closed organization reaches purged: not before not_before, the tombstone without a privacy case, the completion audited as the system's"
  );

  // AC-59: a restore brings it back; the runbook's reapplication of an automatic purge purges it again, one tombstone
  const restoreCheck = `SELECT l.entity_id FROM public.deletion_ledger AS l
     JOIN public.organizations AS o ON o.id = l.entity_id
    WHERE l.entity_type = 'organization' AND l.operation = 'purge'
      AND o.status <> 'purged' AND l.organization_id = $1`;
  await owner.query(
    "UPDATE public.organizations SET status = 'closed' WHERE id = $1",
    [onTime.organizationId]
  );
  assert.equal(
    (await owner.query(restoreCheck, [onTime.organizationId])).rowCount,
    1
  );
  // the runbook: the row came back with the backup (trigger and empty references kept); the reapplication reopens it
  await owner.query(
    "UPDATE public.organizations SET status = 'purge_pending' WHERE id = $1 AND status <> 'purged'",
    [onTime.organizationId]
  );
  await owner.query(
    `UPDATE public.organization_purges
        SET not_before = now(), attempts = 0, locked_until = NULL, last_error_code = NULL,
            purged_at = NULL, swept_at = NULL, storage_touched_at = now()
      WHERE organization_id = $1`,
    [onTime.organizationId]
  );
  await keepOthersAway(onTime.organizationId);
  assert.deepEqual(
    await runOrganizationPurges({
      bucket: context.bucket,
      client: maintenance,
      now: () => new Date(),
    }),
    { failed: 0, purged: 1, swept: 1 }
  );
  assert.equal(
    (await owner.query(restoreCheck, [onTime.organizationId])).rowCount,
    0
  );
  assert.deepEqual(await tombstones(), [{ privacy_case_id: null }]);
  assert.equal((await completion()).length, 2);
  tests.push(
    "after a restore brings back an organization purged on its own, the runbook's check lists it and the reapplication purges it again, with one tombstone and the completion audited again as the system's"
  );

  // the Admin cancels an automatic purge: the organization is closed again and the automatic path pauses for this
  // closure; the Admin then schedules it under an accepted deletion case, and the row is the operator's again
  const cancelCase = await supportCaseOf(context, late.organizationId);
  // no run holds it (the lease the checks above gave it ends), and its paid access is over (the Admin's schedule waits
  // for one that is not, unlike the automatic one)
  await owner.query(
    "UPDATE public.organization_purges SET locked_until = NULL WHERE organization_id = $1",
    [late.organizationId]
  );
  await owner.query(
    "DELETE FROM public.organization_billing WHERE organization_id = $1",
    [late.organizationId]
  );
  await cancelOrganizationPurge(
    context.admin,
    context.principal,
    cancelCase,
    late.organizationId,
    "Pausa pedida pelo jurídico"
  );
  assert.equal(await statusOf(owner, late.organizationId), "closed");
  await schedule();
  assert.equal(
    await statusOf(owner, late.organizationId),
    "closed",
    "a cancellation in this closure pauses the automatic schedule"
  );
  // the Admin's path keeps the period of 90 days from the request: 5 days pass
  await owner.query(
    `UPDATE public.organization_closures
        SET requested_at = requested_at - interval '5 days', recover_until = recover_until - interval '5 days',
            closed_at = closed_at - interval '5 days'
      WHERE organization_id = $1`,
    [late.organizationId]
  );
  const deletionCase = await acceptedDeletionCase(context, late.organizationId);
  const rescheduled = await scheduleOrganizationPurge(
    context.admin,
    context.principal,
    deletionCase,
    late.organizationId
  );
  assert.equal(rescheduled?.status, "purge_pending");
  const adminRow = await purgeRow(owner, late.organizationId);
  assert.ok(adminRow);
  assert.deepEqual(
    {
      privacy: adminRow.privacy_case_id,
      scheduledBy: adminRow.scheduled_by,
      trigger: adminRow.trigger,
    },
    {
      privacy: deletionCase,
      scheduledBy: context.principal,
      trigger: "admin",
    }
  );
  tests.push(
    "the Admin cancels an automatic purge, which pauses the automatic path for that closure, and can schedule it under a deletion case, as the operator's again"
  );

  // R4: the case views of the Admin never meet an event without a principal (a system event has no case), and the
  // database refuses one that would
  await expectSqlState(
    () =>
      owner.query(
        `INSERT INTO public.platform_audit_events (actor, principal_id, event_type, organization_id, support_case_id, entity_type, entity_id)
         VALUES ('system', NULL, 'organization.purge_scheduled', $1, $2, 'organization', $1)`,
        [late.organizationId, cancelCase]
      ),
    "23514",
    "a system event never carries a case"
  );
  await expectSqlState(
    () =>
      owner.query(
        `INSERT INTO public.platform_audit_events (actor, principal_id, event_type, organization_id, entity_type, entity_id)
         VALUES ('principal', NULL, 'organization.purge_scheduled', $1, 'organization', $1)`,
        [late.organizationId]
      ),
    "23514",
    "an operator's event always names the operator"
  );
  await expectSqlState(
    () =>
      owner.query(
        `INSERT INTO public.platform_audit_events (actor, principal_id, event_type, organization_id, entity_type, entity_id)
         VALUES ('system', NULL, 'organization.suspended', $1, 'organization', $1)`,
        [late.organizationId]
      ),
    "23514",
    "and only the purge is ever the system's"
  );
  await expectSqlState(
    () =>
      owner.query(
        "INSERT INTO public.organization_purges (organization_id, not_before, trigger, scheduled_by) VALUES ($1, now(), 'closure_period', $2)",
        [notYet.organizationId, context.principal]
      ),
    "23514",
    "a purge of the closure period names no operator"
  );
  for (const caseId of [cancelCase, deletionCase]) {
    const detail = await readSupportCase(context.admin, caseId);
    assert.ok(detail && detail.audit.length > 0);
    for (const entry of detail.audit) {
      assert.equal(typeof entry.principalId, "string", entry.eventType);
    }
  }
  tests.push(
    "every audit event of the system has no principal and no case, so the case views of the Admin list only events with a principal; an event of the system with a case, an operator's without a principal, any other type as the system's and a purge of the closure period with an operator are refused"
  );

  return tests;
}
