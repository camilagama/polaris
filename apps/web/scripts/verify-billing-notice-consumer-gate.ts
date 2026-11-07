// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { BillingProviderPort } from "@polaris/billing/provider-port";
import {
  type BillingNoticeRecipientClient,
  createBillingNoticeRecipientClient,
} from "@polaris/db/billing-notice-recipient";
import {
  type BillingStore,
  createBillingStore,
} from "@polaris/db/billing-store";
import { createDatabase } from "@polaris/db/client";
import type { BillingFact } from "@polaris/domain/billing/facts";
import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import type { QueueEnvelope } from "@polaris/domain/events/queue-envelope";
import { localDate } from "@polaris/domain/organization/closure-deadlines";
import {
  createTenantFixture,
  disposableHostPattern,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  type TenantFixture,
  temporaryRuntimeUrl,
} from "../../../packages/db/scripts/sales-gate-support";
import {
  type BillingNoticeDependencies,
  billingNoticeDependenciesOf,
  handleBillingNotice,
  handOverOwedBillingNotices,
} from "../src/server/billing/notice-consumer";
import {
  OwnerCommandProviderFailure,
  OwnerCommandRefusal,
  ownerRequestRefund,
} from "../src/server/billing/owner-commands";
import type {
  ClosureNoticeSender,
  ClosureNoticeSendResult,
} from "../src/server/privacy/closure-notice-email";
import { DeferredHandlerError } from "../src/server/queue/consumer";

/**
 * The consumer of `billing.notice` and the recording of the notices (ADR 0104, decision 7; PR G of the Assinatura design v2,
 * §9) on a real PostgreSQL 18, with the real billing store (billing role), the real `billing_notice_recipient` client
 * (authentication role), the real wiring of the Worker (`billingNoticeDependenciesOf`) and a fake provider of e-mail:
 *   1. an applied fact records its notice and the outbox event in the same transaction, a redelivery records nothing,
 *      and the consumer sends it once, to the owner, under the notice's ID;
 *   2. the hourly sweep records the eve of the first charge once however often it runs (ON CONFLICT DO NOTHING), and
 *      the consumer skips it when the E-A went out less than 24 hours before;
 *   3. the order of the arguments: the store's facts and the address through the real clients, and the functions
 *      called with the arguments swapped answer null;
 *   4. after the purge: a notice of a purged store is skipped `no_recipient`, and once the purge took the notices, its
 *      event finds nothing to do; neither throws (no retry, no dead letter, no incident);
 *   5. cases 3 and 4 of item 5: the owner's refund request repeated with the same request ID records nothing new, and
 *      another request ID records no second `subscription_cancelled` and no second E7; the E7 waits 24 hours, and the
 *      hourly handover (the real `listOwed`) settles it `refunded` once the refund came in;
 *   6. the delivery window counts from the first attempt: a notice never tried goes out at any age, one first
 *      tried more than 23 hours ago is skipped `delivery_window_passed`, the attempt stays written when the send
 *      throws, and the real `listOwed` puts a notice that threw behind the ones never tried, so the next one goes in
 *      the same batch, and among the ones already tried the one tried longest ago (`last_attempted_at`) goes first.
 * The fixtures stay, as in the other gates; the logins are dropped at the end.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const handoverIncomplete = /billing_notice_handover_incomplete/;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Zones on every side of the day: the gate takes one whose local hour is inside the sweep's 08:00 to 20:00. */
const ZONES = [
  "America/Sao_Paulo",
  "Asia/Tokyo",
  "Europe/Lisbon",
  "America/Los_Angeles",
  "Pacific/Auckland",
  "Asia/Kolkata",
];

interface Sent {
  html: string;
  idempotencyKey: string;
  subject: string;
  text: string;
  to: string;
}

interface NoticeRow {
  dedupe_key: string;
  due_at: Date;
  failed_at: Date | null;
  first_attempted_at: Date | null;
  id: string;
  last_attempted_at: Date | null;
  kind: string;
  recorded_at: Date;
  sent_at: Date | null;
  skipped_reason: string | null;
}

interface OutboxRow {
  event: { noticeId?: unknown };
  id: string;
  idempotency_key: string;
  status: string;
}

function localHour(instant: Date, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone,
    })
      .formatToParts(instant)
      .find((part) => part.type === "hour")?.value
  );
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);
}

