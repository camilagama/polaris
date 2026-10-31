// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  cancelOrganizationPurge,
  grantTenantAccess,
  openPrivacyCase,
  openSupportCase,
  placeOrganizationLegalHold,
  readSupportCase,
  recordPrivacyDecision,
  recordPrivacyIdentity,
  recordPrivacyRole,
  recordPrivacyScope,
  releaseOrganizationLegalHold,
  revokeTenantAccess,
  scheduleOrganizationPurge,
} from "@polaris/db/admin-support-repository";
import type { createDatabase } from "@polaris/db/client";
import type { createPrivacyMaintenanceClient } from "@polaris/db/privacy-maintenance";
import {
  CLOSURE_NOTICE_OVERDUE_DAYS,
  CLOSURE_PURGE_GRACE_HOURS,
  CLOSURE_PURGE_MIN_NOTICE_DAYS,
  closureDeadlines,
  closurePurgeNotBefore,
} from "@polaris/domain/organization/closure-deadlines";
import { ORGANIZATION_PURGE_REQUIRED_SCOPE } from "@polaris/domain/privacy/organization-purge";
import {
  queryAsGateRole,
  withGateRole,
} from "../../../packages/db/scripts/gate-roles";
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

export type Pool = ReturnType<typeof createDatabase>["pool"];

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

export const ZONE = "America/Sao_Paulo";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Every organization this scenario writes, so the checks read only their own. */
const created: string[] = [];

export async function dbNow(owner: Pool): Promise<Date> {
  const result = await owner.query<{ now: Date }>("SELECT now() AS now");
  const now = result.rows[0]?.now;
  assert.ok(now);
  return new Date(now);
}

