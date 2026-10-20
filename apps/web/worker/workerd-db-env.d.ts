/// <reference types="@cloudflare/vitest-plugin/types" />
// Types for the Workers harness with a database (`*.workerd-db.test.ts`): what `cloudflare:workers` exposes in a test.
// biome-ignore lint/style/noNamespace: the Workers types are extended by merging into the global Cloudflare namespace
declare namespace Cloudflare {
  interface Env {
    AUTH_HYPERDRIVE: Hyperdrive;
    BILLING_HYPERDRIVE: Hyperdrive;
    HYPERDRIVE: Hyperdrive;
    MEDIA_BUCKET: R2Bucket;
    MEDIA_CLEANUP_HYPERDRIVE: Hyperdrive;
    ONBOARDING_HYPERDRIVE: Hyperdrive;
    OUTBOX_HYPERDRIVE: Hyperdrive;
    PRIVACY_HYPERDRIVE: Hyperdrive;
    QUEUE_CRITICAL: Queue;
    QUEUE_DEFAULT: Queue;
    QUEUE_DLQ: Queue;
    QUEUE_MEDIA: Queue;
    /** Test only: what the gate made (logins, organizations, outbox events). */
    TEST_WEB_FIXTURE: string;
  }
  interface Exports {
    default: Fetcher;
  }
}
