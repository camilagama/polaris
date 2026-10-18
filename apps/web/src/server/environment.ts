import type { RequestIdVariables } from "hono/request-id";
import type { MediaImagesBinding } from "./media-image-pipeline";

export interface HyperdriveBinding {
  connectionString: string;
}

/**
 * A Cloudflare Queue as a producer (ADR 0083). Declared for the dispatcher of PR110; nothing sends
 * through it yet. The body is an envelope from `@polaris/domain/events/queue-envelope`.
 */
interface QueueProducerBinding {
  send: (
    body: unknown,
    options?: { contentType?: "json"; delaySeconds?: number }
  ) => Promise<void>;
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
  delete: (key: string) => Promise<void>;
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
  AUTH_ABUSE_PROTECTION_ENABLED?: string;
  AUTH_DATABASE_CONNECT_TIMEOUT_MS?: string;
  AUTH_EMAIL_FROM?: string;
  AUTH_EMAIL_RATE_LIMITER?: RateLimitBinding;
  AUTH_EMAIL_REPLY_TO?: string;
  AUTH_HYPERDRIVE?: HyperdriveBinding;
  AUTH_RATE_LIMITER?: RateLimitBinding;
  BETTER_AUTH_BASE_URL?: string;
  /** The billing role (webhooks, the sweep of expired access): never the tenant's. */
  BILLING_HYPERDRIVE?: HyperdriveBinding;
  /** The origin the public catalog is served from (used only to show the organization its link). */
  CATALOG_ORIGIN?: string;
  BETTER_AUTH_SECRET?: string;
  EMAIL_PASSWORD_AUTH_ENABLED?: string;
  GOOGLE_CLIENT_ID?: string;
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
  /** The privacy role (marks expired closure windows as closed): it executes one function and reads nothing. */
  PRIVACY_HYPERDRIVE?: HyperdriveBinding;
  /** The queues of the plan (ADR 0083), by how much a late message costs. */
  QUEUE_CRITICAL?: QueueProducerBinding;
  QUEUE_DEFAULT?: QueueProducerBinding;
  QUEUE_MEDIA?: QueueProducerBinding;
  RESEND_API_KEY?: string;
  RPC_MUTATION_RATE_LIMIT?: RateLimitBinding;
  /** A secret of a rotation, still accepted when comparing a retried offline command (ADR 0079). */
  SYNC_PAYLOAD_HASH_PREVIOUS_SECRET?: string;
  /** The key of the HMAC that identifies an offline command's content (ADR 0079); at least 32 bytes. */
  SYNC_PAYLOAD_HASH_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
}

export interface ServerEnv {
  Bindings: WorkerBindings;
  Variables: RequestIdVariables;
}