/** The first instant of the local day `offset` days from today's local date in the zone, as the database counts it. */
export async function localDayStart(
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

/**
 * A closed organization whose closure was requested at `requestedAt`, its recovery window over unless `recoverUntil`
 * says otherwise, with the notice of D minus 7 days delivered unless `notice` is false.
 */
export async function closedOrganization(
  owner: Pool,
  label: string,
  requestedAt: Date,
  options: { notice?: boolean; recoverUntil?: Date; zone?: string } = {}
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
  // the notice of D minus 7 days is delivered unless the check is about it (ADR 0102, amended)
  if (options.notice !== false) {
    await deliverClosureNotice(owner, tenant.organizationId);
  }
  return tenant;
}

/**
 * How long ago a notice counts as delivered when a check does not say otherwise: older than the 7 days the purge waits
 * after the latest delivery (`CLOSURE_PURGE_MIN_NOTICE_DAYS`, ADR 0102 amended), so the checks about something else
 * are not held by it.
 */
const DELIVERED_AGO_HOURS = (CLOSURE_PURGE_MIN_NOTICE_DAYS + 1) * 24;

/**
 * The notice of D minus 7 days of the organization's current closure cycle, delivered (`sent_at` filled, 8 days ago
 * unless `sentAgoHours` says otherwise): what the schedule and the run wait for before a store is deleted (ADR 0102,
 * amended). It names the cycle by the instant of the request, so a check that moves the request writes it again
 * afterwards. The e-mail that would deliver it is the next change, so the check writes the row as the e-mail would
 * leave it.
 */
export async function deliverClosureNotice(
  owner: Pool,
  organizationId: string,
  milestone: "d7" | "rescheduled" = "d7",
  sentAgoHours = DELIVERED_AGO_HOURS
) {
  await owner.query(
    `INSERT INTO public.closure_notices
       (organization_id, closure_requested_at, milestone, purge_from, due_at, user_id, sent_at)
     SELECT closure.organization_id, closure.requested_at, $2::text,
            CASE WHEN $2::text = 'rescheduled' THEN closure.requested_at + interval '100 days' END,
            CASE WHEN $2::text = 'rescheduled' THEN closure.requested_at + interval '93 days'
                 ELSE deadline.d7_at END,
            closure.requested_by_user_id, now() - make_interval(hours => $3)
       FROM public.organization_closures AS closure
       JOIN public.organizations AS organization ON organization.id = closure.organization_id
       CROSS JOIN LATERAL public.closure_deadlines(closure.requested_at, organization.timezone) AS deadline
      WHERE closure.organization_id = $1
     ON CONFLICT ON CONSTRAINT closure_notices_cycle_milestone_unique
       DO UPDATE SET sent_at = now() - make_interval(hours => $3)`,
    [organizationId, milestone, sentAgoHours]
  );
}

/** `days` pass for a closed organization: its closure and its notices move that far back, the same cycle. */
export async function timePasses(
  owner: Pool,
  organizationId: string,
  days: number
) {
  await owner.query(
    `UPDATE public.organization_closures
        SET requested_at = requested_at - make_interval(days => $2), recover_until = recover_until - make_interval(days => $2),
            closed_at = closed_at - make_interval(days => $2)
      WHERE organization_id = $1`,
    [organizationId, days]
  );
  await owner.query(
    `UPDATE public.closure_notices
        SET closure_requested_at = closure_requested_at - make_interval(days => $2), due_at = due_at - make_interval(days => $2),
            purge_from = purge_from - make_interval(days => $2)
      WHERE organization_id = $1`,
    [organizationId, days]
  );
}

export async function statusOf(
  owner: Pool,
  organizationId: string
): Promise<string> {
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

export async function purgeRow(
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

export async function asRole(
  owner: Pool,
  role: string,
  statement: string,
  values: unknown[] = []
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    return await withGateRole(client, role, () =>
      client.query(statement, values)
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

const ZONES = [ZONE, "America/Manaus", "America/New_York"];

/**
 * Waits past local midnight when the run is about to cross it in any zone of the scenario: "today" must be the same
 * day for the whole scenario, which takes well under the 5 minutes of margin.
 */
export async function awayFromMidnight(owner: Pool) {
  const result = await owner.query<{ seconds: number }>(
    `SELECT min(EXTRACT(epoch FROM public.closure_local_day_start((now() AT TIME ZONE zone)::date + 1, zone) - now()))::float8 AS seconds
       FROM unnest($1::text[]) AS zone`,
    [ZONES]
  );
  const seconds = Number(result.rows[0]?.seconds ?? 0);
  if (seconds < 300) {
    await new Promise((resolve) => setTimeout(resolve, (seconds + 2) * 1000));
  }
}

/**
 * What the scenario changes outside its own organizations, to be put back at the end: the closures of the other
 * closed organizations (moved so the schedule, which takes the whole database, does not reach them) and the lease of
 * the other purges (held so the claim, which takes the oldest due one, reaches the scenario's).
 */
export async function setAsideOthers(owner: Pool) {
  const closures = (
    await owner.query<{
      organization_id: string;
      recover_until: Date;
      requested_at: Date;
    }>(
      `SELECT closure.organization_id, closure.requested_at, closure.recover_until
         FROM public.organization_closures AS closure
         JOIN public.organizations AS organization ON organization.id = closure.organization_id
        WHERE organization.status = 'closed'`
    )
  ).rows;
  const leases = (
    await owner.query<{ locked_until: Date | null; organization_id: string }>(
      "SELECT organization_id, locked_until FROM public.organization_purges WHERE swept_at IS NULL"
    )
  ).rows;
  await owner.query(
    `UPDATE public.organization_closures
        SET requested_at = now() - interval '31 days', recover_until = now() - interval '1 day'
      WHERE organization_id = ANY ($1::text[])`,
    [closures.map((row) => row.organization_id)]
  );
  return async () => {
    await owner.query(
      `UPDATE public.organization_closures AS closure
          SET requested_at = saved.requested_at, recover_until = saved.recover_until
         FROM unnest($1::text[], $2::timestamptz[], $3::timestamptz[]) AS saved(organization_id, requested_at, recover_until)
        WHERE closure.organization_id = saved.organization_id`,
      [
        closures.map((row) => row.organization_id),
        closures.map((row) => row.requested_at),
        closures.map((row) => row.recover_until),
      ]
    );
    await owner.query(
      `UPDATE public.organization_purges AS purge
          SET locked_until = saved.locked_until
         FROM unnest($1::text[], $2::timestamptz[]) AS saved(organization_id, locked_until)
        WHERE purge.organization_id = saved.organization_id`,
      [
        leases.map((row) => row.organization_id),
        leases.map((row) => row.locked_until),
      ]
    );
  };
}

export async function acceptedDeletionCase(
  context: AutomaticPurgeContext,
  organizationId: string,
  requesterKind: "data_subject" | "organization_owner" = "organization_owner"
): Promise<string> {
  const { admin, principal } = context;
  const opened = await openPrivacyCase(admin, principal, {
    channel: "email",
    dueDays: 15,
    note: null,
    organizationId,
    reason: "Pedido de exclusão da organização",
    receivedAt: null,
    requesterKind,
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

export async function supportCaseOf(
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
  await awayFromMidnight(context.owner);
  // other gates (and the purge above) may leave closed organizations past D minus 7: while the scenario runs their
  // closure is moved to a month ago (still closed, window over, D far ahead), and everything is put back at the end
  const restoreOthers = await setAsideOthers(context.owner);
  try {
    const tests = await scenario(context);
    tests.push(...(await recheckScenario(context)));
    tests.push(...(await deliveredNoticeScenario(context)));
    return tests;
  } finally {
    await restoreOthers();
  }
}

async function scenario(context: AutomaticPurgeContext): Promise<string[]> {
  const { maintenance, owner } = context;
  const tests: string[] = [];
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
  // the recovery window ends in an hour: not scheduled, whatever D says
  const windowOpen = await closedOrganization(
    owner,
    "window open",
    await localDayStart(owner, ZONE, -85),
    { recoverUntil: new Date((await dbNow(owner)).getTime() + HOUR_MS) }
  );
  // a closure requested 40 days ago (undone and requested again, the record holds only the new request): D is far ahead
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
  assert.equal(first.overdue, 0);
  tests.push(
    "the purge is scheduled from D minus 7 local days, by the request to the second: a request at 00:00:00 of the local day 82 days ago is not, one at 23:59:59 of the day before is (also in America/Manaus and America/New_York, in their own calendars); not while the recovery window is open, and a closure requested again counts from its new request (the change of daylight saving time is in the unit test of the domain and in the comparison of closure_deadlines with it)"
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

  // a store left behind: still closed 30 days after D (a renewal alive keeps it), with no legal hold, is counted for
  // the alert; one held is not
  const longAgo = await localDayStart(owner, ZONE, -125);
  const leftBehind = await closedOrganization(owner, "left behind", longAgo);
  await billing(leftBehind.organizationId, {
    cancelAtPeriodEnd: false,
    provider: true,
    state: "active",
  });
  const heldLongAgo = await closedOrganization(owner, "held long ago", longAgo);
  await placeOrganizationLegalHold(
    context.admin,
    context.principal,
    await supportCaseOf(context, heldLongAgo.organizationId),
    heldLongAgo.organizationId,
    new Date(Date.now() + 30 * DAY_MS).toISOString()
  );
  const counted = await schedule();
  assert.equal(counted.scheduled, 0);
  assert.equal(counted.overdue, 1);
  tests.push(
    "a closed store still waiting 30 days after D with no legal hold is counted for the alert of a store left behind; one under a legal hold is not"
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
    await expectSqlState(
      () => pool.query("SELECT public.count_purges_held_back()"),
      "42501",
      `the ${label} runtime cannot count the purges held back`
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

  // the clock reaches not_before (10 days pass: the closure is 93 days old): an hour before it, the run waits; at it, the
  // purge runs with no operator
  await timePasses(owner, onTime.organizationId, 10);
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
  // the runbook's block for an automatic purge, as it is written there (the row came back with the backup: the
  // conflict reopens it, keeping the trigger and the empty references)
  const restoreClient = await owner.connect();
  try {
    await restoreClient.query("BEGIN");
    await restoreClient.query(
      "UPDATE public.organizations SET status = 'purge_pending' WHERE id = $1 AND status <> 'purged'",
      [onTime.organizationId]
    );
    await restoreClient.query(
      `INSERT INTO public.organization_purges (organization_id, trigger, not_before, storage_touched_at)
       VALUES ($1, 'closure_period', now(), now())
       ON CONFLICT (organization_id) DO UPDATE
          SET not_before = now(), attempts = 0, locked_until = NULL,
              last_error_code = NULL, purged_at = NULL, swept_at = NULL, storage_touched_at = now()`,
      [onTime.organizationId]
    );
    await restoreClient.query("COMMIT");
  } catch (error) {
    await restoreClient.query("ROLLBACK");
    throw error;
  } finally {
    restoreClient.release();
  }
  const reopened = await purgeRow(owner, onTime.organizationId);
  assert.equal(reopened?.trigger, "closure_period");
  assert.equal(reopened?.scheduled_by, null);
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
  await timePasses(owner, late.organizationId, 5);
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

/** A refusal of the purge by name: SQLSTATE 55000 and the code as the message, as the job writes it down. */
async function expectPurgeRefusal(
  operation: () => Promise<unknown>,
  code: string,
  label: string
) {
  await assert.rejects(
    operation,
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "55000", label);
      assert.equal((error as Error).message, code, label);
      return true;
    },
    label
  );
}

async function membershipCount(owner: Pool, organizationId: string) {
  const result = await owner.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM public.memberships WHERE organization_id = $1",
    [organizationId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * The purge checks again, when it runs, what the schedule waited for (ADR 0102 amended, suggestion 1 of the security
 * review): a temporary access of the Admin opened after the schedule, or a renewal alive again after it, keeps the
 * claim away and makes the mark before the storage and `purge_organization_data` refuse, by the codes of the schedule,
 * with nothing removed; for a purge of the closure period and for one of the Admin alike. Once both are gone the
 * purge runs.
 */
async function recheckScenario(
  context: AutomaticPurgeContext
): Promise<string[]> {
  const { admin, maintenance, owner, principal } = context;
  const tests: string[] = [];
  const keepOthersAway = (except: string) =>
    owner.query(
      "UPDATE public.organization_purges SET locked_until = now() + interval '1 day' WHERE organization_id <> $1 AND swept_at IS NULL",
      [except]
    );
  const releaseLease = (organizationId: string) =>
    owner.query(
      "UPDATE public.organization_purges SET locked_until = NULL WHERE organization_id = $1",
      [organizationId]
    );
  const renewal = (organizationId: string, alive: boolean) =>
    owner.query(
      `UPDATE public.organization_billing
          SET state = 'active', access_ends_at = now() - interval '1 day', provider = 'asaas',
              provider_ref = $2, cancel_at_period_end = $3
        WHERE organization_id = $1`,
      [organizationId, `sub_gate_${randomUUID().slice(0, 8)}`, !alive]
    );

  // the two paths: a purge the closure period scheduled (a late sweep, so not_before is the schedule plus 7 days), and
  // one the Admin scheduled under an accepted deletion case (its paid access over, no renewal to cancel)
  const requested = await localDayStart(owner, ZONE, -95);
  const automatic = await closedOrganization(
    owner,
    "recheck automatic",
    requested
  );
  await maintenance.scheduleClosedOrganizationPurges(1000);
  assert.equal(
    await statusOf(owner, automatic.organizationId),
    "purge_pending"
  );
  assert.equal(
    (await purgeRow(owner, automatic.organizationId))?.trigger,
    "closure_period"
  );
  const byAdmin = await closedOrganization(owner, "recheck admin", requested);
  await renewal(byAdmin.organizationId, false);
  await owner.query(
    "INSERT INTO public.organization_purge_cancellations (organization_id, support_case_id, cancelled_by, reason, scheduled_at, cancelled_at) VALUES ($1, $2, $3, 'Pausa do automático', now(), now())",
    [
      byAdmin.organizationId,
      await supportCaseOf(context, byAdmin.organizationId),
      principal,
    ]
  );
  const scheduled = await scheduleOrganizationPurge(
    admin,
    principal,
    await acceptedDeletionCase(context, byAdmin.organizationId),
    byAdmin.organizationId
  );
  assert.equal(scheduled?.status, "purge_pending");
  assert.equal(
    (await purgeRow(owner, byAdmin.organizationId))?.trigger,
    "admin"
  );

  for (const [label, tenant] of [
    ["closure period", automatic],
    ["Admin", byAdmin],
  ] as const) {
    const { organizationId } = tenant;
    await owner.query(
      "UPDATE public.organization_purges SET not_before = now() - interval '1 second', locked_until = NULL WHERE organization_id = $1",
      [organizationId]
    );
    await keepOthersAway(organizationId);
    const members = await membershipCount(owner, organizationId);
    assert.ok(members > 0);

    // a temporary access of the Admin opened after the schedule: the run does not take the purge
    const caseId = await supportCaseOf(context, organizationId);
    const access = await grantTenantAccess(admin, principal, caseId, 30);
    assert.ok(access);
    assert.equal(
      await maintenance.claimOrganizationPurge(900),
      null,
      `${label}: the access keeps the run away`
    );
    // opened while a run holds the purge: the mark before the storage and the purge itself refuse, by name
    assert.ok(await revokeTenantAccess(admin, principal, access.id));
    const claimed = await maintenance.claimOrganizationPurge(900);
    assert.equal(claimed?.organizationId, organizationId);
    const reopened = await grantTenantAccess(admin, principal, caseId, 30);
    assert.ok(reopened);
    await expectPurgeRefusal(
      () => maintenance.markOrganizationPurgeStorageTouched(organizationId),
      "tenant_access_active",
      `${label}: the storage is not touched while an access is live`
    );
    await expectPurgeRefusal(
      () => maintenance.purgeOrganizationData(organizationId),
      "tenant_access_active",
      `${label}: the purge refuses while an access is live`
    );
    assert.ok(await revokeTenantAccess(admin, principal, reopened.id));

    // a renewal alive again after the schedule (a provider brought it back): the same, by its code
    await renewal(organizationId, true);
    await expectPurgeRefusal(
      () => maintenance.markOrganizationPurgeStorageTouched(organizationId),
      "renewal_alive",
      `${label}: the storage is not touched while the renewal is alive`
    );
    await expectPurgeRefusal(
      () => maintenance.purgeOrganizationData(organizationId),
      "renewal_alive",
      `${label}: the purge refuses while the renewal is alive`
    );
    await releaseLease(organizationId);
    assert.equal(
      await maintenance.claimOrganizationPurge(900),
      null,
      `${label}: the live renewal keeps the run away`
    );
    assert.equal(await statusOf(owner, organizationId), "purge_pending");
    assert.equal(
      await membershipCount(owner, organizationId),
      members,
      `${label}: nothing was removed`
    );
    const touched = await owner.query<{ storage_touched_at: Date | null }>(
      "SELECT storage_touched_at FROM public.organization_purges WHERE organization_id = $1",
      [organizationId]
    );
    assert.equal(
      touched.rows[0]?.storage_touched_at,
      null,
      `${label}: the storage was never marked touched`
    );

    // both gone (the renewal cancelled at the end of the period, the access revoked): the purge runs
    await renewal(organizationId, false);
    await releaseLease(organizationId);
    await keepOthersAway(organizationId);
    assert.deepEqual(
      await runOrganizationPurges({
        bucket: context.bucket,
        client: maintenance,
        now: () => new Date(),
      }),
      { failed: 0, purged: 1, swept: 1 },
      `${label}: purged once nothing holds it`
    );
    assert.equal(await statusOf(owner, organizationId), "purged");
  }
  tests.push(
    "when the purge runs it checks again what the schedule waited for: a temporary access of the Admin opened after the schedule, or a renewal alive again, keeps the run from taking it, and while a run holds it the mark before the storage and purge_organization_data refuse with tenant_access_active or renewal_alive, nothing removed and the storage untouched; for a purge of the closure period and one of the Admin alike, and it runs once both are gone"
  );
  return tests;
}

type NoticeState = "failed" | "sent" | "skipped" | "unresolved";

/** One notice of the organization's current cycle in the state asked, as the privacy job and the e-mail would leave it. */
async function writeNotice(
  owner: Pool,
  organizationId: string,
  milestone: string,
  state: NoticeState,
  options: {
    cycleShiftDays?: number;
    dueAgoHours?: number;
    sentAgoHours?: number;
  } = {}
) {
  await owner.query(
    `INSERT INTO public.closure_notices
       (organization_id, closure_requested_at, milestone, purge_from, due_at, user_id, skipped, sent_at, failed_at, failure_code)
     SELECT closure.organization_id, closure.requested_at - make_interval(days => $4), $2::text,
            CASE WHEN $2::text = 'rescheduled' THEN now() + interval '1 day' END,
            GREATEST(closure.requested_at - make_interval(days => $4), now() - make_interval(hours => $5)),
            closure.requested_by_user_id, $3::text = 'skipped',
            CASE WHEN $3::text = 'sent' THEN now() - make_interval(hours => $6) END,
            CASE WHEN $3::text = 'failed' THEN now() END,
            CASE WHEN $3::text = 'failed' THEN 'address_refused' END
       FROM public.organization_closures AS closure
      WHERE closure.organization_id = $1
     ON CONFLICT ON CONSTRAINT closure_notices_cycle_milestone_unique DO UPDATE
       SET skipped = EXCLUDED.skipped, sent_at = EXCLUDED.sent_at, failed_at = EXCLUDED.failed_at,
           failure_code = EXCLUDED.failure_code, due_at = EXCLUDED.due_at`,
    [
      organizationId,
      milestone,
      state,
      options.cycleShiftDays ?? 0,
      options.dueAgoHours ?? 0,
      options.sentAgoHours ?? DELIVERED_AGO_HOURS,
    ]
  );
}

async function dropNotices(owner: Pool, organizationId: string) {
  await owner.query(
    "DELETE FROM public.closure_notices WHERE organization_id = $1",
    [organizationId]
  );
}

async function waitOf(owner: Pool, organizationId: string) {
  // the function is internal to the purge: only its owner executes it
  const result = await queryAsGateRole<{ wait: string | null }>(
    owner,
    "polaris_purge_owner",
    `SELECT public.closed_organization_purge_wait(closure.organization_id, closure.requested_at) AS wait
       FROM public.organization_closures AS closure WHERE closure.organization_id = $1`,
    [organizationId]
  );
  return result.rows[0]?.wait ?? null;
}

/**
 * No store is deleted before the owner was told (ADR 0102, amended): the schedule and the run
 * wait while the current closure cycle has no `d7` or `rescheduled` notice with `sent_at` filled, for the closure period
 * and for the Admin's path alike, and a store held back lands in the alert of a store left behind. Each check removes
 * the notice to prove the refusal and puts it back to prove the purge goes on.
 */
async function deliveredNoticeScenario(
  context: AutomaticPurgeContext
): Promise<string[]> {
  const { admin, maintenance, owner, principal } = context;
  const tests: string[] = [];
  const schedule = () => maintenance.scheduleClosedOrganizationPurges(1000);
  const keepOthersAway = (except: string) =>
    owner.query(
      "UPDATE public.organization_purges SET locked_until = now() + interval '1 day' WHERE organization_id <> $1 AND swept_at IS NULL",
      [except]
    );
  const pastTime = (id: string) =>
    owner.query(
      "UPDATE public.organization_purges SET not_before = now() - interval '1 second', locked_until = NULL WHERE organization_id = $1",
      [id]
    );
  const requested = await localDayStart(owner, ZONE, -95);

  // the schedule waits for the delivered notice of D minus 7 days of this cycle, and for nothing else it can mistake for it
  const automatic = await closedOrganization(
    owner,
    "notice wait automatic",
    requested,
    { notice: false }
  );
  const { organizationId } = automatic;
  assert.equal(
    await waitOf(owner, organizationId),
    "closure_notice_not_delivered"
  );
  await schedule();
  assert.equal(
    await statusOf(owner, organizationId),
    "closed",
    "no notice at all"
  );
  for (const milestone of ["closure", "d30", "deletion_day"]) {
    await writeNotice(owner, organizationId, milestone, "sent");
  }
  await schedule();
  assert.equal(
    await statusOf(owner, organizationId),
    "closed",
    "the other milestones, delivered, are not the notice of D minus 7 days"
  );
  for (const state of ["unresolved", "failed", "skipped"] as const) {
    await writeNotice(owner, organizationId, "d7", state);
    await schedule();
    assert.equal(
      await statusOf(owner, organizationId),
      "closed",
      `a d7 notice that is ${state} is not a delivered one`
    );
    assert.equal(
      await waitOf(owner, organizationId),
      "closure_notice_not_delivered"
    );
  }
  await dropNotices(owner, organizationId);
  await writeNotice(owner, organizationId, "d7", "sent", {
    cycleShiftDays: 200,
  });
  await schedule();
  assert.equal(
    await statusOf(owner, organizationId),
    "closed",
    "a notice delivered in an earlier closure cycle does not count for this one"
  );
  await dropNotices(owner, organizationId);
  await writeNotice(owner, organizationId, "d7", "sent");
  assert.equal(await waitOf(owner, organizationId), null);
  await schedule();
  assert.equal(await statusOf(owner, organizationId), "purge_pending");
  tests.push(
    "the schedule waits (closure_notice_not_delivered) while the current closure cycle has no d7 or rescheduled notice with sent_at filled: no notice, the other milestones delivered, a d7 notice unresolved, failed or skipped, and one delivered in an earlier cycle all keep the store closed; the delivered notice lets it go"
  );

  // the run checks it again: a notice that disappears (a restore from an older copy) keeps the run away and makes the
  // mark before the storage and the purge refuse, by name; the rescheduled notice is the other that satisfies it
  await pastTime(organizationId);
  await keepOthersAway(organizationId);
  const claimed = await maintenance.claimOrganizationPurge(900);
  assert.equal(claimed?.organizationId, organizationId);
  const members = await membershipCount(owner, organizationId);
  assert.ok(members > 0);
  await dropNotices(owner, organizationId);
  await expectPurgeRefusal(
    () => maintenance.markOrganizationPurgeStorageTouched(organizationId),
    "closure_notice_not_delivered",
    "the storage is not touched without a delivered notice"
  );
  await expectPurgeRefusal(
    () => maintenance.purgeOrganizationData(organizationId),
    "closure_notice_not_delivered",
    "the purge refuses without a delivered notice"
  );
  await owner.query(
    "UPDATE public.organization_purges SET locked_until = NULL WHERE organization_id = $1",
    [organizationId]
  );
  assert.equal(
    await maintenance.claimOrganizationPurge(900),
    null,
    "without a delivered notice the claim does not take it"
  );
  assert.equal(await statusOf(owner, organizationId), "purge_pending");
  assert.equal(
    await membershipCount(owner, organizationId),
    members,
    "nothing was removed"
  );
  const touched = await owner.query<{ storage_touched_at: Date | null }>(
    "SELECT storage_touched_at FROM public.organization_purges WHERE organization_id = $1",
    [organizationId]
  );
  assert.equal(touched.rows[0]?.storage_touched_at, null);

  // the alert counts it (`count_purges_held_back`: past not_before, held back by the notice), and not one under a legal hold
  const baseline = () => maintenance.countPurgesHeldBack();
  const withNotice = await (async () => {
    await writeNotice(owner, organizationId, "d7", "sent");
    const count = await baseline();
    await dropNotices(owner, organizationId);
    return count;
  })();
  const stuck = await baseline();
  assert.equal(
    stuck,
    withNotice + 1,
    "a purge past its time held back by the notice is counted"
  );
  // the count does not depend on the switch of the automatic purge: the Admin's purges wait the same way
  const switchedOff = await runPrivacyMaintenance(maintenance, {
    autoPurgeEnabled: false,
  });
  assert.equal(switchedOff.purgesHeldBack, stuck);
  assert.equal(switchedOff.purgeSchedulingEnabled, false);
  const holdCase = await supportCaseOf(context, organizationId);
  await placeOrganizationLegalHold(
    admin,
    principal,
    holdCase,
    organizationId,
    new Date(Date.now() + 30 * DAY_MS).toISOString()
  );
  await pastTime(organizationId);
  assert.equal(
    await baseline(),
    withNotice,
    "under a legal hold it is not counted"
  );
  await releaseOrganizationLegalHold(
    admin,
    principal,
    holdCase,
    organizationId
  );
  await pastTime(organizationId);
  assert.equal(await baseline(), withNotice + 1);
  // the other two reasons count the same once the notice is there: a live temporary access and a renewal alive
  await writeNotice(owner, organizationId, "rescheduled", "sent");
  assert.equal(
    await baseline(),
    withNotice,
    "a delivered rescheduled notice satisfies it as well"
  );
  const access = await grantTenantAccess(admin, principal, holdCase, 30);
  assert.ok(access);
  assert.equal(
    await baseline(),
    withNotice + 1,
    "a live temporary access past the time is counted"
  );
  assert.ok(await revokeTenantAccess(admin, principal, access.id));
  assert.equal(await baseline(), withNotice);
  await owner.query(
    `UPDATE public.organization_billing
        SET state = 'active', access_ends_at = now() - interval '1 day', provider = 'asaas', provider_ref = $2,
            cancel_at_period_end = false
      WHERE organization_id = $1`,
    [organizationId, `sub_gate_${randomUUID().slice(0, 8)}`]
  );
  assert.equal(
    await baseline(),
    withNotice + 1,
    "a renewal alive past the time is counted"
  );
  await owner.query(
    "UPDATE public.organization_billing SET cancel_at_period_end = true WHERE organization_id = $1",
    [organizationId]
  );
  assert.equal(await baseline(), withNotice);
  // with the notice delivered and nothing else in the way the purge runs (here by the rescheduled notice alone)
  await owner.query(
    "UPDATE public.organization_purges SET locked_until = NULL WHERE organization_id = $1",
    [organizationId]
  );
  await keepOthersAway(organizationId);
  assert.deepEqual(
    await runOrganizationPurges({
      bucket: context.bucket,
      client: maintenance,
      now: () => new Date(),
    }),
    { failed: 0, purged: 1, swept: 1 }
  );
  assert.equal(await statusOf(owner, organizationId), "purged");
  tests.push(
    "the run checks the notice again: without a delivered one the claim does not take the purge and the mark before the storage and purge_organization_data refuse with closure_notice_not_delivered, nothing removed; the alert counts, with the automatic switch on or off, the purge held back past its time by the notice, a live access or a live renewal (not one under a legal hold), and the purge runs once a d7 or rescheduled notice is delivered"
  );

  // the Admin's path: the Admin may schedule it (the case decides), and the run waits for the notice all the same
  const byAdmin = await closedOrganization(
    owner,
    "notice wait admin",
    requested,
    {
      notice: false,
    }
  );
  await owner.query(
    `UPDATE public.organization_billing
        SET state = 'active', access_ends_at = now() - interval '1 day', provider = 'asaas', provider_ref = $2,
            cancel_at_period_end = true
      WHERE organization_id = $1`,
    [byAdmin.organizationId, `sub_gate_${randomUUID().slice(0, 8)}`]
  );
  const scheduled = await scheduleOrganizationPurge(
    admin,
    principal,
    await acceptedDeletionCase(context, byAdmin.organizationId),
    byAdmin.organizationId
  );
  assert.equal(scheduled?.status, "purge_pending");
  assert.equal(
    (await purgeRow(owner, byAdmin.organizationId))?.trigger,
    "admin"
  );
  await pastTime(byAdmin.organizationId);
  await keepOthersAway(byAdmin.organizationId);
  assert.equal(
    await maintenance.claimOrganizationPurge(900),
    null,
    "an Admin purge without a delivered notice is not taken"
  );
  await writeNotice(owner, byAdmin.organizationId, "d7", "sent");
  const adminClaim = await maintenance.claimOrganizationPurge(900);
  assert.equal(adminClaim?.organizationId, byAdmin.organizationId);
  await dropNotices(owner, byAdmin.organizationId);
  await expectPurgeRefusal(
    () =>
      maintenance.markOrganizationPurgeStorageTouched(byAdmin.organizationId),
    "closure_notice_not_delivered",
    "Admin: the storage is not touched without a delivered notice"
  );
  await expectPurgeRefusal(
    () => maintenance.purgeOrganizationData(byAdmin.organizationId),
    "closure_notice_not_delivered",
    "Admin: the purge refuses without a delivered notice"
  );
  await writeNotice(owner, byAdmin.organizationId, "d7", "sent");
  await owner.query(
    "UPDATE public.organization_purges SET locked_until = NULL WHERE organization_id = $1",
    [byAdmin.organizationId]
  );
  await keepOthersAway(byAdmin.organizationId);
  assert.deepEqual(
    await runOrganizationPurges({
      bucket: context.bucket,
      client: maintenance,
      now: () => new Date(),
    }),
    { failed: 0, purged: 1, swept: 1 }
  );
  assert.equal(await statusOf(owner, byAdmin.organizationId), "purged");
  tests.push(
    "the notice delivered is a condition of the Admin's purge too: scheduled by the case it is not taken, and with it gone while the run holds it the mark and the purge refuse; it runs when the notice is delivered"
  );

  // the notice must have been delivered at least 7 days ago: a late notice, or a purge the Admin
  // schedules, never deletes the store hours after the owner was told. The latest of the d7 and rescheduled notices counts.
  const settle = CLOSURE_PURGE_MIN_NOTICE_DAYS * 24;
  const aged = (id: string, hoursAgo: number) =>
    owner.query(
      "UPDATE public.closure_notices SET sent_at = now() - make_interval(hours => $2) WHERE organization_id = $1 AND sent_at IS NOT NULL",
      [id, hoursAgo]
    );
  const settling = await closedOrganization(owner, "notice settle", requested, {
    notice: false,
  });
  const settlingId = settling.organizationId;
  await writeNotice(owner, settlingId, "d7", "sent", {
    sentAgoHours: settle - 1,
  });
  assert.equal(
    await waitOf(owner, settlingId),
    "closure_notice_not_delivered",
    "a notice delivered less than 7 days ago keeps the schedule waiting"
  );
  await schedule();
  assert.equal(await statusOf(owner, settlingId), "closed");
  await writeNotice(owner, settlingId, "d7", "sent", {
    sentAgoHours: settle + 1,
  });
  await writeNotice(owner, settlingId, "rescheduled", "sent", {
    sentAgoHours: 1,
  });
  assert.equal(
    await waitOf(owner, settlingId),
    "closure_notice_not_delivered",
    "the latest of the notices counts: an old d7 does not make up for a rescheduled one sent an hour ago"
  );
  await schedule();
  assert.equal(await statusOf(owner, settlingId), "closed");
  await aged(settlingId, settle + 1);
  assert.equal(await waitOf(owner, settlingId), null);
  await schedule();
  assert.equal(
    await statusOf(owner, settlingId),
    "purge_pending",
    "delivered more than 7 days ago, the schedule goes on"
  );
  tests.push(
    "the schedule waits (closure_notice_not_delivered) while the latest d7 or rescheduled notice of the cycle was delivered less than 7 days ago, even with an older one delivered before it; delivered more than 7 days ago, it goes on"
  );

  // the run checks the age again: held back by a fresh notice (and counted by the alert), then taken once it is 7 days old
  await pastTime(settlingId);
  await keepOthersAway(settlingId);
  const withAged = await maintenance.countPurgesHeldBack();
  await aged(settlingId, settle - 1);
  assert.equal(
    await maintenance.countPurgesHeldBack(),
    withAged + 1,
    "a purge held back by a notice delivered less than 7 days ago is counted"
  );
  assert.equal(
    await maintenance.claimOrganizationPurge(900),
    null,
    "the claim does not take a purge whose notice was delivered less than 7 days ago"
  );
  await aged(settlingId, settle + 1);
  const settledClaim = await maintenance.claimOrganizationPurge(900);
  assert.equal(settledClaim?.organizationId, settlingId);
  await aged(settlingId, settle - 1);
  await expectPurgeRefusal(
    () => maintenance.markOrganizationPurgeStorageTouched(settlingId),
    "closure_notice_not_delivered",
    "the storage is not touched when the notice was delivered less than 7 days ago"
  );
  await expectPurgeRefusal(
    () => maintenance.purgeOrganizationData(settlingId),
    "closure_notice_not_delivered",
    "the purge refuses when the notice was delivered less than 7 days ago"
  );
  assert.equal(await statusOf(owner, settlingId), "purge_pending");
  await aged(settlingId, settle + 1);
  await owner.query(
    "UPDATE public.organization_purges SET locked_until = NULL WHERE organization_id = $1",
    [settlingId]
  );
  assert.deepEqual(
    await runOrganizationPurges({
      bucket: context.bucket,
      client: maintenance,
      now: () => new Date(),
    }),
    { failed: 0, purged: 1, swept: 1 }
  );
  assert.equal(await statusOf(owner, settlingId), "purged");
  tests.push(
    "the run checks the age of the notice again: delivered less than 7 days ago, the claim does not take the purge, the alert counts it, and the mark before the storage and purge_organization_data refuse with closure_notice_not_delivered; delivered more than 7 days ago, the purge runs"
  );

  // the Admin's purge waits the same 7 days: the case may schedule it at once, the run does not
  const settlingAdmin = await closedOrganization(
    owner,
    "notice settle admin",
    requested,
    { notice: false }
  );
  await writeNotice(owner, settlingAdmin.organizationId, "d7", "sent", {
    sentAgoHours: 1,
  });
  await owner.query(
    `UPDATE public.organization_billing
        SET state = 'active', access_ends_at = now() - interval '1 day', provider = 'asaas', provider_ref = $2,
            cancel_at_period_end = true
      WHERE organization_id = $1`,
    [settlingAdmin.organizationId, `sub_gate_${randomUUID().slice(0, 8)}`]
  );
  const adminScheduled = await scheduleOrganizationPurge(
    admin,
    principal,
    await acceptedDeletionCase(context, settlingAdmin.organizationId),
    settlingAdmin.organizationId
  );
  assert.equal(adminScheduled?.status, "purge_pending");
  await pastTime(settlingAdmin.organizationId);
  await keepOthersAway(settlingAdmin.organizationId);
  assert.equal(
    await maintenance.claimOrganizationPurge(900),
    null,
    "an Admin purge is not taken while the notice was delivered an hour ago"
  );
  await aged(settlingAdmin.organizationId, settle + 1);
  assert.deepEqual(
    await runOrganizationPurges({
      bucket: context.bucket,
      client: maintenance,
      now: () => new Date(),
    }),
    { failed: 0, purged: 1, swept: 1 }
  );
  assert.equal(await statusOf(owner, settlingAdmin.organizationId), "purged");
  tests.push(
    "the Admin's purge scheduled by the case waits for the notice to be 7 days old as well: not taken with the notice delivered an hour ago, and it runs once the notice is older than 7 days"
  );

  // a notice still owed days after its date enters the alert, whatever the switch; one settled or skipped does not
  const owed = await closedOrganization(owner, "notice owed", requested, {
    notice: false,
  });
  const overdue = async () =>
    (await maintenance.recordClosureNotices(1000)).overdue;
  // the job writes this store's own notices on the first call: they are settled, so the count is taken without them
  await overdue();
  await owner.query(
    "UPDATE public.closure_notices SET sent_at = now() WHERE organization_id = $1 AND NOT skipped",
    [owed.organizationId]
  );
  const before = await overdue();
  const limitHours = CLOSURE_NOTICE_OVERDUE_DAYS * 24;
  await writeNotice(owner, owed.organizationId, "d30", "unresolved", {
    dueAgoHours: limitHours - 1,
  });
  assert.equal(
    await overdue(),
    before,
    "an unresolved notice younger than the limit is not counted"
  );
  await writeNotice(owner, owed.organizationId, "d30", "unresolved", {
    dueAgoHours: limitHours + 1,
  });
  assert.equal(
    await overdue(),
    before + 1,
    `an unresolved notice older than ${CLOSURE_NOTICE_OVERDUE_DAYS} days is counted`
  );
  for (const state of ["sent", "failed", "skipped"] as const) {
    await writeNotice(owner, owed.organizationId, "d30", state, {
      dueAgoHours: limitHours + 1,
    });
    assert.equal(
      await overdue(),
      before,
      `a notice ${state} is settled: not counted`
    );
  }
  await writeNotice(owner, owed.organizationId, "d30", "unresolved", {
    dueAgoHours: limitHours + 1,
  });
  await owner.query(
    "UPDATE public.organization_closures SET recovered_at = now(), closed_at = NULL WHERE organization_id = $1",
    [owed.organizationId]
  );
  assert.equal(
    await overdue(),
    before,
    "a notice of a closure the owner undid is not counted"
  );
  tests.push(
    `a notice still owed for more than ${CLOSURE_NOTICE_OVERDUE_DAYS} days (neither sent, failed nor skipped, in a closure still on) enters the alert, with the switch of the automatic purge on or off; a younger one, a settled one and one of a recovered closure do not`
  );
  return tests;
}
