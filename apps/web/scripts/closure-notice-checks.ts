// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  placeOrganizationLegalHold,
  releaseOrganizationLegalHold,
} from "@polaris/db/admin-support-repository";
import {
  CLOSURE_NOTICE_MILESTONES,
  closureDeadlines,
} from "@polaris/domain/organization/closure-deadlines";
import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import type { QueueEnvelope } from "@polaris/domain/events/queue-envelope";
import { expectSqlState } from "../../../packages/db/scripts/sales-gate-support";
import { runPrivacyMaintenance } from "../src/server/privacy/maintenance";
import { handleClosureNotice } from "../src/server/privacy/closure-notice";
import { runOrganizationPurges } from "../src/server/privacy/organization-purge-job";
import {
  type AutomaticPurgeContext,
  asRole,
  awayFromMidnight,
  closedOrganization as closedWithDeliveredNotice,
  dbNow,
  localDayStart,
  type Pool,
  purgeRow,
  setAsideOthers,
  statusOf,
  supportCaseOf,
  ZONE,
} from "./organization-purge-automatic-checks";

/**
 * The notices of a closure (ADR 0102 amended, AC-30, AC-31 and AC-50) on a real PostgreSQL 18, with the real job: the
 * clock is the database's, and each closure is written with the request instant the case needs. One notice per
 * milestone and cycle, written once its date arrives, the same with or without a legal hold; of the milestones due
 * together only the latest goes out (with its outbox event), the others are written skipped; a purge pushed by the
 * release of a legal hold gets a new notice; the notices survive the purge; only the privacy runtime reaches them.
 */

const DAY_MS = 86_400_000;

/** These checks are about the notices themselves: a store starts with none, and a delivered one is a check's own work. */
const closedOrganization = (
  owner: Pool,
  label: string,
  requestedAt: Date,
  options: { recoverUntil?: Date; zone?: string } = {}
) =>
  closedWithDeliveredNotice(owner, label, requestedAt, {
    ...options,
    notice: false,
  });

interface NoticeRow {
  closure_requested_at: Date;
  due_at: Date;
  failed_at: Date | null;
  failure_code: string | null;
  id: string;
  milestone: string;
  purge_from: Date | null;
  sent_at: Date | null;
  skipped: boolean;
  user_id: string;
}

async function noticesOf(owner: Pool, organizationId: string) {
  return (
    await owner.query<NoticeRow>(
      `SELECT id, closure_requested_at, milestone, due_at, purge_from, user_id, skipped, sent_at, failed_at, failure_code
         FROM public.closure_notices WHERE organization_id = $1 ORDER BY due_at, milestone`,
      [organizationId]
    )
  ).rows;
}

/** Each milestone as `name` or `name (skipped)`, in the order of their dates. */
async function milestonesOf(owner: Pool, organizationId: string) {
  return (await noticesOf(owner, organizationId)).map((notice) =>
    notice.skipped ? `${notice.milestone} (skipped)` : notice.milestone
  );
}

async function eventsOf(owner: Pool, organizationId: string) {
  return (
    await owner.query<{
      event: Record<string, unknown>;
      idempotency_key: string;
      status: string;
    }>(
      "SELECT event, idempotency_key, status FROM public.event_outbox WHERE organization_id = $1 AND type = 'organization.closure_notice' ORDER BY id",
      [organizationId]
    )
  ).rows;
}

export async function verifyClosureNotices(
  context: AutomaticPurgeContext
): Promise<string[]> {
  await awayFromMidnight(context.owner);
  // the schedule below takes the whole database: the other closed organizations are moved out of its reach meanwhile
  const restoreOthers = await setAsideOthers(context.owner);
  try {
    return await noticeScenario(context);
  } finally {
    await restoreOthers();
  }
}