/** A provider of payments that cancels and refunds on request; nothing leaves the process. */
function fakePaymentProvider(): { calls: string[]; port: BillingProviderPort } {
  const calls: string[] = [];
  const port = {
    cancelRenewal: () => {
      calls.push("cancelRenewal");
      return Promise.resolve("cancelled");
    },
    discardCheckout: () => Promise.resolve("discarded"),
    hasSubscription: () => Promise.resolve(true),
    overduePaymentPage: () => Promise.resolve(null),
    prepareSubscription: () => Promise.reject(new Error("not in this gate")),
    provider: "asaas",
    readState: () => Promise.resolve([]),
    refundCurrentPeriod: () => {
      calls.push("refundCurrentPeriod");
      return Promise.resolve("refund_requested");
    },
    refundsEnabled: true,
  } as BillingProviderPort;
  return { calls, port };
}

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const owner = createDatabase(adminUrl, { maxConnections: 4 });
  const logins: [string, string][] = [];
  const tests: string[] = [];
  const closers: (() => Promise<unknown>)[] = [];

  try {
    const server = await owner.pool.query<{
      database_name: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version_num') AS server_version_num"
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
      "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    const login = async (group: string, prefix: string) => {
      const role = `${prefix}_${randomUUID().replaceAll("-", "")}`;
      const password = randomBytes(24).toString("hex");
      await owner.pool.query(
        `CREATE ROLE "${role}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
      );
      await owner.pool.query(`GRANT "${group}" TO "${role}"`);
      logins.push([role, group]);
      return temporaryRuntimeUrl(adminUrl, role, password);
    };
    const billingUrl = await login(
      "polaris_billing_runtime",
      "polaris_notice_gate_billing"
    );
    const authUrl = await login(
      "polaris_auth_runtime",
      "polaris_notice_gate_auth"
    );
    const billing: BillingStore = createBillingStore(billingUrl);
    closers.push(() => billing.close());
    const recipients: BillingNoticeRecipientClient =
      createBillingNoticeRecipientClient(authUrl);
    closers.push(() => recipients.close());
    // raw logins of the same roles, for the calls with the arguments swapped
    const billingPool = createDatabase(billingUrl, { maxConnections: 1 }).pool;
    closers.push(() => billingPool.end());
    const authPool = createDatabase(authUrl, { maxConnections: 1 }).pool;
    closers.push(() => authPool.end());

    const dbNow = async () => await billing.databaseNow();
    const clock = await dbNow();
    const zone = ZONES.find((candidate) => {
      const hour = localHour(clock, candidate);
      return hour >= 9 && hour <= 18;
    });
    assert.ok(zone, "a zone whose local hour is inside the sweep's");
    const today = localDate(clock, zone);

    const sent: Sent[] = [];
    const send: ClosureNoticeSender = (message: Sent) => {
      sent.push(message);
      return Promise.resolve<ClosureNoticeSendResult>({ outcome: "sent" });
    };
    // the Worker's own wiring, with the billing e-mails on and the gate's clients and provider
    const bindings = {
      AUTH_EMAIL_FROM: "Polaris <avisos@example.invalid>",
      AUTH_HYPERDRIVE: { connectionString: authUrl },
      BETTER_AUTH_BASE_URL: "https://app.example.invalid",
      BILLING_SELF_SERVICE_ENABLED: "true",
      BILLING_SUPPORT_EMAIL: "suporte@example.invalid",
      RESEND_API_KEY: "re_gate_not_a_key",
      WELCOME_EMAIL_ENABLED: "false",
    };
    let opened = 0;
    const wired = billingNoticeDependenciesOf(bindings, billing, () => {
      opened += 1;
      return recipients;
    });
    assert.equal(
      opened,
      1,
      "the authentication role is opened with the e-mail on"
    );
    const dependencies = (now: Date): BillingNoticeDependencies => ({
      ...wired.dependencies,
      now: () => now,
      send,
    });

    const suffix = randomUUID().slice(0, 8);
    const ref = (name: string) =>
      `${name}-${suffix}-${randomUUID().slice(0, 8)}`;
    const newTenant = (label: string) =>
      createTenantFixture(
        owner.pool,
        `notice consumer ${label} ${suffix}`,
        zone,
        "free"
      );
    const emailOf = async (tenant: TenantFixture) =>
      String(
        (
          await owner.pool.query<{ email: string }>(
            'SELECT email FROM public."user" WHERE id = $1',
            [tenant.userId]
          )
        ).rows[0]?.email
      );
    const notices = async (tenant: TenantFixture) =>
      (
        await owner.pool.query<NoticeRow>(
          `SELECT id::text AS id, kind, dedupe_key, due_at, recorded_at, sent_at, failed_at, skipped_reason, first_attempted_at, last_attempted_at
             FROM public.billing_notices WHERE organization_id = $1 ORDER BY recorded_at, id`,
          [tenant.organizationId]
        )
      ).rows;
    const noticeOf = async (tenant: TenantFixture, kind: string) => {
      const found = (await notices(tenant)).filter((row) => row.kind === kind);
      assert.equal(found.length, 1, `one ${kind}`);
      return found[0] as NoticeRow;
    };
    const events = async (tenant: TenantFixture) =>
      (
        await owner.pool.query<OutboxRow>(
          `SELECT id::text AS id, idempotency_key, event, status FROM public.event_outbox
            WHERE organization_id = $1 AND type = 'billing.notice' ORDER BY created_at, id`,
          [tenant.organizationId]
        )
      ).rows;
    const envelopeOf = async (
      tenant: TenantFixture,
      noticeId: string
    ): Promise<QueueEnvelope> => {
      const event = (await events(tenant)).find(
        (row) => row.event.noticeId === noticeId
      );
      assert.ok(event, "the notice has its outbox event");
      return {
        attempt: 1,
        correlationId: "gate",
        event: event.event as QueueEnvelope["event"],
        eventId: event.id,
        idempotencyKey: event.idempotency_key,
        organizationId: tenant.organizationId,
        type: "billing.notice",
        version: 1,
      };
    };
    /** A fact through the real inbox, as a webhook would bring it. */
    const apply = async (
      tenant: TenantFixture,
      providerRef: string,
      fact: BillingFact,
      providerEventId = `gate-${randomUUID()}`
    ) => {
      const stored = await billing.recordEvent({
        fact,
        organizationId: tenant.organizationId,
        provider: "asaas",
        providerEventId,
        providerRef,
      });
      return await billing.processEvent(stored.id, await dbNow());
    };

    // ------------------------------------------------ 1. the fact records its notice; the consumer sends it once
    const trial = await newTenant("trial");
    const trialRef = ref("chk");
    await billing.startTrial(trial.organizationId, trial.userId, await dbNow());
    await billing.attachProvider(trial.organizationId, "asaas", trialRef, {
      firstChargeOn: addDays(today, 7),
      priceAmount: "24.90",
      priceId: "pro-1",
    });
    const readyEventId = `gate-ready-${randomUUID()}`;
    const ready = await apply(
      trial,
      trialRef,
      { cycleMonths: 1, occurredAt: await dbNow(), type: "trial_method_ready" },
      readyEventId
    );
    assert.equal(ready.status, "applied");
    const started = await noticeOf(trial, "trial_started");
    assert.equal(started.dedupe_key, trialRef, "E-A: one per subscription");
    const outbox = await events(trial);
    assert.equal(outbox.length, 1);
    assert.equal(
      outbox[0]?.idempotency_key,
      outboxIdempotencyKey("billing.notice", started.id)
    );
    assert.equal(outbox[0]?.status, "pending");
    // the webhook again: the same row of the ledger, nothing new
    const again = await apply(
      trial,
      trialRef,
      { cycleMonths: 1, occurredAt: await dbNow(), type: "trial_method_ready" },
      readyEventId
    );
    assert.equal(again.status, "applied");
    assert.equal((await notices(trial)).length, 1);
    assert.equal((await events(trial)).length, 1);
    const startedEnvelope = await envelopeOf(trial, started.id);
    assert.equal(
      await handleBillingNotice(dependencies(await dbNow()), startedEnvelope),
      "sent"
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.to, await emailOf(trial), "the owner, never a payer");
    assert.equal(sent[0]?.idempotencyKey, started.id);
    assert.equal(sent[0]?.subject, "Seu teste do Polaris Pro começou");
    assert.ok(sent[0]?.text.includes("R$ 24,90"));
    assert.ok(sent[0]?.text.includes("suporte@example.invalid"));
    assert.ok((await noticeOf(trial, "trial_started")).sent_at);
    assert.equal(
      await handleBillingNotice(dependencies(await dbNow()), startedEnvelope),
      "not_due",
      "a redelivery finds the notice sent"
    );
    assert.equal(sent.length, 1);
    tests.push(
      "an applied fact records its notice (E-A, keyed by the subscription) and its outbox event billing.notice:<id> in the same transaction, a redelivered fact records nothing, and the consumer, wired as the Worker wires it, sends the e-mail once to the owner's verified address under the notice's ID and marks it sent; a second delivery finds nothing to do"
    );

    // ------------------------------------------------ 2. the sweep records once; E-B skipped right after E-A
    await owner.pool.query(
      "UPDATE public.organization_billing SET first_charge_on = $2::date WHERE organization_id = $1",
      [trial.organizationId, addDays(today, 1)]
    );
    const sweepAt = await dbNow();
    const firstSweep = await billing.sweepDue(sweepAt);
    assert.ok(firstSweep.noticesRecorded >= 1);
    await billing.sweepDue(sweepAt);
    await billing.sweepDue(new Date(sweepAt.getTime() + MINUTE));
    const eve = await noticeOf(trial, "trial_charge_eve");
    assert.equal(eve.dedupe_key, trialRef);
    assert.equal(
      (await events(trial)).length,
      2,
      "one event per notice, however often the sweep runs"
    );
    assert.equal(
      await handleBillingNotice(
        dependencies(await dbNow()),
        await envelopeOf(trial, eve.id)
      ),
      "skipped"
    );
    assert.equal(
      (await noticeOf(trial, "trial_charge_eve")).skipped_reason,
      "trial_started_recently"
    );
    assert.equal(sent.length, 1);
    tests.push(
      "the hourly sweep (sweepDue) records the eve of the first charge in the store's zone and local hours, once however often it runs (ON CONFLICT DO NOTHING, one outbox event), and the consumer skips it as trial_started_recently with the E-A sent less than 24 hours before"
    );

    // ------------------------------------------------ 3. the order of the arguments, through the real clients
    const paid = await newTenant("paid");
    const paidRef = ref("chk");
    const firstChargeAt = new Date((await dbNow()).getTime() - DAY);
    await billing.attachProvider(paid.organizationId, "asaas", paidRef, {
      firstChargeOn: localDate(firstChargeAt, zone),
      priceAmount: "24.90",
      priceId: "pro-1",
    });
    const periodEndsAt = new Date(firstChargeAt.getTime() + 30 * DAY);
    const charged = await apply(paid, paidRef, {
      amount: { currency: "BRL", value: "24.90" },
      cycleMonths: 1,
      occurredAt: firstChargeAt,
      periodEndsAt,
      type: "charge_succeeded",
    });
    assert.equal(charged.status, "applied");
    const receipt = await noticeOf(paid, "charge_receipt");
    assert.equal(receipt.dedupe_key, charged.eventId, "E4: keyed by the event");
    assert.ok(
      receipt.due_at.getTime() - receipt.recorded_at.getTime() >=
        10 * MINUTE - 1000,
      "E4 waits 10 minutes"
    );
    const facts = await billing.readNoticeStore(
      receipt.id,
      paid.organizationId
    );
    assert.ok(facts, "the store of a notice owed, by the real client");
    assert.equal(facts.timeZone, zone, "timezone is read as timeZone");
    assert.equal(facts.closed, false);
    assert.equal(facts.ownerActive, true);
    assert.equal(facts.variants, 0);
    assert.ok(facts.variantLimit > 0);
    const storeName = (
      await owner.pool.query<{ name: string }>(
        "SELECT name FROM public.organizations WHERE id = $1",
        [paid.organizationId]
      )
    ).rows[0]?.name;
    assert.equal(facts.name, storeName, "the store's own name");
    assert.equal(
      await billing.readNoticeStore(receipt.id, trial.organizationId),
      null,
      "another store's notice"
    );
    const swappedStore = await billingPool.query<{ facts: unknown }>(
      "SELECT public.billing_notice_store($1, $2::uuid) AS facts",
      [receipt.id, paid.organizationId]
    );
    assert.equal(swappedStore.rows[0]?.facts, null, "swapped: null");
    assert.deepEqual(
      await recipients.recipient(receipt.id, paid.organizationId),
      { email: await emailOf(paid), verified: true },
      "the owner's address, by the real client"
    );
    const swappedRecipient = await authPool.query<{ recipient: unknown }>(
      "SELECT public.billing_notice_recipient($1, $2::uuid) AS recipient",
      [receipt.id, paid.organizationId]
    );
    assert.equal(swappedRecipient.rows[0]?.recipient, null, "swapped: null");
    await assert.rejects(
      handleBillingNotice(
        dependencies(await dbNow()),
        await envelopeOf(paid, receipt.id)
      ),
      (error: unknown) =>
        error instanceof DeferredHandlerError &&
        error.delaySeconds > 9 * 60 &&
        error.delaySeconds <= 10 * 60 + 5,
      "the receipt waits its 10 minutes: the queue brings it back then"
    );
    assert.equal((await noticeOf(paid, "charge_receipt")).sent_at, null);
    tests.push(
      "billing_notice_store and billing_notice_recipient through the real clients (named arguments) answer the store, its time zone mapped to timeZone, and the owner's verified address for a notice owed; called with the notice and the store swapped they answer null; another store's notice reads as none; the receipt waits 10 minutes, still owed, and the queue brings it back when it is due"
    );

    // ------------------------------------------------ 4. after the purge: no_recipient, then nothing to do
    await owner.pool.query(
      "UPDATE public.billing_notices SET due_at = now() - interval '1 minute' WHERE id = $1::uuid",
      [receipt.id]
    );
    const cancelled = await apply(paid, paidRef, {
      occurredAt: await dbNow(),
      type: "subscription_cancelled",
    });
    assert.equal(cancelled.status, "applied");
    const lateCancel = await noticeOf(paid, "renewal_cancelled");
    await owner.pool.query(
      "UPDATE public.organizations SET status = 'purged' WHERE id = $1",
      [paid.organizationId]
    );
    const purgedAt = await dbNow();
    assert.equal(
      await handleBillingNotice(
        dependencies(purgedAt),
        await envelopeOf(paid, receipt.id)
      ),
      "skipped"
    );
    assert.equal(
      (await noticeOf(paid, "charge_receipt")).skipped_reason,
      "no_recipient"
    );
    const lateEnvelope = await envelopeOf(paid, lateCancel.id);
    // the purge then takes the notices of the store
    await owner.pool.query(
      "DELETE FROM public.billing_notices WHERE organization_id = $1",
      [paid.organizationId]
    );
    assert.equal(
      await handleBillingNotice(
        dependencies(new Date(purgedAt.getTime() + DAY)),
        lateEnvelope
      ),
      "not_due",
      "the event of a notice the purge took finds nothing, and does not throw"
    );
    assert.equal(sent.length, 1, "nothing went out for the purged store");
    tests.push(
      "a notice of a purged store is skipped no_recipient without an error, and once the purge took its notices the event of another one finds nothing to do (not_due): neither throws, so neither is retried, dead-lettered or an incident"
    );

    // ------------------------------------------------ 5. cases 3 and 4 of item 5; the E7 waits, the handover settles it
    const refund = await newTenant("refund");
    const refundRef = ref("chk");
    const refundChargeAt = new Date((await dbNow()).getTime() - DAY);
    await billing.attachProvider(refund.organizationId, "asaas", refundRef, {
      firstChargeOn: localDate(refundChargeAt, zone),
      priceAmount: "24.90",
      priceId: "pro-1",
    });
    const refundPeriodEndsAt = new Date(refundChargeAt.getTime() + 30 * DAY);
    assert.equal(
      (
        await apply(refund, refundRef, {
          amount: { currency: "BRL", value: "24.90" },
          cycleMonths: 1,
          occurredAt: refundChargeAt,
          periodEndsAt: refundPeriodEndsAt,
          type: "charge_succeeded",
        })
      ).status,
      "applied"
    );
    const provider = fakePaymentProvider();
    const commands = { portFor: () => provider.port, store: billing };
    const requestId = randomUUID();
    const first = await ownerRequestRefund(commands, {
      organizationId: refund.organizationId,
      requestId,
    });
    assert.equal(first.response.result, "refund_requested");
    const e7 = await noticeOf(refund, "renewal_cancelled");
    assert.ok(
      e7.due_at.getTime() - e7.recorded_at.getTime() >= DAY - MINUTE,
      "the E7 of a refund request waits a day"
    );
    const countOf = async (sql: string) =>
      Number(
        (
          await owner.pool.query<{ count: string }>(sql, [
            refund.organizationId,
          ])
        ).rows[0]?.count
      );
    const cancellations = () =>
      countOf(
        "SELECT count(*)::text AS count FROM public.billing_events WHERE organization_id = $1 AND fact_type = 'subscription_cancelled'"
      );
    const noticeCount = (await notices(refund)).length;
    const eventCount = (await events(refund)).length;
    assert.equal(await cancellations(), 1);
    const clearLimit = () =>
      owner.pool.query(
        `UPDATE public.organization_billing
            SET provider_command_at = NULL, provider_commands_hour_start = NULL, provider_commands_hour = NULL
          WHERE organization_id = $1`,
        [refund.organizationId]
      );
    /** A repeated request may be answered or refused: what counts here is what it records. */
    const requestAgain = async (id: string) => {
      try {
        await ownerRequestRefund(commands, {
          organizationId: refund.organizationId,
          requestId: id,
        });
      } catch (error: unknown) {
        if (
          !(
            error instanceof OwnerCommandRefusal ||
            error instanceof OwnerCommandProviderFailure
          )
        ) {
          throw error;
        }
      }
    };
    // case 3: the same request ID again
    await clearLimit();
    await requestAgain(requestId);
    assert.equal(await cancellations(), 1, "case 3: no second cancellation");
    assert.equal((await notices(refund)).length, noticeCount, "case 3");
    assert.equal((await events(refund)).length, eventCount, "case 3");
    // case 4: another request ID
    await clearLimit();
    await requestAgain(randomUUID());
    assert.equal(await cancellations(), 1, "case 4: no second cancellation");
    assert.equal(
      (await notices(refund)).filter((row) => row.kind === "renewal_cancelled")
        .length,
      1,
      "case 4: no second E7"
    );
    assert.equal((await events(refund)).length, eventCount, "case 4");
    // the E7 waits its day: the consumer leaves it owed and the handover does not list it
    const waitingAt = await dbNow();
    assert.equal(
      await handleBillingNotice(
        dependencies(waitingAt),
        await envelopeOf(refund, e7.id)
      ),
      "not_yet_due"
    );
    const listed = async (at: Date) =>
      (await billing.listOwedNotices(at, 100_000)).some(
        (owed) => owed.noticeId === e7.id
      );
    assert.equal(await listed(waitingAt), false, "not due: not handed over");
    // the refund comes in: E-R goes out
    assert.equal(
      (
        await apply(refund, refundRef, {
          amount: { currency: "BRL", value: "24.90" },
          occurredAt: await dbNow(),
          periodEndsAt: refundPeriodEndsAt,
          type: "charge_refunded",
        })
      ).status,
      "applied"
    );
    const refunded = await noticeOf(refund, "refund_confirmed");
    const before = sent.length;
    assert.equal(
      await handleBillingNotice(
        dependencies(await dbNow()),
        await envelopeOf(refund, refunded.id)
      ),
      "sent"
    );
    assert.equal(sent.length, before + 1);
    assert.equal(sent[before]?.to, await emailOf(refund));
    // a day later the handover finds the E7 and settles it: the period was refunded
    await owner.pool.query(
      "UPDATE public.billing_notices SET due_at = due_at - interval '25 hours', recorded_at = recorded_at - interval '25 hours' WHERE id = $1::uuid",
      [e7.id]
    );
    const handoverAt = await dbNow();
    assert.equal(await listed(handoverAt), true, "due: handed over");
    const real = wired.dependencies.notices;
    const report = await handOverOwedBillingNotices({
      ...dependencies(handoverAt),
      // the real list, only this store's (other gates leave notices of their own)
      notices: {
        ...real,
        listOwed: async (at, limit) =>
          (await real.listOwed(at, 100_000))
            .filter((owed) => owed.organizationId === refund.organizationId)
            .slice(0, limit),
      },
    });
    assert.equal(report.handedOver, 1);
    assert.equal(report.skipped, 1);
    assert.equal(
      (await noticeOf(refund, "renewal_cancelled")).skipped_reason,
      "refunded"
    );
    assert.equal(sent.length, before + 1, "the E7 did not go out");
    tests.push(
      "cases 3 and 4 of item 5 with the real store and commands: the owner's refund request records one subscription_cancelled and one E7 that waits 24 hours; the same request ID again and another request ID record no second cancellation, no second E7 and no new outbox event; the E7 is left owed by the consumer and not listed by listOwed until due; the refund's webhook records E-R, which goes to the owner; a day later the hourly handover lists the E7 and settles it skipped refunded"
    );

    // ------------------------------------------------ 6. the window counts from the first attempt; the round-robin
    const receiptTenant = async (label: string, dueHoursAgo: number) => {
      const tenant = await newTenant(label);
      const tenantRef = ref("chk");
      const chargeAt = new Date((await dbNow()).getTime() - DAY);
      await billing.attachProvider(tenant.organizationId, "asaas", tenantRef, {
        firstChargeOn: localDate(chargeAt, zone),
        priceAmount: "24.90",
        priceId: "pro-1",
      });
      assert.equal(
        (
          await apply(tenant, tenantRef, {
            amount: { currency: "BRL", value: "24.90" },
            cycleMonths: 1,
            occurredAt: chargeAt,
            periodEndsAt: new Date(chargeAt.getTime() + 30 * DAY),
            type: "charge_succeeded",
          })
        ).status,
        "applied"
      );
      const receiptOf = await noticeOf(tenant, "charge_receipt");
      // only due_at moves back (recorded_at stays: a charge processed after it would read as paid since the notice)
      await owner.pool.query(
        "UPDATE public.billing_notices SET due_at = now() - make_interval(hours => $2) WHERE id = $1::uuid",
        [receiptOf.id, dueHoursAgo]
      );
      return { notice: receiptOf, tenant };
    };
    const noticeNow = async (tenant: TenantFixture) =>
      await noticeOf(tenant, "charge_receipt");

    // (a) never tried, due 30 hours ago: it goes out, and the attempt is written
    const untried = await receiptTenant("never tried", 30);
    assert.equal((await noticeNow(untried.tenant)).first_attempted_at, null);
    const beforeUntried = sent.length;
    assert.equal(
      await handleBillingNotice(
        dependencies(await dbNow()),
        await envelopeOf(untried.tenant, untried.notice.id)
      ),
      "sent"
    );
    assert.equal(
      sent.length,
      beforeUntried + 1,
      "a notice never tried goes out"
    );
    const untriedAfter = await noticeNow(untried.tenant);
    assert.ok(untriedAfter.sent_at);
    assert.ok(untriedAfter.first_attempted_at, "the first attempt is written");
    assert.ok(
      untriedAfter.first_attempted_at <= untriedAfter.sent_at,
      "written before the sending was marked"
    );

    // (b) first tried 23 hours and a minute ago: the window passed, nothing is sent, and the attempt is not moved
    const stale = await receiptTenant("tried long ago", 30);
    await owner.pool.query(
      "UPDATE public.billing_notices SET first_attempted_at = now() - interval '23 hours 1 minute' WHERE id = $1::uuid",
      [stale.notice.id]
    );
    const staleBefore = (await noticeNow(stale.tenant)).first_attempted_at;
    const beforeStale = sent.length;
    assert.equal(
      await handleBillingNotice(
        dependencies(await dbNow()),
        await envelopeOf(stale.tenant, stale.notice.id)
      ),
      "skipped"
    );
    const staleAfter = await noticeNow(stale.tenant);
    assert.equal(staleAfter.skipped_reason, "delivery_window_passed");
    assert.equal(sent.length, beforeStale, "nothing went out");
    assert.equal(
      staleAfter.first_attempted_at?.getTime(),
      staleBefore?.getTime()
    );
    // and one first tried 22 hours ago still goes out
    const recent = await receiptTenant("tried recently", 30);
    await owner.pool.query(
      "UPDATE public.billing_notices SET first_attempted_at = now() - interval '22 hours' WHERE id = $1::uuid",
      [recent.notice.id]
    );
    assert.equal(
      await handleBillingNotice(
        dependencies(await dbNow()),
        await envelopeOf(recent.tenant, recent.notice.id)
      ),
      "sent"
    );

    // (c) and (d): the one that throws stays written as tried and goes behind the ones never tried
    const thrower = await receiptTenant("thrower", 40);
    const next = await receiptTenant("next", 35);
    const ours = new Set([thrower, next].map((x) => x.tenant.organizationId));
    const realNotices = wired.dependencies.notices;
    const ourList = async (at: Date, limit: number) =>
      (await realNotices.listOwed(at, 100_000))
        .filter((owed) => ours.has(owed.organizationId))
        .slice(0, limit);
    const ids = (list: { noticeId: string }[]) =>
      list.map((owed) => owed.noticeId);
    assert.deepEqual(
      ids(await ourList(await dbNow(), 5)),
      [thrower.notice.id, next.notice.id],
      "both never tried: the oldest due first"
    );
    const throwing: ClosureNoticeSender = (message: Sent) =>
      message.idempotencyKey === thrower.notice.id
        ? Promise.reject(new Error("the provider call broke"))
        : send(message);
    const beforeThrow = sent.length;
    await assert.rejects(
      handOverOwedBillingNotices(
        {
          ...dependencies(await dbNow()),
          notices: { ...realNotices, listOwed: ourList },
          send: throwing,
        },
        5
      ),
      handoverIncomplete
    );
    assert.equal(
      sent.length,
      beforeThrow + 1,
      "the next one went in the same batch"
    );
    assert.ok((await noticeNow(next.tenant)).sent_at);
    const thrown = await noticeNow(thrower.tenant);
    assert.equal(thrown.sent_at, null, "the one that threw is still owed");
    assert.ok(thrown.first_attempted_at, "its attempt stayed written");
    const later = await receiptTenant("later", 20);
    ours.add(later.tenant.organizationId);
    assert.deepEqual(
      ids(await ourList(await dbNow(), 5)),
      [later.notice.id, thrower.notice.id],
      "never tried first, though the one that threw is due earlier"
    );
    assert.deepEqual(
      ids(await ourList(await dbNow(), 1)),
      [later.notice.id],
      "a batch of one reaches the one never tried"
    );
    // (e): two notices already tried rotate by the last attempt, not by the first, through the consumer
    const triedA = await receiptTenant("tried-a", 50);
    const triedB = await receiptTenant("tried-b", 45);
    let rotation = [triedA];
    const rotationList = async (at: Date, limit: number) =>
      (await realNotices.listOwed(at, 100_000))
        .filter((owed) =>
          rotation.some(
            (one) => one.tenant.organizationId === owed.organizationId
          )
        )
        .slice(0, limit);
    const handOverRotation = async (
      batch: number,
      sender: ClosureNoticeSender
    ) =>
      handOverOwedBillingNotices(
        {
          ...dependencies(await dbNow()),
          notices: { ...realNotices, listOwed: rotationList },
          send: sender,
        },
        batch
      );
    const throwAlways: ClosureNoticeSender = () =>
      Promise.reject(new Error("the provider call broke"));
    // B is tried first, then A, then B again: B has the older first attempt and the newer last one
    for (const [group, batch] of [
      [[triedB], 1],
      [[triedA], 1],
      [[triedB], 1],
    ] as const) {
      rotation = [...group];
      await assert.rejects(
        handOverRotation(batch, throwAlways),
        handoverIncomplete
      );
    }
    const aTried = await noticeNow(triedA.tenant);
    const bTried = await noticeNow(triedB.tenant);
    assert.ok(aTried.first_attempted_at && bTried.first_attempted_at);
    assert.ok(aTried.last_attempted_at && bTried.last_attempted_at);
    assert.ok(
      bTried.first_attempted_at < aTried.first_attempted_at,
      "B was first tried before A"
    );
    assert.ok(
      bTried.last_attempted_at > aTried.last_attempted_at,
      "and tried again after it"
    );
    assert.ok(
      bTried.first_attempted_at < bTried.last_attempted_at,
      "the second attempt moved only the last one"
    );
    rotation = [triedA, triedB];
    assert.deepEqual(
      ids(await rotationList(await dbNow(), 5)),
      [triedA.notice.id, triedB.notice.id],
      "both tried: the one tried longest ago first, though B's first attempt is older"
    );
    const throwingB: ClosureNoticeSender = (message: Sent) =>
      message.idempotencyKey === triedB.notice.id
        ? throwAlways(message)
        : send(message);
    const beforeRotation = sent.length;
    assert.equal(
      (await handOverRotation(1, throwingB)).sent,
      1,
      "a batch of one reaches A: B, the one that failed last, is behind it"
    );
    assert.equal(sent.length, beforeRotation + 1);
    assert.ok((await noticeNow(triedA.tenant)).sent_at);
    assert.equal((await noticeNow(triedB.tenant)).sent_at, null);
    tests.push(
      "two notices already tried rotate by the last attempt, written by the consumer: the one first tried earlier but tried again later goes behind the other (the order by the first attempt would put it ahead), the second attempt moves only last_attempted_at, and a batch of one sends the other"
    );

    tests.push(
      "the delivery window counts from the first attempt: a notice never tried and due 30 hours ago is sent and its first attempt is written (before it is marked sent); one first tried 23 hours and a minute ago is skipped delivery_window_passed without a send and with the attempt untouched; one first tried 22 hours ago is sent; a notice whose send throws keeps its attempt written and stays owed, the next one never tried is sent in the same batch, and the real listOwed then puts a never-tried notice, even a later-due one, ahead of the one that threw"
    );

    console.log(
      JSON.stringify(
        {
          branch,
          database: expectedDatabase,
          gate: "billing-notice-consumer",
          status: "passed",
          tests,
        },
        null,
        2
      )
    );
  } finally {
    for (const close of closers.reverse()) {
      await close().catch(() => undefined);
    }
    for (const [role, group] of logins) {
      await owner.pool
        .query(`REVOKE "${group}" FROM "${role}"`)
        .catch(() => undefined);
      await owner.pool
        .query(`DROP ROLE IF EXISTS "${role}"`)
        .catch(() => undefined);
    }
    await owner.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Billing notice consumer PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
