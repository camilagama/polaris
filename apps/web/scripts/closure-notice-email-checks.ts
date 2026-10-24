// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import {
  dismissClosureNotice,
  openPrivacyCase,
  reissueClosureNotice,
} from "@polaris/db/admin-support-repository";
import type { ClosureNoticeRecipientClient } from "@polaris/db/closure-notice-recipient";
import { InvalidSupportRequestError } from "@polaris/domain/admin/support-access";
import { OrganizationPurgeRefusedError } from "@polaris/domain/privacy/organization-purge";
import { randomUUID } from "node:crypto";
import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import { expectSqlState } from "../../../packages/db/scripts/sales-gate-support";
import {
  type ClosureNoticeDependencies,
  ClosureNoticeRetryError,
  handleClosureNotice,
  handOverOwedClosureNotices,
} from "../src/server/privacy/closure-notice";
import type {
  ClosureNoticeSendResult,
  ClosureNoticeSender,
} from "../src/server/privacy/closure-notice-email";
import {
  acceptedDeletionCase,
  type AutomaticPurgeContext,
  asRole,
  awayFromMidnight,
  closedOrganization as closedWithDeliveredNotice,
  localDayStart,
  type Pool,
  setAsideOthers,
  supportCaseOf,
  ZONE,
} from "./organization-purge-automatic-checks";

/**
 * The e-mail of the closure notices and the act of the support (ADR 0102 amended, line E of design t107, conditions of
 * the security review of 20/10/2026) on a real PostgreSQL 18, with the real functions and roles: the address is read
 * only by the function of the authentication role, only for a notice still owed and only when verified; the provider
 * (a fake that records what it got) takes the notice's ID as its key; the handover sends the latest notice owed and
 * settles the earlier ones `skipped`; and the support sends a `d7` again or dismisses it, never by an UPDATE, under a
 * privacy case, with the platform audit, a dismissal counting as delivered for the purge 7 days later.
 */

export interface ClosureNoticeEmailContext extends AutomaticPurgeContext {
  /** The real client of `closure_notice_recipient`, through a login of the authentication runtime. */
  recipients: ClosureNoticeRecipientClient;
}

const CONFIG = {
  apiKey: "re_gate_not_a_key",
  appOrigin: "https://app.example.invalid",
  from: "Polaris <avisos@example.invalid>",
};

interface Sent {
  html: string;
  idempotencyKey: string;
  subject: string;
  text: string;
  to: string;
}

function fakeProvider(
  answer: () => ClosureNoticeSendResult = () => ({ outcome: "sent" })
) {
  const sent: Sent[] = [];
  const send: ClosureNoticeSender = (message: Sent) => {
    sent.push(message);
    return Promise.resolve(answer());
  };
  return { send, sent };
}

interface Row {
  dismissed_at: Date | null;
  failed_at: Date | null;
  failure_code: string | null;
  id: string;
  milestone: string;
  recorded_at: Date;
  reissue: number;
  sent_at: Date | null;
  skipped: boolean;
  user_id: string | null;
}

async function rowsOf(owner: Pool, organizationId: string): Promise<Row[]> {
  return (
    await owner.query<Row>(
      `SELECT id, milestone, reissue, user_id, skipped, sent_at, failed_at, failure_code, dismissed_at, recorded_at
         FROM public.closure_notices WHERE organization_id = $1 ORDER BY due_at, reissue, milestone`,
      [organizationId]
    )
  ).rows;
}

/** The one notice of the store that is still owed (neither sent, failed, skipped nor dismissed). */
async function owedOf(owner: Pool, organizationId: string): Promise<Row> {
  const owed = (await rowsOf(owner, organizationId)).filter(
    (candidate) =>
      !(
        candidate.skipped ||
        candidate.sent_at ||
        candidate.failed_at ||
        candidate.dismissed_at
      )
  );
  assert.equal(owed.length, 1, "one notice is owed");
  const [only] = owed;
  assert.ok(only);
  return only;
}

async function emailOf(owner: Pool, userId: string): Promise<string> {
  const result = await owner.query<{ email: string }>(
    'SELECT email FROM public."user" WHERE id = $1',
    [userId]
  );
  const email = result.rows[0]?.email;
  assert.ok(email);
  return email;
}

async function waitOf(owner: Pool, organizationId: string) {
  const result = await owner.query<{ wait: string | null }>(
    `SELECT public.closed_organization_purge_wait(closure.organization_id, closure.requested_at) AS wait
       FROM public.organization_closures AS closure WHERE closure.organization_id = $1`,
    [organizationId]
  );
  return result.rows[0]?.wait ?? null;
}

async function auditOf(owner: Pool, organizationId: string) {
  return (
    await owner.query<{
      detail: string | null;
      entity_id: string;
      entity_type: string;
      event_type: string;
      support_case_id: string;
    }>(
      `SELECT event_type, entity_type, entity_id, detail, support_case_id FROM public.platform_audit_events
        WHERE organization_id = $1 AND event_type LIKE 'closure_notice.%' ORDER BY id`,
      [organizationId]
    )
  ).rows;
}

/** What the consumer of the queue does with the event of a notice (its envelope, as the dispatcher sends it). */
function deliverClosureNotice(
  dependencies: ClosureNoticeDependencies,
  noticeId: string,
  organizationId: string
) {
  return handleClosureNotice(dependencies, {
    attempt: 1,
    correlationId: randomUUID(),
    event: { noticeId },
    eventId: randomUUID(),
    idempotencyKey: outboxIdempotencyKey(
      "organization.closure_notice",
      noticeId
    ),
    organizationId,
    type: "organization.closure_notice",
    version: 1,
  });
}