async function noticeScenario(
  context: AutomaticPurgeContext
): Promise<string[]> {
  const { admin, maintenance, owner, principal } = context;
  const tests: string[] = [];
  const record = () => maintenance.recordClosureNotices(1000);

  // the milestones of the domain are the ones the database allows
  const allowed = (
    await owner.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_catalog.pg_constraint
        WHERE conname = 'closure_notices_milestone_allowed'`
    )
  ).rows[0]?.definition;
  assert.ok(allowed);
  assert.deepEqual(
    [...allowed.matchAll(/'([a-z0-9_]+)'::text/g)].map((match) => match[1]),
    [...CLOSURE_NOTICE_MILESTONES]
  );

  // a closure just asked for (still closing): the notice of the request, once
  const now = await dbNow(owner);
  const closing = await closedOrganization(owner, "notice closing", now, {
    recoverUntil: new Date(now.getTime() + 30 * DAY_MS),
  });
  await owner.query(
    "UPDATE public.organizations SET status = 'closing' WHERE id = $1",
    [closing.organizationId]
  );
  await owner.query(
    "UPDATE public.organization_closures SET closed_at = NULL WHERE organization_id = $1",
    [closing.organizationId]
  );
  // 65 days ago: D minus 30 arrived, D minus 7 did not; the request's notice was never written (a run that stopped)
  const day65 = await localDayStart(owner, ZONE, -65);
  const thirty = await closedOrganization(owner, "notice d30", day65);
  // 83 days ago, to the last second of the local day: D minus 7 is today
  const lastSecond = new Date(
    (await localDayStart(owner, ZONE, -82)).getTime() - 1000
  );
  const seven = await closedOrganization(owner, "notice d7", lastSecond);
  // 91 days ago, and the same under a legal hold: D arrived; the hold changes nothing of what the owner is told
  const day91 = await localDayStart(owner, ZONE, -91);
  const deletion = await closedOrganization(owner, "notice d", day91);
  const held = await closedOrganization(owner, "notice d held", day91);
  await placeOrganizationLegalHold(
    admin,
    principal,
    await supportCaseOf(context, held.organizationId),
    held.organizationId,
    new Date(Date.now() + 30 * DAY_MS).toISOString()
  );

  const first = await record();
  assert.ok(first.recorded >= 5);
  assert.deepEqual(await milestonesOf(owner, closing.organizationId), [
    "closure",
  ]);
  assert.deepEqual(await milestonesOf(owner, thirty.organizationId), [
    "closure (skipped)",
    "d30",
  ]);
  assert.deepEqual(await milestonesOf(owner, seven.organizationId), [
    "closure (skipped)",
    "d30 (skipped)",
    "d7",
  ]);
  const deletionMilestones = [
    "closure (skipped)",
    "d30 (skipped)",
    "d7 (skipped)",
    "deletion_day",
  ];
  assert.deepEqual(
    await milestonesOf(owner, deletion.organizationId),
    deletionMilestones
  );
  assert.deepEqual(
    await milestonesOf(owner, held.organizationId),
    deletionMilestones
  );
  // the dates are the domain's, in the organization's calendar
  const sevenDates = closureDeadlines(lastSecond, ZONE);
  const sevenNotices = await noticesOf(owner, seven.organizationId);
  assert.deepEqual(
    sevenNotices.map((notice) => new Date(notice.due_at).toISOString()),
    [
      lastSecond.toISOString(),
      sevenDates.d30At.toISOString(),
      sevenDates.d7At.toISOString(),
    ]
  );
  for (const notice of sevenNotices) {
    assert.equal(
      new Date(notice.closure_requested_at).toISOString(),
      lastSecond.toISOString()
    );
    assert.equal(notice.user_id, seven.userId);
    assert.equal(notice.purge_from, null);
  }
  tests.push(
    "the job writes one notice per milestone whose local date arrived (the request, D minus 30, D minus 7, D), at the domain's dates; of the milestones due together only the latest goes out and the earlier ones are written skipped; a legal hold changes nothing of it"
  );

  // one outbox event per notice that goes out, naming only the notice; none for a skipped one
  for (const tenant of [closing, thirty, seven, deletion, held]) {
    const sent = (await noticesOf(owner, tenant.organizationId)).filter(
      (candidate) => !candidate.skipped
    );
    assert.equal(sent.length, 1);
    const [going] = sent;
    assert.ok(going);
    assert.deepEqual(await eventsOf(owner, tenant.organizationId), [
      {
        event: { noticeId: going.id },
        idempotency_key: outboxIdempotencyKey(
          "organization.closure_notice",
          going.id
        ),
        status: "pending",
      },
    ]);
  }
  // running again, or two runs at once, writes nothing more
  await record();
  for (const tenant of [closing, thirty, seven, deletion, held]) {
    assert.equal((await eventsOf(owner, tenant.organizationId)).length, 1);
  }
  assert.equal(
    (await noticesOf(owner, seven.organizationId)).length,
    3,
    "a second run writes nothing more"
  );
  const raced = await Promise.all([
    closedOrganization(owner, "notice race a", lastSecond),
    closedOrganization(owner, "notice race b", lastSecond),
  ]);
  await Promise.all([
    maintenance.recordClosureNotices(1000),
    context.concurrent.recordClosureNotices(1000),
  ]);
  for (const tenant of raced) {
    assert.deepEqual(await milestonesOf(owner, tenant.organizationId), [
      "closure (skipped)",
      "d30 (skipped)",
      "d7",
    ]);
    assert.equal((await eventsOf(owner, tenant.organizationId)).length, 1);
  }
  tests.push(
    "each notice that goes out has one outbox event, organization.closure_notice with only the notice's ID under its own key, and a skipped one has none; a second run, or two runs at once, write nothing more"
  );

  // time passes for the d30 store (its closure and notices 20 days earlier, the same cycle): D minus 7 goes out alone
  await owner.query(
    `UPDATE public.organization_closures
        SET requested_at = requested_at - interval '20 days', recover_until = recover_until - interval '20 days',
            closed_at = closed_at - interval '20 days'
      WHERE organization_id = $1`,
    [thirty.organizationId]
  );
  await owner.query(
    `UPDATE public.closure_notices
        SET closure_requested_at = closure_requested_at - interval '20 days', due_at = due_at - interval '20 days'
      WHERE organization_id = $1`,
    [thirty.organizationId]
  );
  await record();
  assert.deepEqual(await milestonesOf(owner, thirty.organizationId), [
    "closure (skipped)",
    "d30",
    "d7",
  ]);
  assert.equal((await eventsOf(owner, thirty.organizationId)).length, 2);
  tests.push(
    "a later milestone of the same cycle goes out on its own, and the earlier ones are left as they were"
  );

  // the owner undoes the closure: nothing more is written for it; a new closure is a new cycle, with notices of its own
  await owner.query(
    "UPDATE public.organization_closures SET recovered_at = now() WHERE organization_id = $1",
    [closing.organizationId]
  );
  await owner.query(
    "UPDATE public.organizations SET status = 'active' WHERE id = $1",
    [closing.organizationId]
  );
  const [oldNotice] = await noticesOf(owner, closing.organizationId);
  assert.ok(oldNotice);
  assert.equal(
    await maintenance.claimClosureNoticeDelivery(
      oldNotice.id,
      closing.organizationId
    ),
    null,
    "a notice of an undone closure is not to go out"
  );
  await record();
  assert.equal((await noticesOf(owner, closing.organizationId)).length, 1);
  await owner.query(
    `UPDATE public.organization_closures
        SET requested_at = now(), recover_until = now() + interval '30 days', recovered_at = NULL, closed_at = NULL
      WHERE organization_id = $1`,
    [closing.organizationId]
  );
  await owner.query(
    "UPDATE public.organizations SET status = 'closing' WHERE id = $1",
    [closing.organizationId]
  );
  await record();
  const cycles = await noticesOf(owner, closing.organizationId);
  assert.deepEqual(
    cycles.map((notice) => notice.milestone),
    ["closure", "closure"]
  );
  assert.notEqual(
    new Date(cycles[0]?.closure_requested_at ?? 0).toISOString(),
    new Date(cycles[1]?.closure_requested_at ?? 0).toISOString()
  );
  tests.push(
    "an undone closure gets no more notices and its pending one is not to go out; a closure asked for again is a new cycle with notices of its own"
  );

  // the owner it is for: the one who asked, while a member; else the oldest membership
  const coOwned = await closedOrganization(
    owner,
    "notice co-owned",
    lastSecond
  );
  const other = randomUUID();
  await owner.query(
    'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
    [other, "Co-dona do gate", `gate-${other}@example.invalid`]
  );
  await owner.query(
    "INSERT INTO public.memberships (organization_id, user_id, role, status, created_at) VALUES ($1, $2, 'owner', 'active', now() - interval '400 days')",
    [coOwned.organizationId, other]
  );
  const leftBy = await closedOrganization(
    owner,
    "notice requester left",
    lastSecond
  );
  const stays = randomUUID();
  await owner.query(
    'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
    [stays, "Dona que ficou", `gate-${stays}@example.invalid`]
  );
  await owner.query(
    "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
    [leftBy.organizationId, stays]
  );
  await owner.query(
    "DELETE FROM public.memberships WHERE organization_id = $1 AND user_id = $2",
    [leftBy.organizationId, leftBy.userId]
  );
  // nobody left to tell: no notice, and the store never holds back the batch (a limit of 1 still reaches the next one)
  const orphan = await closedOrganization(owner, "notice orphan", lastSecond);
  await owner.query(
    "DELETE FROM public.memberships WHERE organization_id = $1",
    [orphan.organizationId]
  );
  const behind = await closedOrganization(
    owner,
    "notice behind orphan",
    lastSecond
  );
  await record();
  assert.deepEqual(await noticesOf(owner, orphan.organizationId), []);
  assert.equal(
    (await maintenance.recordClosureNotices(1)).organizations,
    0,
    "the orphan store is not even looked at"
  );
  assert.equal((await noticesOf(owner, behind.organizationId)).length, 3);
  for (const notice of await noticesOf(owner, coOwned.organizationId)) {
    assert.equal(notice.user_id, coOwned.userId, "the one who asked");
  }
  for (const notice of await noticesOf(owner, leftBy.organizationId)) {
    assert.equal(notice.user_id, stays, "the remaining owner");
  }
  tests.push(
    "the notice is for the owner who asked for the closure while still a member, else for the remaining owner"
  );

  // a purge the closure period scheduled late, then held and released: the release pushes it, and the owner gets a new
  // notice of 7 days naming the new date; a release that does not push it gives none
  const pushed = await closedWithDeliveredNotice(
    owner,
    "notice rescheduled",
    await localDayStart(owner, ZONE, -93)
  );
  await maintenance.scheduleClosedOrganizationPurges(1000);
  await record();
  // the notice of D minus 7 days of this store was delivered in its time (the schedule waited for it), so only the
  // milestones after it are written now
  assert.deepEqual(await milestonesOf(owner, pushed.organizationId), [
    "closure (skipped)",
    "d30 (skipped)",
    "d7",
    "deletion_day",
  ]);
  const holdCase = await supportCaseOf(context, pushed.organizationId);
  await placeOrganizationLegalHold(
    admin,
    principal,
    holdCase,
    pushed.organizationId,
    new Date(Date.now() + 30 * DAY_MS).toISOString()
  );
  await record();
  assert.equal(
    (await noticesOf(owner, pushed.organizationId)).length,
    4,
    "placing a hold writes nothing (the owner is told the same)"
  );
  await releaseOrganizationLegalHold(
    admin,
    principal,
    holdCase,
    pushed.organizationId
  );
  const pushedRow = await purgeRow(owner, pushed.organizationId);
  assert.ok(pushedRow);
  await record();
  const rescheduled = (await noticesOf(owner, pushed.organizationId)).filter(
    (notice) => notice.milestone === "rescheduled"
  );
  assert.equal(rescheduled.length, 1);
  assert.equal(rescheduled[0]?.skipped, false);
  assert.equal(
    new Date(rescheduled[0]?.purge_from ?? 0).toISOString(),
    new Date(pushedRow.not_before).toISOString()
  );
  assert.equal(
    new Date(rescheduled[0]?.due_at ?? 0).getTime(),
    new Date(pushedRow.not_before).getTime() - 7 * DAY_MS
  );
  assert.equal((await eventsOf(owner, pushed.organizationId)).length, 2);
  // with a later date already written (here 30 days on, whose notice is not due yet), a hold placed and released
  // again does not move it, and gives no new notice
  await owner.query(
    "UPDATE public.organization_purges SET not_before = not_before + interval '30 days' WHERE organization_id = $1",
    [pushed.organizationId]
  );
  await record();
  await placeOrganizationLegalHold(
    admin,
    principal,
    holdCase,
    pushed.organizationId,
    new Date(Date.now() + 30 * DAY_MS).toISOString()
  );
  await releaseOrganizationLegalHold(
    admin,
    principal,
    holdCase,
    pushed.organizationId
  );
  const beforeUnmoved = (await noticesOf(owner, pushed.organizationId)).length;
  await record();
  assert.equal(
    (await noticesOf(owner, pushed.organizationId)).length,
    beforeUnmoved,
    "a release that does not move the date gives no new notice"
  );
  tests.push(
    "a legal hold placed after the schedule writes nothing; its release, which pushes the purge, gives one new notice (rescheduled) naming the new date, due at the release; a release that does not move the date gives none"
  );

  // the consumer reads a notice by ID and organization, and settles it once: before the e-mail exists, it fails closed
  const sevenSent = sevenNotices.find((notice) => !notice.skipped);
  const sevenSkipped = sevenNotices.find((notice) => notice.skipped);
  assert.ok(sevenSent && sevenSkipped);
  const delivery = await maintenance.claimClosureNoticeDelivery(
    sevenSent.id,
    seven.organizationId
  );
  assert.ok(delivery);
  assert.deepEqual(
    {
      deletableFrom: delivery.deletableFrom.toISOString(),
      deletionDate: delivery.deletionDate,
      milestone: delivery.milestone,
      purgeFrom: delivery.purgeFrom,
      requestedAt: delivery.requestedAt.toISOString(),
      timeZone: delivery.timeZone,
      userId: delivery.userId,
    },
    {
      deletableFrom: sevenDates.deletableFrom.toISOString(),
      deletionDate: sevenDates.deletionDate,
      milestone: "d7",
      purgeFrom: null,
      requestedAt: lastSecond.toISOString(),
      timeZone: ZONE,
      userId: seven.userId,
    }
  );
  assert.equal(
    JSON.stringify(delivery).includes("@"),
    false,
    "no address in what the consumer reads"
  );
  assert.equal(
    await maintenance.claimClosureNoticeDelivery(
      sevenSent.id,
      thirty.organizationId
    ),
    null,
    "another organization's ID finds nothing"
  );
  assert.equal(
    await maintenance.claimClosureNoticeDelivery(
      sevenSkipped.id,
      seven.organizationId
    ),
    null,
    "a skipped notice is not to go out"
  );
  assert.equal(
    await maintenance.markClosureNoticeSent(
      sevenSkipped.id,
      seven.organizationId
    ),
    false
  );
  const [event] = await eventsOf(owner, seven.organizationId);
  assert.ok(event);
  const envelope: QueueEnvelope = {
    attempt: 1,
    correlationId: randomUUID(),
    event: { noticeId: sevenSent.id },
    eventId: randomUUID(),
    idempotencyKey: event.idempotency_key,
    organizationId: seven.organizationId,
    type: "organization.closure_notice",
    version: 1,
  };
  await handleClosureNotice({ email: null, notices: maintenance }, envelope);
  await handleClosureNotice({ email: null, notices: maintenance }, envelope);
  const settled = (await noticesOf(owner, seven.organizationId)).find(
    (notice) => notice.id === sevenSent.id
  );
  // with no e-mail configured the notice is left unresolved: neither sent nor failed, so the
  // change that sends the e-mail still finds it, and the deletion keeps waiting for it
  assert.equal(settled?.failure_code, null);
  assert.equal(settled?.failed_at, null);
  assert.equal(settled?.sent_at, null);
  assert.ok(
    await maintenance.claimClosureNoticeDelivery(
      sevenSent.id,
      seven.organizationId
    ),
    "an unresolved notice is still to go out"
  );
  assert.equal(
    await maintenance.markClosureNoticeFailed(
      sevenSent.id,
      seven.organizationId,
      "address_refused"
    ),
    true,
    "a real failure (a refused address) is settled once"
  );
  assert.equal(
    await maintenance.claimClosureNoticeDelivery(
      sevenSent.id,
      seven.organizationId
    ),
    null
  );
  assert.equal(
    await maintenance.markClosureNoticeSent(sevenSent.id, seven.organizationId),
    false,
    "a failed notice is never marked sent afterwards"
  );
  const raceNotice = (
    await noticesOf(owner, raced[0]?.organizationId ?? "")
  ).find((candidate) => !candidate.skipped);
  assert.ok(raceNotice && raced[0]);
  assert.equal(
    await maintenance.markClosureNoticeSent(
      raceNotice.id,
      raced[0].organizationId
    ),
    true
  );
  assert.equal(
    await maintenance.markClosureNoticeFailed(
      raceNotice.id,
      raced[0].organizationId,
      "email_not_configured"
    ),
    false,
    "a sent notice is never marked failed afterwards"
  );
  await expectSqlState(
    () =>
      maintenance.markClosureNoticeFailed(
        raceNotice.id,
        raced[0]?.organizationId ?? "",
        "Falhou: owner@example.com"
      ),
    "22023",
    "a failure is a short code, never a message"
  );
  tests.push(
    "the consumer reads a notice by its ID and organization (milestone, owner's ID, the domain's dates, never an address), not one that is skipped, settled or of another organization; before the e-mail exists the consumer leaves it unresolved, neither sent nor failed, and a notice sent or failed is settled for good"
  );

  // the notices survive the purge (the real one, by the job), and nothing more is written for a purged store
  const purged = await closedWithDeliveredNotice(
    owner,
    "notice purged",
    await localDayStart(owner, ZONE, -95)
  );
  await maintenance.scheduleClosedOrganizationPurges(1000);
  await record();
  const beforePurge = await noticesOf(owner, purged.organizationId);
  assert.ok(beforePurge.length > 0);
  await owner.query(
    "UPDATE public.organization_purges SET not_before = now() - interval '1 second', locked_until = NULL WHERE organization_id = $1",
    [purged.organizationId]
  );
  await owner.query(
    "UPDATE public.organization_purges SET locked_until = now() + interval '1 day' WHERE organization_id <> $1 AND swept_at IS NULL",
    [purged.organizationId]
  );
  assert.deepEqual(
    await runOrganizationPurges({
      bucket: context.bucket,
      client: maintenance,
      now: () => new Date(),
    }),
    { failed: 0, purged: 1, swept: 1 }
  );
  assert.equal(await statusOf(owner, purged.organizationId), "purged");
  await record();
  assert.deepEqual(await noticesOf(owner, purged.organizationId), beforePurge);
  const purgedSent = beforePurge.find((notice) => !notice.skipped);
  assert.ok(purgedSent);
  assert.equal(
    await maintenance.claimClosureNoticeDelivery(
      purgedSent.id,
      purged.organizationId
    ),
    null,
    "a notice of a purged store is not to go out"
  );
  tests.push(
    "nothing more is written for a purged store, and a notice of it is not to go out (the rows survive the purge: the purge gate's catalog lists closure_notices among the kept tables)"
  );

  // the real job writes them whatever the switch of the automatic purge
  const switchedOff = await closedOrganization(
    owner,
    "notice switch off",
    lastSecond
  );
  const report = await runPrivacyMaintenance(maintenance, {
    autoPurgeEnabled: false,
  });
  assert.ok(report.closureNoticesRecorded >= 1);
  assert.deepEqual(await milestonesOf(owner, switchedOff.organizationId), [
    "closure (skipped)",
    "d30 (skipped)",
    "d7",
  ]);
  tests.push(
    "the privacy job writes the notices with CLOSURE_AUTO_PURGE_ENABLED off too (the dates are the owner's, the switch is the purge's)"
  );

  // a notice delivered lets a store be deleted (ADR 0102, amended): `mark_closure_notice_sent` takes only a notice of
  // the cycle in course, and the purge owner reads four columns of the delivered d7 and rescheduled ones, nothing more
  const cycle = await closedOrganization(
    owner,
    "notice cycle",
    await localDayStart(owner, ZONE, -50)
  );
  const stale = await owner.query<{ id: string }>(
    `INSERT INTO public.closure_notices
       (organization_id, closure_requested_at, milestone, due_at, user_id)
     SELECT organization_id, requested_at - interval '1 day', 'd7', requested_at - interval '1 day', requested_by_user_id
       FROM public.organization_closures WHERE organization_id = $1
     RETURNING id`,
    [cycle.organizationId]
  );
  const staleId = stale.rows[0]?.id;
  assert.ok(staleId);
  assert.equal(
    await maintenance.markClosureNoticeSent(staleId, cycle.organizationId),
    false,
    "a notice of another cycle is never marked sent"
  );
  const current = await owner.query<{ id: string }>(
    `INSERT INTO public.closure_notices
       (organization_id, closure_requested_at, milestone, due_at, user_id)
     SELECT organization_id, requested_at, 'd7', requested_at, requested_by_user_id
       FROM public.organization_closures WHERE organization_id = $1
     RETURNING id`,
    [cycle.organizationId]
  );
  const currentId = current.rows[0]?.id;
  assert.ok(currentId);
  assert.equal(
    await maintenance.markClosureNoticeSent(currentId, cycle.organizationId),
    true
  );
  for (const statement of [
    "SELECT user_id FROM public.closure_notices",
    "SELECT failure_code FROM public.closure_notices",
    "SELECT * FROM public.closure_notices",
    "UPDATE public.closure_notices SET sent_at = now()",
    "DELETE FROM public.closure_notices",
  ]) {
    await expectSqlState(
      () => asRole(owner, "polaris_purge_owner", statement),
      "42501",
      `the purge owner: ${statement}`
    );
  }
  const visible = await asRole(
    owner,
    "polaris_purge_owner",
    "SELECT milestone, (sent_at IS NOT NULL OR dismissed_at IS NOT NULL) AS delivered FROM public.closure_notices"
  );
  assert.ok(visible.rows.length > 0);
  // delivered, or dismissed by the support (0091): what lets a store be deleted
  for (const row of visible.rows) {
    assert.ok(["d7", "rescheduled"].includes(row.milestone));
    assert.equal(row.delivered, true);
  }
  // the account of a user takes the rows of the user's notices along, with the table forced
  const leaving = randomUUID();
  await owner.query(
    'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
    [leaving, "Conta que sai", `gate-${leaving}@example.invalid`]
  );
  await owner.query(
    `INSERT INTO public.closure_notices (organization_id, closure_requested_at, milestone, due_at, user_id)
     SELECT organization_id, requested_at, 'closure', requested_at, $2
       FROM public.organization_closures WHERE organization_id = $1`,
    [cycle.organizationId, leaving]
  );
  await owner.query('DELETE FROM public."user" WHERE id = $1', [leaving]);
  const left = await owner.query(
    "SELECT 1 FROM public.closure_notices WHERE user_id = $1",
    [leaving]
  );
  assert.equal(left.rows.length, 0);
  tests.push(
    "mark_closure_notice_sent takes only a notice of the cycle in course; the purge owner reads only milestone, cycle, organization and sent_at of the delivered d7 and rescheduled notices (not the user, not a failure code, no write), and deleting a user's account takes the user's notices with it under FORCE ROW LEVEL SECURITY"
  );

  // only the privacy runtime reaches them, and only through its functions
  for (const [label, pool] of [
    ["tenant", context.runtimes.tenant],
    ["admin", context.runtimes.admin],
  ] as const) {
    for (const statement of [
      "SELECT public.record_closure_notices(10)",
      `SELECT public.claim_closure_notice_delivery('${sevenSent.id}'::uuid, '${seven.organizationId}')`,
      `SELECT public.mark_closure_notice_sent('${sevenSent.id}'::uuid, '${seven.organizationId}')`,
      `SELECT public.mark_closure_notice_failed('${sevenSent.id}'::uuid, '${seven.organizationId}', 'x')`,
      "SELECT count(*) FROM public.closure_notices",
    ]) {
      await expectSqlState(
        () => pool.query(statement),
        "42501",
        `the ${label} runtime: ${statement}`
      );
    }
  }
  await expectSqlState(
    () =>
      asRole(
        owner,
        "polaris_privacy_runtime",
        "SELECT count(*) FROM public.closure_notices"
      ),
    "42501",
    "the privacy runtime reads the table only through the functions"
  );
  // the legal hold stays unread by the privacy owner: the notice of a rescheduled purge comes from its dates (R3)
  const holdAccess = await owner.query<{ allowed: boolean }>(
    "SELECT has_table_privilege('polaris_privacy_owner', 'public.organization_legal_holds', 'SELECT') AS allowed"
  );
  assert.equal(holdAccess.rows[0]?.allowed, false);
  await expectSqlState(
    () => maintenance.recordClosureNotices(0),
    "22023",
    "a limit of 0 is refused"
  );
  await expectSqlState(
    () => maintenance.recordClosureNotices(1001),
    "22023",
    "a limit above 1000 is refused"
  );
  // the privacy owner writes an event only for a notice still to go out, naming nothing but it: each probe has the
  // exact key, and breaks one rule only
  const pendingNotice = (await noticesOf(owner, deletion.organizationId)).find(
    (candidate) =>
      !(candidate.skipped || candidate.sent_at || candidate.failed_at)
  );
  assert.ok(pendingNotice);
  for (const [label, organizationId, noticeId, body] of [
    [
      "a skipped notice",
      seven.organizationId,
      sevenSkipped.id,
      { noticeId: sevenSkipped.id },
    ],
    [
      "a notice already settled",
      seven.organizationId,
      sevenSent.id,
      { noticeId: sevenSent.id },
    ],
    [
      "a notice of another organization",
      seven.organizationId,
      pendingNotice.id,
      { noticeId: pendingNotice.id },
    ],
    [
      "a body with more than the notice",
      deletion.organizationId,
      pendingNotice.id,
      { noticeId: pendingNotice.id, userId: deletion.userId },
    ],
  ] as const) {
    await expectSqlState(
      () =>
        asRole(
          owner,
          "polaris_privacy_owner",
          `INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id)
           VALUES ($1, 'organization.closure_notice', $2::jsonb, $3, $4)`,
          [
            organizationId,
            JSON.stringify(body),
            `organization.closure_notice:${noticeId}`,
            randomUUID(),
          ]
        ),
      "42501",
      `the privacy owner cannot write the event of ${label}`
    );
  }
  tests.push(
    "only the privacy runtime runs the functions of the notices (the tenant and Admin runtimes are refused, and nobody reads the table directly), within a limit; the privacy owner writes an outbox event only for a notice still to go out, naming nothing but it"
  );

  return tests;
}
