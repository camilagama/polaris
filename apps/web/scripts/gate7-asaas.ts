/**
 * Gate 7, cartão no Asaas (ADR 0101, D1: Gate 7 por script, sem tela). Runs the
 * billing commands against the Asaas SANDBOX and a staging (or local) database:
 * start the checkout, read the state, reconcile, refund, cancel the renewal
 * and settle the trials no reservation paid for. The QA types the card on the
 * provider's page (reCAPTCHA), so `checkout` writes the link to a private file
 * (mode 0600, outside the repository) and never prints it; the API key, the
 * link and what the provider answers never reach the terminal.
 *
 * Load the sandbox credentials with `set -a` and single quotes in the file
 * (the key starts with `$`; `. file` without them leaves it empty):
 *
 *   set -a; . ~/.secrets/pagamentos-sandbox.env; set +a
 *   BILLING_DATABASE_URL=… DATABASE_URL=… BETTER_AUTH_BASE_URL=https://… \
 *     bun scripts/gate7-asaas.ts checkout --organization <id> --user <id> \
 *     --cycle 1 --trial --link-file /tmp/gate7-link.txt
 *
 * Commands: checkout, state, wait, reconcile, refund, cancel, settle-unclaimed.
 * See docs/runbooks/billing-providers.md (Gate 7).
 */
import { randomUUID } from "node:crypto";
import { open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { listBillingPrices } from "@polaris/db/billing-repository";
import { createBillingStore } from "@polaris/db/billing-store";
import { createDatabase } from "@polaris/db/client";
import { withAuthorizedTenantTransaction } from "@polaris/db/tenant-transaction";
import { describeError } from "@polaris/observability/wide-event";
import {
  ENVIRONMENT_MARKER_SQL,
  type EnvironmentReadings,
} from "../../../packages/db/scripts/environment-marker";
import {
  cancelRenewal,
  checkoutPriceOf,
  type OperatorCommandDependencies,
  type RefundCommandDependencies,
  reconcileOrganization,
  refundCurrentPeriod,
  settleUnclaimedTrials,
  startCardCheckout,
} from "../src/server/billing/commands";
import { billingProviderPortOf } from "../src/server/billing/provider-ports";
import {
  assertAsaasSandbox,
  assertGate7Database,
  assertGate7DatabaseUrl,
  assertSameDatabase,
  checkedLinkFile,
  cycleOf,
  Gate7RefusedError,
  refundReport,
} from "./gate7-asaas-guard";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const WAIT_POLL_MS = 15_000;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    cycle: { type: "string" },
    "link-file": { type: "string" },
    minutes: { type: "string" },
    organization: { type: "string" },
    trial: { default: false, type: "boolean" },
    until: { type: "string" },
    user: { type: "string" },
  },
});

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Gate7RefusedError(`gate7_missing_${name}`);
  }
  return value;
}

function print(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result));
}

const environment = process.env;

/**
 * Checks a database before it is used: the URL first, before any connection
 * (host overrides and session options refused), then its environment marker.
 * The tenant and billing URLs must name the same database. Never prints a URL.
 */
async function checkedDatabaseUrl(
  name: "BILLING_DATABASE_URL" | "DATABASE_URL"
): Promise<string> {
  const url = required(name.toLowerCase(), environment[name]);
  assertGate7DatabaseUrl(url);
  assertSameDatabase(
    required("database_url", environment.DATABASE_URL),
    required("billing_database_url", environment.BILLING_DATABASE_URL)
  );
  const { pool } = createDatabase(url, { maxConnections: 1 });
  try {
    const { rows } = await pool.query<EnvironmentReadings>(
      ENVIRONMENT_MARKER_SQL
    );
    assertGate7Database(url, {
      comment: rows[0]?.comment ?? null,
      current: rows[0]?.current ?? null,
      stored: rows[0]?.stored ?? null,
    });
  } finally {
    await pool.end();
  }
  return url;
}

function bindings() {
  return {
    ASAAS_API_KEY: environment.ASAAS_API_KEY ?? "",
    ASAAS_BASE_URL: environment.ASAAS_BASE_URL ?? "",
    BETTER_AUTH_BASE_URL: environment.BETTER_AUTH_BASE_URL ?? "",
  };
}

async function withOperator<T>(
  run: (
    dependencies: OperatorCommandDependencies & RefundCommandDependencies
  ) => Promise<T>
): Promise<T> {
  const store = createBillingStore(
    await checkedDatabaseUrl("BILLING_DATABASE_URL")
  );
  try {
    return await run({
      portFor: (provider) => billingProviderPortOf(bindings(), provider),
      store,
    });
  } finally {
    await store.close();
  }
}

