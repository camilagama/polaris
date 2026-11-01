import type { RequestIdVariables } from "hono/request-id";
import type { AssetsBinding } from "./built-assets";
import type { MediaImagesBinding } from "./media-image-pipeline";

export interface HyperdriveBinding {
  connectionString: string;
}

/**
 * A Cloudflare Queue as a producer (ADR 0083): the outbox dispatcher (ADR 0084) sends with
 * `sendBatch`. The body is an envelope from `@polaris/domain/events/queue-envelope`.
 */
interface QueueProducerBinding {
  send: (
    body: unknown,
    options?: { contentType?: "json"; delaySeconds?: number }
  ) => Promise<void>;
  sendBatch: (
    messages: Iterable<{
      body: unknown;
      contentType?: "json";
      delaySeconds?: number;
    }>
  ) => Promise<unknown>;
}

export interface RateLimitBinding {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
}

interface MediaBucketObject {
  arrayBuffer: () => Promise<ArrayBuffer>;
  body: ReadableStream<Uint8Array>;
  httpEtag: string;
  size: number;
  uploaded: Date;
}

interface MediaBucketListResult {
  cursor?: string;
  objects: Array<{ key: string; uploaded: Date }>;
  truncated: boolean;
}

export interface MediaBucketBinding {
  /** One key, or up to 1000 keys in one call (R2 `delete` accepts both). */
  delete: (keys: string | string[]) => Promise<void>;
  get: (key: string) => Promise<MediaBucketObject | null>;
  list: (options: {
    cursor?: string;
    limit: number;
    prefix: string;
  }) => Promise<MediaBucketListResult>;
  put: (
    key: string,
    value: Uint8Array,
    options?: {
      httpMetadata?: { cacheControl?: string; contentType?: string };
      onlyIf?: Headers;
    }
  ) => Promise<{ etag: string } | null>;
}

