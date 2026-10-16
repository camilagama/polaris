import type { RequestIdVariables } from "hono/request-id";
import type { MediaImagesBinding } from "./media-image-pipeline";

export interface HyperdriveBinding {
  connectionString: string;
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
  RESEND_API_KEY?: string;
  RPC_MUTATION_RATE_LIMIT?: RateLimitBinding;
  TURNSTILE_SECRET_KEY?: string;
}

export interface ServerEnv {
  Bindings: WorkerBindings;
  Variables: RequestIdVariables;
}
