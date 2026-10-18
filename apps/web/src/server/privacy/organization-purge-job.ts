import type {
  ClaimedOrganizationPurge,
  PrivacyMaintenanceClient,
} from "@polaris/db/privacy-maintenance";
import {
  MEDIA_DERIVATIVE_SIZES,
  mediaDerivativeKey,
} from "@polaris/domain/catalog/media";
import {
  ORGANIZATION_PURGE_LEASE_SECONDS,
  type ORGANIZATION_PURGE_STEPS,
  organizationExportPrefix,
  organizationMediaPrefix,
} from "@polaris/domain/privacy/organization-purge";
import type { MediaBucketBinding } from "../environment";
import { deleteObjectsUnderPrefix } from "./storage-prefix";

/** A purge removes a whole organization: a run takes a few, and the rest wait for the next hour. */
const PURGES_PER_RUN = 3;
/** Another purge is started only while the run is young: a run that is killed leaves the purge held until its lease ends. */
const NEXT_PURGE_BUDGET_MS = 4 * 60_000;

type PurgeStep = (typeof ORGANIZATION_PURGE_STEPS)[number];

export interface OrganizationPurgeReport {
  failed: number;
  purged: number;
  swept: number;
}

type PurgeClient = Pick<
  PrivacyMaintenanceClient,
  | "claimOrganizationPurge"
  | "completeOrganizationPurgeSweep"
  | "listOrganizationPurgeMedia"
  | "purgeOrganizationData"
  | "recordOrganizationPurgeFailure"
>;

export interface OrganizationPurgeJobDependencies {
  bucket: Pick<MediaBucketBinding, "delete" | "list">;
  client: PurgeClient;
  now: () => Date;
}

/** R2 removes at most this many keys in one call. */
const DELETE_BATCH = 1000;

/**
 * Every image of the organization: the master, its derivatives (whose keys carry only the asset) and
 * the masters' prefix. Keys go in batches, so a few thousand images are a handful of calls. A master
 * key outside the organization's prefix stops the step: the purge never removes another
 * organization's object.
 */
async function removeMedia(
  organizationId: string,
  { bucket, client }: OrganizationPurgeJobDependencies
): Promise<void> {
  const prefix = organizationMediaPrefix(organizationId);
  const assets = await client.listOrganizationPurgeMedia(organizationId);
  const keys: string[] = [];
  for (const asset of assets) {
    if (!asset.storageKey.startsWith(prefix)) {
      throw new Error("purge_media_key_outside_organization");
    }
    keys.push(
      asset.storageKey,
      ...MEDIA_DERIVATIVE_SIZES.map((size) =>
        mediaDerivativeKey(asset.id, size)
      )
    );
  }
  for (let start = 0; start < keys.length; start += DELETE_BATCH) {
    // biome-ignore lint/performance/noAwaitInLoops: one batch at a time keeps the run's external calls bounded.
    await bucket.delete(keys.slice(start, start + DELETE_BATCH));
  }
  // a master whose asset row was never written (an upload that stopped) is found by its prefix
  await deleteObjectsUnderPrefix(bucket, prefix);
}

/** Looks at both prefixes again; anything found is removed and reported (an export that wrote late). */
async function sweep(
  organizationId: string,
  { bucket }: OrganizationPurgeJobDependencies
): Promise<void> {
  const late =
    (await deleteObjectsUnderPrefix(
      bucket,
      organizationExportPrefix(organizationId)
    )) +
    (await deleteObjectsUnderPrefix(
      bucket,
      organizationMediaPrefix(organizationId)
    ));
  if (late > 0) {
    console.warn("organization_purge_sweep_removed", { objects: late });
  }
}

/**
 * One purge, step by step (ADR 0081). The storage goes first, and a failure there stops before the
 * database: once the rows are gone only the organization's ID (kept by the deletion ledger) finds what
 * is left. Then the rows, in one transaction that writes the tombstone first, and a second sweep of the
 * storage. Every step can run again: a purge that failed is tried again from the start on a later run
 * (it stays held until its lease ends).
 */
async function purgeOne(
  claimed: ClaimedOrganizationPurge,
  dependencies: OrganizationPurgeJobDependencies,
  report: OrganizationPurgeReport
): Promise<void> {
  const { bucket, client } = dependencies;
  const { organizationId } = claimed;
  let step: PurgeStep = "exports_storage";
  try {
    if (claimed.phase === "purge") {
      await deleteObjectsUnderPrefix(
        bucket,
        organizationExportPrefix(organizationId)
      );
      step = "media_storage";
      await removeMedia(organizationId, dependencies);
      step = "database";
      await client.purgeOrganizationData(organizationId);
      report.purged += 1;
    }
    step = "second_sweep";
    await sweep(organizationId, dependencies);
    if (await client.completeOrganizationPurgeSweep(organizationId)) {
      report.swept += 1;
    }
  } catch {
    report.failed += 1;
    // the organization's ID is opaque; nothing of the error (which may quote a key) is logged
    console.warn("organization_purge_step_failed", {
      attempt: claimed.attempt,
      organizationId,
      step,
    });
    // the purge stays held until its lease ends, so this run does not take it again; recording can fail too
    await client
      .recordOrganizationPurgeFailure(organizationId, `purge_${step}_failed`)
      .catch(() => {
        console.warn("organization_purge_failure_not_recorded", {
          organizationId,
        });
      });
  }
}

/**
 * The purges an operator scheduled (no job schedules one, ADR 0079 and 0081). A purge that fails
 * never stops the others.
 */
export async function runOrganizationPurges(
  dependencies: OrganizationPurgeJobDependencies
): Promise<OrganizationPurgeReport> {
  const startedAt = dependencies.now().getTime();
  const report: OrganizationPurgeReport = { failed: 0, purged: 0, swept: 0 };
  for (let run = 0; run < PURGES_PER_RUN; run += 1) {
    if (
      run > 0 &&
      dependencies.now().getTime() - startedAt > NEXT_PURGE_BUDGET_MS
    ) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: one organization at a time.
    const claimed = await dependencies.client.claimOrganizationPurge(
      ORGANIZATION_PURGE_LEASE_SECONDS
    );
    if (!claimed) {
      break;
    }
    await purgeOne(claimed, dependencies, report);
  }
  return report;
}