export interface WorkerBindings {
  /** `staging` or `production` (per environment in `wrangler.jsonc`); labels the `environment` of every log event. */
  POLARIS_ENVIRONMENT?: string;
  /** The static assets of the build (`assets.binding`): the Worker answers `/assets/*` through it, 404 for a file that is not there. */
  ASSETS?: AssetsBinding;
  /** Asaas API key (secret): `$aact_hmlg_...` in staging, the production one only in production (ADR 0101). */
  ASAAS_API_KEY?: string;
  /** `https://api-sandbox.asaas.com/v3` in staging, `https://api.asaas.com/v3` in production. */
  ASAAS_BASE_URL?: string;
  /** The token Asaas sends in `asaas-access-token` (secret, 32 to 255 characters). */
  ASAAS_WEBHOOK_TOKEN?: string;
  /** The next token, accepted too while the webhook's token is rotated (secret). */
  ASAAS_WEBHOOK_TOKEN_NEXT?: string;
  AUTH_ABUSE_PROTECTION_ENABLED?: string;
  AUTH_DATABASE_CONNECT_TIMEOUT_MS?: string;
  AUTH_EMAIL_FROM?: string;
  AUTH_EMAIL_RATE_LIMITER?: RateLimitBinding;
  AUTH_EMAIL_REPLY_TO?: string;
  AUTH_HYPERDRIVE?: HyperdriveBinding;
  AUTH_RATE_LIMITER?: RateLimitBinding;
  /** The limiter of the Google sign-in start and callback (20 per 60 s per IP); it has no Turnstile. */
  AUTH_SOCIAL_RATE_LIMITER?: RateLimitBinding;
  BETTER_AUTH_BASE_URL?: string;
  /** The secret (32 characters or more) the Pix payer's lock and customer keys derive from (ADR 0101, emenda do PR 6); generated once, never rotated by routine. Without it the Pix checkout answers 503. */
  BILLING_PAYER_KEY?: string;
  /** The billing role (webhooks, the sweep of expired access): never the tenant's. */
  BILLING_HYPERDRIVE?: HyperdriveBinding;
  /**
   * `true` turns on the owner's billing self-service (ADR 0104, decision 1): the "Assinatura" item, `billing.readPlan`,
   * the owner's commands and the billing e-mails. Anything else (and absent) leaves it off; off in every environment
   * until the responsible turns it on.
   */
  BILLING_SELF_SERVICE_ENABLED?: string;
  /**
   * The support box of the billing e-mails and the welcome (ADR 0104, decision 7): the footer names it and it is the
   * reply-to. Required: without it (or without `RESEND_API_KEY`, `AUTH_EMAIL_FROM`, `BETTER_AUTH_BASE_URL` and
   * `AUTH_HYPERDRIVE`) those e-mails stay off and their notices are skipped `email_not_configured`. Not a secret.
   */
  BILLING_SUPPORT_EMAIL?: string;
  /** The origin the public catalog is served from (used only to show the organization its link). */
  CATALOG_ORIGIN?: string;
  /** The limit of `POST /api/client-errors` per address (10 per minute): the reports of errors of the browser. */
  CLIENT_ERROR_RATE_LIMIT?: RateLimitBinding;
  /**
   * `"1"` turns on `POST /api/client-errors` (the report of an error of the app in the browser, ADR 0098 amended);
   * anything else (and absent) answers 204 and logs nothing. Off in production until the go-live checklist.
   */
  CLIENT_ERRORS_ENABLED?: string;
  /**
   * `true` turns on the automatic schedule of the purge of a closed organization (ADR 0102); anything else
   * leaves it off. Off in every environment until the go-live.
   */
  CLOSURE_AUTO_PURGE_ENABLED?: string;
  /**
   * `true` turns on the e-mail of the closure notices (ADR 0102, amended), with `RESEND_API_KEY`, `AUTH_EMAIL_FROM`,
   * `BETTER_AUTH_BASE_URL` and `AUTH_HYPERDRIVE` (the address is read by the authentication role); anything else
   * leaves every notice owed, neither sent nor failed. Off in every environment until the responsible turns it on.
   */
  CLOSURE_NOTICE_EMAIL_ENABLED?: string;
  BETTER_AUTH_SECRET?: string;
  EMAIL_PASSWORD_AUTH_ENABLED?: string;
  GOOGLE_CLIENT_ID?: string;
  /**
   * `true` turns on the server control of the legal acceptance (ADR 0100): without the acceptance of the
   * versions in force, every authenticated request outside the exempt list is refused. Anything else
   * (and absent) leaves it off; the sign-up and `/aceite` record the acceptance either way.
   */
  LEGAL_ACCEPTANCE_ENFORCED?: string;
  /**
   * `true` turns on the hourly sweep of the welcome (E1, ADR 0104, decision 6): the stores of the last 24 hours get
   * their welcome recorded, with its outbox event. Anything else leaves it off and writes nothing. Off in every
   * environment: it goes on only with the consumer of `billing.notice` deployed (PR G), the legal basis checked (EM-37)
   * and P48.
   */
  WELCOME_EMAIL_ENABLED?: string;
  GOOGLE_CLIENT_SECRET?: string;
  HYPERDRIVE: HyperdriveBinding;
  IMAGES?: MediaImagesBinding;
  MEDIA_BUCKET?: MediaBucketBinding;
  MEDIA_CLEANUP_HYPERDRIVE?: HyperdriveBinding;
  MEDIA_UPLOAD_RATE_LIMIT?: RateLimitBinding;
  OFFLINE_LEASE_KEY_ID?: string;
  OFFLINE_LEASE_PREVIOUS_KEY_ID?: string;
  OFFLINE_LEASE_PREVIOUS_SECRET?: string;
  OFFLINE_LEASE_SECRET?: string;
  ONBOARDING_HYPERDRIVE?: HyperdriveBinding;
  /**
   * The outbox role (ADR 0084): the dispatcher claims, marks and gives back events and the queue
   * consumer keeps its processing record, only through functions; it reads nothing directly.
   */
  OUTBOX_HYPERDRIVE?: HyperdriveBinding;
  /** The privacy role (marks expired closure windows as closed): it executes one function and reads nothing. */
  PRIVACY_HYPERDRIVE?: HyperdriveBinding;
  /** The queues of the plan (ADR 0083), by how much a late message costs. */
  QUEUE_CRITICAL?: QueueProducerBinding;
  QUEUE_DEFAULT?: QueueProducerBinding;
  /** The dead-letter queue (ADR 0085). */
  QUEUE_DLQ?: QueueProducerBinding;
  QUEUE_MEDIA?: QueueProducerBinding;
  /**
   * Exactly `true` makes `/health` declare the commit the Worker was built from (`X-Polaris-Release`, ADR 0098 amended);
   * absent or any other value sends no release. Set to `true` only in `env.staging`; the isolation check refuses it in
   * production.
   */
  RELEASE_HEADER_ENABLED?: string;
  RESEND_API_KEY?: string;
  /**
   * `true` makes `http_request_timed` (with `isolate.id`/`seq`) cover every matched `/rpc` procedure and named `/api` route, not
   * only the critical routes (CPU-1e, ADR 0094 amended). Set only in `env.staging`; production keeps `false`, which the
   * staging isolation check enforces.
   */
  ROUTE_TIMING_ALL?: string;
  /** The calls of the import over `/rpc` (`kind: "bulk"`, one row each), per session and per address: its own bucket. */
  RPC_BULK_RATE_LIMIT?: RateLimitBinding;
  /** Writes over `/rpc`, per session and per address (one binding, the same limit for both). */
  RPC_MUTATION_RATE_LIMIT?: RateLimitBinding;
  /** Reads over `/rpc`, per address: wider than the session one, a whole store shares an address. */
  RPC_READ_IP_RATE_LIMIT?: RateLimitBinding;
  /** Reads over `/rpc`, per session. */
  RPC_READ_RATE_LIMIT?: RateLimitBinding;
  /** A secret of a rotation, still accepted when comparing a retried offline command (ADR 0079). */
  SYNC_PAYLOAD_HASH_PREVIOUS_SECRET?: string;
  /** The key of the HMAC that identifies an offline command's content (ADR 0079); at least 32 bytes. */
  SYNC_PAYLOAD_HASH_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** The public key of the Turnstile widget of this environment (not a secret). */
  TURNSTILE_SITE_KEY?: string;
  /** Woovi AppID (secret): the sandbox one in staging, the production one only in production (ADR 0101). */
  WOOVI_APP_ID?: string;
  /** `https://api.woovi-sandbox.com` in staging, `https://api.woovi.com` in production. */
  WOOVI_BASE_URL?: string;
  /**
   * `"true"` turns on the refund command for Woovi; anything else keeps it off
   * (the default) until the refund of an installment is proven in the sandbox
   * (S3.2, Gate 7).
   */
  WOOVI_REFUND_ENABLED?: string;
  /**
   * Woovi's public keys that sign webhooks (`x-webhook-signature`), pinned: one
   * SPKI key as base64 of its DER, or two separated by a comma during a
   * rotation (public, not a secret).
   */
  WOOVI_WEBHOOK_PUBLIC_KEYS?: string;
}

export interface ServerEnv {
  Bindings: WorkerBindings;
  Variables: RequestIdVariables & {
    /** The `/rpc` path oRPC matched to a procedure (`markMatchedProcedure`), for the route timing. */
    timedProcedure?: string;
  };
}