/** The owner's authorization and the price, as the RPC reads them (`billing:manage`, tenant transaction). */
async function authorizeCheckout(cycleMonths: 1 | 6 | 12) {
  const { db, pool } = createDatabase(
    await checkedDatabaseUrl("DATABASE_URL"),
    { maxConnections: 1 }
  );
  try {
    return await withAuthorizedTenantTransaction(
      db,
      {
        authenticatedUserId: required("user", values.user),
        capability: "billing:manage",
        requestedOrganizationId: required("organization", values.organization),
      },
      async (transaction, identity) => ({
        ...checkoutPriceOf(await listBillingPrices(transaction), cycleMonths),
        organizationId: identity.organizationId,
        userId: identity.userId,
      })
    );
  } finally {
    await pool.end();
  }
}

/**
 * The link file: outside the repository by its real path too (a symlinked
 * parent is resolved), created empty with mode 0600 before the checkout, so a
 * path that cannot be written stops the run before anything is created.
 */
async function openLinkFile(path: string) {
  const asked = checkedLinkFile(path, REPOSITORY_ROOT);
  const real = checkedLinkFile(
    join(await realpath(dirname(asked)), basename(asked)),
    await realpath(REPOSITORY_ROOT)
  );
  return { file: await open(real, "wx", 0o600), path: real };
}

async function checkout(): Promise<void> {
  const cycleMonths = cycleOf(values.cycle);
  const link = await openLinkFile(required("link_file", values["link-file"]));
  let written = false;
  try {
    const authorized = await authorizeCheckout(cycleMonths);
    const port = billingProviderPortOf(bindings(), "asaas");
    const store = createBillingStore(
      await checkedDatabaseUrl("BILLING_DATABASE_URL"),
      {
        discardCheckout: (abandoned) =>
          billingProviderPortOf(bindings(), abandoned.provider).discardCheckout(
            abandoned.providerRef
          ),
      }
    );
    try {
      const { handoff } = await startCardCheckout(
        { port, store },
        { ...authorized, cycleMonths, trial: values.trial }
      );
      // the link is the payer's: a private file for the QA, never the terminal
      await link.file.writeFile(`${handoff.url}\n`);
      written = true;
    } finally {
      await store.close();
    }
  } finally {
    await link.file.close();
    if (!written) {
      await rm(link.path, { force: true });
    }
  }
  print({
    checkout: "created",
    cycleMonths,
    linkFile: link.path,
    trial: values.trial,
  });
}

async function readState(organizationId: string) {
  const store = createBillingStore(
    await checkedDatabaseUrl("BILLING_DATABASE_URL")
  );
  try {
    const record = await store.readRecord(organizationId);
    const link = await store.readProviderLink(organizationId);
    // only the state and whether a provider is linked: never the references themselves
    return {
      accessEndsAt: record?.accessEndsAt?.toISOString() ?? null,
      cancelAtPeriodEnd: record?.cancelAtPeriodEnd ?? false,
      provider: link?.provider ?? null,
      state: record?.state ?? "free",
      subscriptionKnown: Boolean(link?.providerSubscriptionId),
    };
  } finally {
    await store.close();
  }
}

async function wait(organizationId: string): Promise<void> {
  const target = required("until", values.until);
  const minutes = Number(values.minutes ?? "30");
  if (!(Number.isInteger(minutes) && minutes > 0 && minutes <= 120)) {
    throw new Gate7RefusedError("gate7_minutes_invalid");
  }
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: Polling one state, in the foreground.
    const state = await readState(organizationId);
    if (state.state === target) {
      print({ reached: true, ...state });
      return;
    }
    if (Date.now() >= deadline) {
      print({ reached: false, ...state });
      process.exitCode = 1;
      return;
    }
    await new Promise((done) => setTimeout(done, WAIT_POLL_MS));
  }
}

async function main(): Promise<void> {
  assertAsaasSandbox(environment);
  const [command] = positionals;
  const organization = () => required("organization", values.organization);
  switch (command) {
    case "checkout":
      return await checkout();
    case "state":
      return print(await readState(organization()));
    case "wait":
      return await wait(organization());
    case "reconcile":
      return print({
        ...(await withOperator((dependencies) =>
          reconcileOrganization(dependencies, organization())
        )),
      });
    case "refund":
      return print(
        await withOperator(async (dependencies) => {
          const refund = await refundCurrentPeriod(dependencies, {
            organizationId: organization(),
            requestId: randomUUID(),
          });
          // the renewal as the record shows it now: cancelled also when nothing was left to refund
          const record = await dependencies.store.readRecord(organization());
          return refundReport(refund, record?.cancelAtPeriodEnd ?? false);
        })
      );
    case "cancel":
      return print({
        cancel: await withOperator((dependencies) =>
          cancelRenewal(dependencies, {
            organizationId: organization(),
            requestId: randomUUID(),
          })
        ),
      });
    case "settle-unclaimed":
      return print({
        ...(await withOperator((dependencies) =>
          settleUnclaimedTrials(dependencies)
        )),
      });
    default:
      throw new Gate7RefusedError("gate7_unknown_command");
  }
}

try {
  await main();
} catch (error: unknown) {
  // only the class and the code: never a message that could carry the provider's answer
  print({ error: describeError(error) });
  process.exitCode = 1;
}