async function refusedWith(
  operation: () => Promise<unknown>,
  code: string,
  label: string
) {
  await assert.rejects(
    operation,
    (error: unknown) =>
      error instanceof OrganizationPurgeRefusedError && error.code === code,
    label
  );
}

/** A privacy case of the organization, opened only (no decision yet). */
async function openedPrivacyCase(
  context: AutomaticPurgeContext,
  organizationId: string
): Promise<string> {
  const opened = await openPrivacyCase(context.admin, context.principal, {
    channel: "email",
    dueDays: 15,
    note: null,
    organizationId,
    reason: "Aviso do encerramento não chegou",
    receivedAt: null,
    requesterKind: "organization_owner",
    requestType: "other",
  });
  assert.ok(opened);
  return opened.id;
}

export async function verifyClosureNoticeEmail(
  context: ClosureNoticeEmailContext
): Promise<string[]> {
  await awayFromMidnight(context.owner);
  const restoreOthers = await setAsideOthers(context.owner);
  try {
    return await emailScenario(context);
  } finally {
    await restoreOthers();
  }
}

async function emailScenario(
  context: ClosureNoticeEmailContext
): Promise<string[]> {
  const { admin, maintenance, owner, principal, recipients } = context;
  const tests: string[] = [];
  const record = () => maintenance.recordClosureNotices(1000);
  // 84 local days ago: D minus 7 was yesterday, so the d7 is due and goes out (the request and D minus 30 skipped)
  const dueD7 = () => localDayStart(owner, ZONE, -84);
  const closed = async (label: string, requestedAt?: Date) =>
    closedWithDeliveredNotice(
      owner,
      `email ${label}`,
      requestedAt ?? (await dueD7()),
      { notice: false }
    );
  const email = (
    send: ClosureNoticeSender
  ): ClosureNoticeDependencies["email"] => ({
    config: CONFIG,
    recipients,
    send,
  });

  // the address comes from the function of the authentication role, only for a notice still owed and only verified
  const store = await closed("recipient");
  await record();
  const notice = await owedOf(owner, store.organizationId);
  assert.equal(notice.milestone, "d7");
  const address = await emailOf(owner, store.userId);
  assert.deepEqual(
    await recipients.recipient(notice.id, store.organizationId),
    { email: address, verified: true }
  );
  await owner.query(
    'UPDATE public."user" SET email_verified = false WHERE id = $1',
    [store.userId]
  );
  assert.deepEqual(
    await recipients.recipient(notice.id, store.organizationId),
    { verified: false },
    "an e-mail not verified is not answered"
  );
  const unverifiedAt = async () =>
    (
      await owner.query<{ unverified_at: Date | null }>(
        "SELECT unverified_at FROM public.closure_notices WHERE id = $1",
        [notice.id]
      )
    ).rows[0]?.unverified_at ?? null;
  assert.ok(
    await unverifiedAt(),
    "the function notes on the notice that the address was found not verified"
  );
  await owner.query(
    'UPDATE public."user" SET email_verified = true WHERE id = $1',
    [store.userId]
  );
  assert.deepEqual(
    await recipients.recipient(notice.id, store.organizationId),
    { email: address, verified: true }
  );
  assert.equal(
    await unverifiedAt(),
    null,
    "an address found verified later clears the note"
  );
  assert.equal(
    await recipients.recipient(notice.id, "org_not_this_one"),
    null,
    "another organization's ID finds nothing"
  );
  const skipped = (await rowsOf(owner, store.organizationId)).find(
    (row) => row.skipped
  );
  assert.ok(skipped);
  assert.equal(
    await recipients.recipient(skipped.id, store.organizationId),
    null,
    "a skipped notice answers no address"
  );
  // nobody else reaches it, and the authentication runtime reads no notice directly
  for (const role of [
    "polaris_privacy_runtime",
    "polaris_admin_runtime",
    "polaris_pr11_runtime",
    "polaris_outbox_runtime",
  ]) {
    await expectSqlState(
      () =>
        asRole(
          owner,
          role,
          "SELECT public.closure_notice_recipient($1::uuid, $2::text)",
          [notice.id, store.organizationId]
        ),
      "42501",
      `${role} cannot read an address`
    );
  }
  await expectSqlState(
    () =>
      asRole(
        owner,
        "polaris_auth_runtime",
        "SELECT id FROM public.closure_notices LIMIT 1"
      ),
    "42501",
    "the authentication runtime reads no notice directly"
  );
  const ownerColumns = await owner.query<{
    column_name: string;
    table_name: string;
  }>(
    `SELECT table_name, column_name FROM information_schema.column_privileges
      WHERE grantee = 'polaris_notice_recipient_owner' AND privilege_type = 'SELECT' AND table_schema = 'public'
      ORDER BY table_name, column_name`
  );
  assert.deepEqual(
    ownerColumns.rows.map((row) => `${row.table_name}.${row.column_name}`),
    [
      // the billing notices still owed, for billing_notice_recipient (0101, ADR 0104)
      "billing_notices.failed_at",
      "billing_notices.id",
      "billing_notices.kind",
      "billing_notices.organization_id",
      "billing_notices.sent_at",
      "billing_notices.skipped_reason",
      "billing_notices.user_id",
      "closure_notices.dismissed_at",
      "closure_notices.failed_at",
      "closure_notices.id",
      "closure_notices.organization_id",
      "closure_notices.sent_at",
      "closure_notices.skipped",
      "closure_notices.unverified_at",
      "closure_notices.user_id",
      // when a membership began: the oldest owner a billing notice goes to (0101, billing_notice_recipient)
      "memberships.created_at",
      "memberships.organization_id",
      "memberships.role",
      "memberships.status",
      "memberships.user_id",
      "user.email",
      "user.email_verified",
      "user.id",
    ],
    "the owner of the function reads three columns of the users (never the name), the notices and who is an owner"
  );
  const ownerWrites = await owner.query<{
    column_name: string;
    privilege_type: string;
    table_name: string;
  }>(
    `SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
      WHERE grantee = 'polaris_notice_recipient_owner' AND privilege_type <> 'SELECT' AND table_schema = 'public'
      ORDER BY table_name, column_name, privilege_type`
  );
  assert.deepEqual(
    ownerWrites.rows.map(
      (row) => `${row.table_name}.${row.column_name}:${row.privilege_type}`
    ),
    ["closure_notices.unverified_at:UPDATE"],
    "the owner of the function writes only the note of an address not verified"
  );
  const ownerAttributes = await owner.query<{
    rolbypassrls: boolean;
    rolcanlogin: boolean;
    rolinherit: boolean;
  }>(
    "SELECT rolcanlogin, rolinherit, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = 'polaris_notice_recipient_owner'"
  );
  assert.deepEqual(ownerAttributes.rows[0], {
    rolbypassrls: false,
    rolcanlogin: false,
    rolinherit: false,
  });
  tests.push(
    "the address of a closure notice is read only by closure_notice_recipient, executed by the authentication runtime alone: the e-mail of the notice's user, only while the notice is owed, by its ID and organization, and only when verified; its owner reads three columns of the users (never the name), and no other runtime reads an address"
  );

  // whether the owner's e-mail is verified now, for the dismissal: a boolean, of the same owner, for the act of the support only
  const unverifiedCheck = await owner.query<{
    config: string[] | null;
    owner_name: string;
    returns: string;
    security_definer: boolean;
  }>(
    `SELECT pg_catalog.pg_get_userbyid(proowner) AS owner_name, prosecdef AS security_definer, proconfig AS config,
            pg_catalog.format_type(prorettype, NULL) AS returns
       FROM pg_catalog.pg_proc WHERE oid = 'public.closure_notice_owner_unverified(uuid, text)'::regprocedure`
  );
  assert.deepEqual(unverifiedCheck.rows, [
    {
      config: ["search_path=pg_catalog, public, pg_temp"],
      owner_name: "polaris_notice_recipient_owner",
      returns: "boolean",
      security_definer: true,
    },
  ]);
  const unverifiedCallers = await owner.query<{ role: string }>(
    `SELECT role FROM pg_catalog.unnest($1::text[]) AS role
      WHERE pg_catalog.has_function_privilege(role, 'public.closure_notice_owner_unverified(uuid, text)', 'EXECUTE')
      ORDER BY role`,
    [
      [
        "polaris_admin_owner",
        "polaris_admin_runtime",
        "polaris_auth_runtime",
        "polaris_billing_runtime",
        "polaris_catalog_runtime",
        "polaris_outbox_runtime",
        "polaris_pr11_runtime",
        "polaris_privacy_owner",
        "polaris_privacy_runtime",
      ],
    ]
  );
  assert.deepEqual(
    unverifiedCallers.rows.map((row) => row.role),
    ["polaris_privacy_owner"],
    "only the owner of the act of the support asks whether the e-mail is verified now"
  );
  tests.push(
    "closure_notice_owner_unverified answers only a boolean (never the address), is a definer of the owner of the address with a fixed search_path, and only the owner of the act of the support executes it"
  );

  // the consumer sends it under the notice's ID, marks it sent, and nothing of the owner goes anywhere else
  const provider = fakeProvider();
  assert.equal(
    await deliverClosureNotice(
      { email: email(provider.send), notices: maintenance },
      notice.id,
      store.organizationId
    ),
    "sent"
  );
  assert.equal(provider.sent.length, 1);
  const [message] = provider.sent;
  assert.ok(message);
  assert.equal(message.idempotencyKey, notice.id);
  assert.equal(message.to, address);
  // every link of the message is the panel: the app's origin, with no path, query or token
  const links = [...message.html.matchAll(/href="([^"]*)"/g)].map(
    (match) => new URL(match[1] ?? "")
  );
  assert.ok(links.length > 0, "the message links to the panel");
  for (const link of links) {
    assert.equal(link.origin, new URL(CONFIG.appOrigin).origin);
    assert.equal(`${link.pathname}${link.search}${link.hash}`, "/");
  }
  assert.ok(!message.html.includes(address), "the address is not in the text");
  const delivered = (await rowsOf(owner, store.organizationId)).find(
    (row) => row.id === notice.id
  );
  assert.ok(delivered?.sent_at);
  assert.equal(
    await recipients.recipient(notice.id, store.organizationId),
    null,
    "a sent notice answers no address"
  );
  const events = await owner.query<{ event: Record<string, unknown> }>(
    "SELECT event FROM public.event_outbox WHERE organization_id = $1 AND type = 'organization.closure_notice'",
    [store.organizationId]
  );
  assert.deepEqual(
    events.rows.map((row) => row.event),
    [{ noticeId: notice.id }],
    "the event carries only the notice's ID"
  );
  // again (a duplicate of the queue): nothing is sent twice
  assert.equal(
    await deliverClosureNotice(
      { email: email(provider.send), notices: maintenance },
      notice.id,
      store.organizationId
    ),
    "not_due"
  );
  assert.equal(provider.sent.length, 1);

  // an e-mail not verified: left owed, not failed; a refusal of the provider: failed; a failure of it: still owed
  const unverified = await closed("unverified");
  await record();
  await owner.query(
    'UPDATE public."user" SET email_verified = false WHERE id = $1',
    [unverified.userId]
  );
  const unverifiedNotice = await owedOf(owner, unverified.organizationId);
  assert.equal(
    await deliverClosureNotice(
      { email: email(provider.send), notices: maintenance },
      unverifiedNotice.id,
      unverified.organizationId
    ),
    "not_verified"
  );
  assert.equal(provider.sent.length, 1);
  assert.equal(
    (await owedOf(owner, unverified.organizationId)).id,
    unverifiedNotice.id
  );

  const refused = await closed("refused");
  await record();
  const refusedNotice = await owedOf(owner, refused.organizationId);
  assert.equal(
    await deliverClosureNotice(
      {
        email: email(
          fakeProvider(() => ({ code: null, outcome: "rejected", status: 422 }))
            .send
        ),
        notices: maintenance,
      },
      refusedNotice.id,
      refused.organizationId
    ),
    "failed"
  );
  const refusedRow = (await rowsOf(owner, refused.organizationId)).find(
    (row) => row.id === refusedNotice.id
  );
  assert.equal(refusedRow?.failure_code, "email_rejected");

  const unavailable = await closed("unavailable");
  await record();
  const unavailableNotice = await owedOf(owner, unavailable.organizationId);
  await assert.rejects(
    deliverClosureNotice(
      {
        email: email(
          fakeProvider(() => ({ code: null, outcome: "retry", status: 503 }))
            .send
        ),
        notices: maintenance,
      },
      unavailableNotice.id,
      unavailable.organizationId
    ),
    ClosureNoticeRetryError
  );
  assert.equal(
    (await owedOf(owner, unavailable.organizationId)).id,
    unavailableNotice.id,
    "a failure of the provider leaves the notice owed for the next try"
  );

  // the notice goes only to a user who is still a member: one who left gets nothing
  const left = await closed("left");
  await record();
  const leftNotice = await owedOf(owner, left.organizationId);
  // a second owner stays: the support sends the notice again to the owner of now
  const second = `gate-${randomUUID()}`;
  await owner.query(
    'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
    [second, "Segunda dona", `${second}@example.invalid`]
  );
  await owner.query(
    "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
    [left.organizationId, second]
  );
  await owner.query(
    "DELETE FROM public.memberships WHERE organization_id = $1 AND user_id = $2",
    [left.organizationId, left.userId]
  );
  assert.equal(
    await recipients.recipient(leftNotice.id, left.organizationId),
    null,
    "no address of a user who is no longer an owner"
  );
  assert.equal(
    await deliverClosureNotice(
      { email: email(provider.send), notices: maintenance },
      leftNotice.id,
      left.organizationId
    ),
    "not_due"
  );
  assert.equal(provider.sent.length, 1);
  const leftCase = await openedPrivacyCase(context, left.organizationId);
  const toSecond = await reissueClosureNotice(
    admin,
    principal,
    leftCase,
    left.organizationId
  );
  assert.ok(toSecond);
  const leftRows = await rowsOf(owner, left.organizationId);
  assert.equal(
    leftRows.find((row) => row.id === leftNotice.id)?.skipped,
    true,
    "the notice owed to the one who left is settled skipped, never sent"
  );
  assert.equal(
    leftRows.find((row) => row.id === toSecond.noticeId)?.user_id,
    second
  );
  tests.push(
    "the consumer sends a notice under its own ID as the provider's key, marks it sent once (a duplicate sends nothing), leaves it owed when the e-mail is not verified or the provider fails, marks it failed when the provider refuses it, and never sends to (nor reads the address of) a user who is no longer an owner, whose owed notice the support replaces with one for the owner of now; the event carries only the notice's ID and the text no address"
  );

  // the handover: the latest notice owed of the cycle goes out, the earlier owed ones are settled skipped
  const backlog = await closed("handover");
  await record();
  const latest = await owedOf(owner, backlog.organizationId);
  // an earlier notice left owed while the e-mail was off, as the job would have written it
  await owner.query(
    `INSERT INTO public.closure_notices (organization_id, closure_requested_at, milestone, due_at, user_id, recorded_at)
     SELECT organization_id, requested_at, 'd30', requested_at + interval '60 days', requested_by_user_id, now() - interval '2 days'
       FROM public.organization_closures WHERE organization_id = $1
     ON CONFLICT ON CONSTRAINT closure_notices_cycle_milestone_unique
     DO UPDATE SET skipped = false, recorded_at = EXCLUDED.recorded_at`,
    [backlog.organizationId]
  );
  // the consumer still has its turn: nothing of this store is handed over in the first 15 minutes
  let owed = await maintenance.listOwedClosureNotices(100);
  assert.ok(
    !owed.some((row) => row.organizationId === backlog.organizationId),
    "a notice recorded in the last 15 minutes is left to its consumer"
  );
  const settledEarly = (await rowsOf(owner, backlog.organizationId)).find(
    (row) => row.milestone === "d30"
  );
  assert.equal(settledEarly?.skipped, true, "the earlier owed one is skipped");
  await owner.query(
    "UPDATE public.closure_notices SET recorded_at = now() - interval '20 minutes' WHERE id = $1",
    [latest.id]
  );
  owed = await maintenance.listOwedClosureNotices(100);
  assert.deepEqual(
    owed.filter((row) => row.organizationId === backlog.organizationId),
    [{ noticeId: latest.id, organizationId: backlog.organizationId }]
  );
  const handover = fakeProvider();
  const report = await handOverOwedClosureNotices({
    email: email(handover.send),
    notices: maintenance,
  });
  assert.ok(report.handedOver >= 1 && report.sent >= 1);
  assert.ok(
    handover.sent.some((sent) => sent.idempotencyKey === latest.id),
    "the latest owed notice goes out"
  );
  assert.ok(
    (await rowsOf(owner, backlog.organizationId)).find(
      (row) => row.id === latest.id
    )?.sent_at
  );
  assert.equal(
    (await maintenance.listOwedClosureNotices(100)).filter(
      (row) => row.organizationId === backlog.organizationId
    ).length,
    0,
    "nothing owed is left"
  );
  // with the e-mail off the handover does nothing
  assert.deepEqual(
    await handOverOwedClosureNotices({ email: null, notices: maintenance }),
    { failed: 0, handedOver: 0, notVerified: 0, retry: 0, sent: 0 }
  );
  await expectSqlState(
    () => maintenance.listOwedClosureNotices(0),
    "22023",
    "the handover takes a bounded batch"
  );
  for (const role of ["polaris_admin_runtime", "polaris_auth_runtime"]) {
    await expectSqlState(
      () =>
        asRole(
          owner,
          role,
          "SELECT * FROM public.list_owed_closure_notices(1)"
        ),
      "42501",
      `${role} cannot hand notices over`
    );
  }
  tests.push(
    "the handover (with the e-mail on) sends the latest notice owed of each cycle and settles the earlier owed ones skipped, leaves one recorded in the last 15 minutes to its consumer, takes a bounded batch, and only the privacy runtime runs it"
  );

  // the handover takes turns: 21 cycles that cannot go out now (an address not verified, requested earlier) and 3 owed
  // to a user who left never keep a notice that can go out out of a batch of 20
  const stuck: { noticeId: string; organizationId: string }[] = [];
  for (let index = 0; index < 21; index += 1) {
    const held = await closed(
      `stuck ${index}`,
      await localDayStart(owner, ZONE, -85)
    );
    await record();
    const stuckNotice = await owedOf(owner, held.organizationId);
    await owner.query(
      'UPDATE public."user" SET email_verified = false WHERE id = $1',
      [held.userId]
    );
    assert.deepEqual(
      await recipients.recipient(stuckNotice.id, held.organizationId),
      { verified: false }
    );
    stuck.push({
      noticeId: stuckNotice.id,
      organizationId: held.organizationId,
    });
  }
  const formerOwners: { noticeId: string; organizationId: string }[] = [];
  for (let index = 0; index < 3; index += 1) {
    const held = await closed(
      `former owner ${index}`,
      await localDayStart(owner, ZONE, -86)
    );
    await record();
    const goneNotice = await owedOf(owner, held.organizationId);
    await owner.query(
      "DELETE FROM public.memberships WHERE organization_id = $1 AND user_id = $2",
      [held.organizationId, held.userId]
    );
    formerOwners.push({
      noticeId: goneNotice.id,
      organizationId: held.organizationId,
    });
  }
  const sendable = await closed("sendable");
  await record();
  const sendableNotice = await owedOf(owner, sendable.organizationId);
  // the owner changed both ways: an earlier d30 still owed to the owner of now, the latest d7 to one who left
  const mixed = await closed("former owner latest");
  await record();
  const mixedLatest = await owedOf(owner, mixed.organizationId);
  const current = `gate-${randomUUID()}`;
  await owner.query(
    'INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
    [current, "Dona atual", `${current}@example.invalid`]
  );
  await owner.query(
    "INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
    [mixed.organizationId, current]
  );
  const mixedEarlier = (
    await owner.query<{ id: string }>(
      `INSERT INTO public.closure_notices (organization_id, closure_requested_at, milestone, due_at, user_id, recorded_at)
       SELECT organization_id, requested_at, 'd30', requested_at + interval '60 days', $2, now() - interval '2 days'
         FROM public.organization_closures WHERE organization_id = $1
       ON CONFLICT ON CONSTRAINT closure_notices_cycle_milestone_unique
       DO UPDATE SET skipped = false, user_id = EXCLUDED.user_id, recorded_at = EXCLUDED.recorded_at
       RETURNING id`,
      [mixed.organizationId, current]
    )
  ).rows[0]?.id;
  assert.ok(mixedEarlier);
  await owner.query(
    "DELETE FROM public.memberships WHERE organization_id = $1 AND user_id = $2",
    [mixed.organizationId, mixed.userId]
  );
  const turns = [
    ...stuck,
    ...formerOwners,
    { noticeId: sendableNotice.id, organizationId: sendable.organizationId },
    { noticeId: mixedLatest.id, organizationId: mixed.organizationId },
  ];
  await owner.query(
    "UPDATE public.closure_notices SET recorded_at = now() - interval '20 minutes' WHERE id = ANY($1::uuid[])",
    [turns.map((turn) => turn.noticeId)]
  );
  owed = await maintenance.listOwedClosureNotices(20);
  assert.ok(
    owed.some((row) => row.noticeId === sendableNotice.id),
    "the notice that can go out is in the batch, ahead of the ones found not verified"
  );
  assert.ok(
    !owed.some((row) =>
      formerOwners.some((turn) => turn.noticeId === row.noticeId)
    ),
    "a notice owed to a user who left is never taken"
  );
  // a cycle with an earlier notice owed to the owner of now is taken once: that one is settled, the latest handed over
  assert.ok(owed.some((row) => row.noticeId === mixedLatest.id));
  assert.equal(
    (await rowsOf(owner, mixed.organizationId)).find(
      (row) => row.id === mixedEarlier
    )?.skipped,
    true,
    "the earlier notice owed to the owner of now is settled, so the support can send the d7 again"
  );
  assert.ok(
    !(await maintenance.listOwedClosureNotices(20)).some(
      (row) => row.organizationId === mixed.organizationId
    ),
    "then nothing of it is owed to an owner, and it is not taken again"
  );
  // the delivery finds them not verified again: they go to the end, and the ones left out come in
  const leftOut = stuck.filter(
    (turn) => !owed.some((row) => row.noticeId === turn.noticeId)
  );
  assert.ok(
    leftOut.length >= 2,
    "21 stuck do not fit in a batch of 20 with the others"
  );
  for (const row of owed) {
    if (stuck.some((turn) => turn.noticeId === row.noticeId)) {
      await recipients.recipient(row.noticeId, row.organizationId);
    }
  }
  const nextBatch = await maintenance.listOwedClosureNotices(20);
  for (const turn of leftOut) {
    assert.ok(
      nextBatch.some((row) => row.noticeId === turn.noticeId),
      "the batch takes turns: the cycle left out is taken next"
    );
  }
  // they are settled, so they leave the rest of the scenario alone
  await owner.query(
    "UPDATE public.closure_notices SET skipped = true WHERE id = ANY($1::uuid[])",
    [turns.map((turn) => turn.noticeId)]
  );
  tests.push(
    "the handover never takes a cycle with nothing owed to a user who is still an owner (one with an earlier notice owed to the owner of now is taken once, so that one is settled), and takes the cycles by when a delivery last found the address not verified (never first): 21 notices that cannot go out now never keep the one that can out of a batch of 20, and the batch takes turns"
  );

  // the act of the support: a new d7 of the cycle sent again, under a privacy case, with the audit; never an UPDATE
  const resend = await closed("reissue");
  await record();
  const firstD7 = await owedOf(owner, resend.organizationId);
  const plainCase = await supportCaseOf(context, resend.organizationId);
  await refusedWith(
    () =>
      reissueClosureNotice(admin, principal, plainCase, resend.organizationId),
    "privacy_case_required",
    "a plain support case does not send a notice again"
  );
  const privacyCase = await openedPrivacyCase(context, resend.organizationId);
  await refusedWith(
    () => reissueClosureNotice(admin, principal, privacyCase, "org_other"),
    "organization_mismatch",
    "the operator names the case's organization"
  );
  await refusedWith(
    () =>
      reissueClosureNotice(
        admin,
        principal,
        privacyCase,
        resend.organizationId
      ),
    "closure_notice_pending",
    "a notice still owed goes out first"
  );
  assert.ok(
    await maintenance.markClosureNoticeFailed(
      firstD7.id,
      resend.organizationId,
      "email_rejected"
    )
  );
  const reissued = await reissueClosureNotice(
    admin,
    principal,
    privacyCase,
    resend.organizationId
  );
  assert.ok(reissued);
  assert.equal(reissued.reissue, 1);
  assert.equal(reissued.dismissed, false);
  const reissuedRow = (await rowsOf(owner, resend.organizationId)).find(
    (row) => row.id === reissued.noticeId
  );
  assert.equal(reissuedRow?.milestone, "d7");
  assert.equal(reissuedRow?.user_id, resend.userId);
  assert.equal(
    (await rowsOf(owner, resend.organizationId)).find(
      (row) => row.id === firstD7.id
    )?.failure_code,
    "email_rejected",
    "the failed notice stays as it was"
  );
  const reissuedEvent = await owner.query<{ idempotency_key: string }>(
    "SELECT idempotency_key FROM public.event_outbox WHERE organization_id = $1 AND event ->> 'noticeId' = $2",
    [resend.organizationId, reissued.noticeId]
  );
  assert.deepEqual(
    reissuedEvent.rows.map((row) => row.idempotency_key),
    [`organization.closure_notice:${reissued.noticeId}`]
  );
  const claimed = await maintenance.claimClosureNoticeDelivery(
    reissued.noticeId,
    resend.organizationId
  );
  assert.equal(claimed?.reissue, 1);
  assert.equal(claimed?.milestone, "d7");
  assert.deepEqual(await auditOf(owner, resend.organizationId), [
    {
      detail: null,
      entity_id: reissued.noticeId,
      entity_type: "closure_notice",
      event_type: "closure_notice.reissued",
      support_case_id: privacyCase,
    },
  ]);
  await refusedWith(
    () =>
      reissueClosureNotice(
        admin,
        principal,
        privacyCase,
        resend.organizationId
      ),
    "closure_notice_pending",
    "the notice sent again is owed until it goes out"
  );
  // a skipped d7 (several milestones due at once) is sent again the same way
  const skippedD7 = await closed(
    "skipped d7",
    await localDayStart(owner, ZONE, -91)
  );
  await record();
  const skippedRows = await rowsOf(owner, skippedD7.organizationId);
  assert.equal(
    skippedRows.find((row) => row.milestone === "d7")?.skipped,
    true
  );
  const deletionDay = await owedOf(owner, skippedD7.organizationId);
  assert.equal(deletionDay.milestone, "deletion_day");
  assert.ok(
    await maintenance.markClosureNoticeSent(
      deletionDay.id,
      skippedD7.organizationId
    )
  );
  assert.equal(
    await waitOf(owner, skippedD7.organizationId),
    "closure_notice_not_delivered",
    "the notice of D is not the one that lets the store be deleted"
  );
  const skippedCase = await openedPrivacyCase(
    context,
    skippedD7.organizationId
  );
  const resent = await reissueClosureNotice(
    admin,
    principal,
    skippedCase,
    skippedD7.organizationId
  );
  assert.equal(resent?.reissue, 1);
  // not before the d7 of the cycle is due, and only for a store in closure
  const early = await closed("not due", await localDayStart(owner, ZONE, -70));
  const earlyCase = await openedPrivacyCase(context, early.organizationId);
  await refusedWith(
    () =>
      reissueClosureNotice(admin, principal, earlyCase, early.organizationId),
    "closure_notice_not_due",
    "nothing to send again before D minus 7"
  );
  await owner
    .query(
      "UPDATE public.organization_closures SET recovered_at = now(), closed_at = NULL WHERE organization_id = $1",
      [early.organizationId]
    )
    .catch(() => undefined);
  await owner.query(
    "UPDATE public.organizations SET status = 'active' WHERE id = $1",
    [early.organizationId]
  );
  await refusedWith(
    () =>
      reissueClosureNotice(admin, principal, earlyCase, early.organizationId),
    "organization_not_in_closure",
    "a store not in closure has no notice to send"
  );
  tests.push(
    "the support sends the d7 again (one failed, or skipped behind the notice of D) as a new d7 of the same cycle with its outbox event and the audit closure_notice.reissued, never changing the old one, only under a privacy case naming its organization, once the d7 is due, for a store in closure, and not while another notice is owed"
  );

  // the dismissal: by the decision of the person responsible, it counts as delivered 7 days later
  const gone = await closed("account deleted");
  await record();
  const goneCase = await openedPrivacyCase(context, gone.organizationId);
  await refusedWith(
    () =>
      dismissClosureNotice(
        admin,
        principal,
        goneCase,
        gone.organizationId,
        "owner_account_deleted"
      ),
    "privacy_case_not_deletion",
    "a dismissal needs a case of deletion, not any privacy case"
  );
  const undecided = (
    await openPrivacyCase(admin, principal, {
      channel: "email",
      dueDays: 15,
      note: null,
      organizationId: gone.organizationId,
      reason: "Pedido de exclusão da conta",
      receivedAt: null,
      requesterKind: "organization_owner",
      requestType: "deletion",
    })
  )?.id;
  assert.ok(undecided);
  await refusedWith(
    () =>
      dismissClosureNotice(
        admin,
        principal,
        undecided,
        gone.organizationId,
        "owner_account_deleted"
      ),
    "privacy_case_not_accepted",
    "a dismissal needs the decision of the case, accepted"
  );
  const decided = await acceptedDeletionCase(context, gone.organizationId);
  await refusedWith(
    () =>
      dismissClosureNotice(
        admin,
        principal,
        decided,
        gone.organizationId,
        "owner_account_deleted"
      ),
    "closure_notice_owner_present",
    "the reason must fit the facts: the owner is still there"
  );
  await assert.rejects(
    dismissClosureNotice(
      admin,
      principal,
      decided,
      gone.organizationId,
      "o dono pediu" as never
    ),
    InvalidSupportRequestError,
    "a reason outside the list is refused"
  );
  // the owner's account is gone (the membership first, then the account): its notices leave with it
  await owner.query(
    "DELETE FROM public.memberships WHERE organization_id = $1 AND user_id = $2",
    [gone.organizationId, gone.userId]
  );
  await owner.query('DELETE FROM public."user" WHERE id = $1', [gone.userId]);
  assert.deepEqual(await rowsOf(owner, gone.organizationId), []);
  assert.equal(
    await waitOf(owner, gone.organizationId),
    "closure_notice_not_delivered"
  );
  await refusedWith(
    () => reissueClosureNotice(admin, principal, decided, gone.organizationId),
    "closure_notice_no_owner",
    "nobody to send it to"
  );
  const dismissed = await dismissClosureNotice(
    admin,
    principal,
    decided,
    gone.organizationId,
    "owner_account_deleted"
  );
  assert.ok(dismissed);
  assert.equal(dismissed.dismissed, true);
  const [dismissedRow] = await rowsOf(owner, gone.organizationId);
  assert.equal(dismissedRow?.milestone, "d7");
  assert.equal(dismissedRow?.user_id, null);
  assert.ok(dismissedRow?.dismissed_at);
  assert.equal(dismissedRow?.sent_at, null);
  assert.deepEqual(await auditOf(owner, gone.organizationId), [
    {
      detail: "owner_account_deleted",
      entity_id: dismissed.noticeId,
      entity_type: "closure_notice",
      event_type: "closure_notice.dismissed",
      support_case_id: decided,
    },
  ]);
  const dismissedEvents = await owner.query(
    "SELECT 1 FROM public.event_outbox WHERE organization_id = $1 AND event ->> 'noticeId' = $2",
    [gone.organizationId, dismissed.noticeId]
  );
  assert.equal(dismissedEvents.rowCount, 0, "a dismissed notice has no event");
  assert.equal(
    await maintenance.claimClosureNoticeDelivery(
      dismissed.noticeId,
      gone.organizationId
    ),
    null,
    "a dismissed notice is not to go out"
  );
  assert.equal(
    await waitOf(owner, gone.organizationId),
    "closure_notice_not_delivered",
    "a dismissal lets the store go only 7 days later"
  );
  await owner.query(
    "UPDATE public.closure_notices SET dismissed_at = now() - interval '169 hours', due_at = now() - interval '169 hours' WHERE id = $1",
    [dismissed.noticeId]
  );
  assert.equal(
    await waitOf(owner, gone.organizationId),
    null,
    "7 days after the dismissal the store may be deleted"
  );
  await refusedWith(
    () =>
      dismissClosureNotice(
        admin,
        principal,
        decided,
        gone.organizationId,
        "owner_account_deleted"
      ),
    "closure_notice_delivered",
    "a notice already dismissed is not dismissed again"
  );
  await refusedWith(
    () => reissueClosureNotice(admin, principal, decided, gone.organizationId),
    "closure_notice_delivered",
    "nor sent again after the dismissal"
  );
  const deliveredCase = await openedPrivacyCase(context, store.organizationId);
  await refusedWith(
    () =>
      reissueClosureNotice(
        admin,
        principal,
        deliveredCase,
        store.organizationId
      ),
    "closure_notice_delivered",
    "a d7 delivered is not sent again (it would only push the deletion)"
  );
  // a refused address: the person responsible dismisses it with the reason that fits
  const refusedCase = await acceptedDeletionCase(
    context,
    refused.organizationId
  );
  const undeliverable = await dismissClosureNotice(
    admin,
    principal,
    refusedCase,
    refused.organizationId,
    "email_undeliverable"
  );
  assert.equal(undeliverable?.dismissed, true);
  // a dismissal settles the notices still owed of the cycle (an e-mail never verified), and they leave the alert
  const neverVerified = await closed("never verified");
  await record();
  const neverVerifiedNotice = await owedOf(owner, neverVerified.organizationId);
  const neverVerifiedCase = await acceptedDeletionCase(
    context,
    neverVerified.organizationId
  );
  await owner.query(
    "UPDATE public.closure_notices SET due_at = due_at - interval '4 days' WHERE id = $1",
    [neverVerifiedNotice.id]
  );
  await refusedWith(
    () =>
      dismissClosureNotice(
        admin,
        principal,
        neverVerifiedCase,
        neverVerified.organizationId,
        "email_not_verified"
      ),
    "closure_notice_not_unverified",
    "a notice owed past the alert is not proof of an e-mail not verified (the e-mail may be off): nobody tried yet"
  );
  await refusedWith(
    () =>
      dismissClosureNotice(
        admin,
        principal,
        neverVerifiedCase,
        neverVerified.organizationId,
        "email_undeliverable"
      ),
    "closure_notice_not_refused",
    "no address was refused here"
  );
  // the consumer tries, and the function of the address finds it not verified: the fact the dismissal needs
  await owner.query(
    'UPDATE public."user" SET email_verified = false WHERE id = $1',
    [neverVerified.userId]
  );
  assert.deepEqual(
    await recipients.recipient(
      neverVerifiedNotice.id,
      neverVerified.organizationId
    ),
    { verified: false }
  );
  const subjectCase = await acceptedDeletionCase(
    context,
    neverVerified.organizationId,
    "data_subject"
  );
  await refusedWith(
    () =>
      dismissClosureNotice(
        admin,
        principal,
        subjectCase,
        neverVerified.organizationId,
        "email_not_verified"
      ),
    "privacy_requester_not_owner",
    "a data subject's deletion never silences the notice of an owner"
  );
  // the owner verifies the e-mail after the delivery found it not verified: the dismissal reads the present, and refuses
  await owner.query(
    'UPDATE public."user" SET email_verified = true WHERE id = $1',
    [neverVerified.userId]
  );
  await refusedWith(
    () =>
      dismissClosureNotice(
        admin,
        principal,
        neverVerifiedCase,
        neverVerified.organizationId,
        "email_not_verified"
      ),
    "closure_notice_owner_verified",
    "an e-mail verified after unverified_at is not dismissed: the notice is sent again"
  );
  assert.ok(
    (await rowsOf(owner, neverVerified.organizationId)).every(
      (row) => row.dismissed_at === null
    ),
    "a refused dismissal writes nothing"
  );
  await owner.query(
    'UPDATE public."user" SET email_verified = false WHERE id = $1',
    [neverVerified.userId]
  );
  const overdueBefore = (await record()).overdue;
  await dismissClosureNotice(
    admin,
    principal,
    neverVerifiedCase,
    neverVerified.organizationId,
    "email_not_verified"
  );
  assert.equal(
    (await rowsOf(owner, neverVerified.organizationId)).find(
      (row) => row.id === neverVerifiedNotice.id
    )?.skipped,
    true
  );
  assert.equal((await record()).overdue, overdueBefore - 1);
  // nothing but the Admin's functions writes these rows
  for (const role of [
    "polaris_admin_runtime",
    "polaris_privacy_runtime",
    "polaris_auth_runtime",
  ]) {
    await expectSqlState(
      () =>
        asRole(
          owner,
          role,
          "SELECT public.closure_notice_support_reissue($1, NULL)",
          [gone.organizationId]
        ),
      "42501",
      `${role} cannot write a notice of the support directly`
    );
  }
  for (const role of ["polaris_privacy_runtime", "polaris_auth_runtime"]) {
    await expectSqlState(
      () =>
        asRole(
          owner,
          role,
          "SELECT public.admin_reissue_closure_notice($1::uuid, $2::uuid, $3)",
          [principal, decided, gone.organizationId]
        ),
      "42501",
      `${role} cannot run the act of the support`
    );
  }
  tests.push(
    "the person responsible dismisses the d7 (an account gone with its notices, an address refused, an e-mail the consumer found not verified) only under a privacy case of deletion asked by the owner (a data subject's only with no owner left) and accepted, with a reason of the list that fits the facts (no owner left; a d7 refused for an owner; a d7 owed to an owner whose address the function of the address found not verified, and still not verified now): a new d7 with no user and no event, audited as closure_notice.dismissed with the reason, that settles the notices still owed, leaves the alert, and lets the store be deleted only 7 days later; a second dismissal, or a reissue after a delivery or a dismissal, is refused, and only the Admin's functions write it"
  );
  return tests;
}
