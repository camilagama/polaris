import type { WorkerBindings } from "../environment";

const siteverifyURL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const turnstileTokenHeader = "x-turnstile-token";
const turnstileTokenMaxLength = 2048;
const invalidClientIpPattern = /[\r\n,\s]/;
const trailingSlashPattern = /\/+$/;

type TurnstileAction =
  | "login"
  | "password_reset"
  | "password_reset_request"
  | "signup"
  | "verification_email";

const protectedActions = new Map<string, TurnstileAction>([
  ["/sign-up/email", "signup"],
  ["/sign-in/email", "login"],
  ["/request-password-reset", "password_reset_request"],
  ["/reset-password", "password_reset"],
  ["/send-verification-email", "verification_email"],
]);

const emailSendingActions = new Set<TurnstileAction>([
  "password_reset_request",
  "signup",
  "verification_email",
]);

export type AuthAbuseProtector = (
  request: Request,
  bindings: WorkerBindings,
  requestId?: string,
  fetcher?: typeof fetch
) => Promise<Response | undefined>;

interface TurnstileSiteverifyResponse {
  action?: unknown;
  hostname?: unknown;
  success?: unknown;
}

function jsonError(status: number, code: string, requestId?: string): Response {
  return Response.json(
    {
      error: { code },
      ...(requestId ? { requestId } : {}),
    },
    {
      headers: { "cache-control": "no-store" },
      status,
    }
  );
}

function actionForRequest(request: Request): TurnstileAction | undefined {
  if (request.method.toUpperCase() !== "POST") {
    return undefined;
  }

  const pathname = new URL(request.url).pathname.replace(
    trailingSlashPattern,
    ""
  );
  for (const [suffix, action] of protectedActions) {
    if (pathname.endsWith(suffix)) {
      return action;
    }
  }

  return undefined;
}

export function isAuthAbuseProtectionApplicable(request: Request): boolean {
  return actionForRequest(request) !== undefined;
}

async function limiterKey(secret: string, scope: string, ip: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${scope}\u0000${ip}`)
    )
  );
  const digest = Array.from(signature, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

  return `${scope}:${digest}`;
}

async function checkRateLimit(
  request: Request,
  bindings: WorkerBindings,
  requestId: string | undefined,
  secret: string
): Promise<Response | undefined> {
  const clientIp = request.headers.get("cf-connecting-ip")?.trim();
  const ipLimiter = bindings.AUTH_RATE_LIMITER;

  if (
    !clientIp ||
    clientIp.length > 64 ||
    invalidClientIpPattern.test(clientIp) ||
    !ipLimiter
  ) {
    return jsonError(503, "auth_rate_limit_unavailable", requestId);
  }

  try {
    const ipResult = await ipLimiter.limit({
      key: await limiterKey(secret, "auth-ip", clientIp),
    });
    if (typeof ipResult.success !== "boolean") {
      return jsonError(503, "auth_rate_limit_unavailable", requestId);
    }
    if (!ipResult.success) {
      return jsonError(429, "auth_rate_limited", requestId);
    }
  } catch {
    return jsonError(503, "auth_rate_limit_unavailable", requestId);
  }

  return undefined;
}

async function checkEmailSendRateLimit(
  request: Request,
  bindings: WorkerBindings,
  requestId: string | undefined,
  secret: string
): Promise<Response | undefined> {
  const clientIp = request.headers.get("cf-connecting-ip")?.trim();
  const limiter = bindings.AUTH_EMAIL_RATE_LIMITER;
  if (!(clientIp && limiter)) {
    return jsonError(503, "auth_rate_limit_unavailable", requestId);
  }

  try {
    const result = await limiter.limit({
      key: await limiterKey(secret, "auth-email-send-ip", clientIp),
    });
    if (typeof result.success !== "boolean") {
      return jsonError(503, "auth_rate_limit_unavailable", requestId);
    }
    if (!result.success) {
      return jsonError(429, "auth_rate_limited", requestId);
    }
  } catch {
    return jsonError(503, "auth_rate_limit_unavailable", requestId);
  }

  return undefined;
}

export const protectAuthRequest: AuthAbuseProtector = async (
  request: Request,
  bindings: WorkerBindings,
  requestId?: string,
  fetcher = fetch
) => {
  const action = actionForRequest(request);
  if (!action) {
    return;
  }

  const secret = bindings.TURNSTILE_SECRET_KEY?.trim();
  const baseURL = bindings.BETTER_AUTH_BASE_URL?.trim();
  if (
    bindings.AUTH_ABUSE_PROTECTION_ENABLED !== "true" ||
    !secret ||
    !baseURL ||
    (emailSendingActions.has(action) && !bindings.AUTH_EMAIL_RATE_LIMITER)
  ) {
    return jsonError(503, "auth_abuse_protection_unavailable", requestId);
  }

  const rateLimitResponse = await checkRateLimit(
    request,
    bindings,
    requestId,
    secret
  );
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const token = request.headers.get(turnstileTokenHeader);
  if (!token || token.length > turnstileTokenMaxLength) {
    return jsonError(403, "auth_challenge_failed", requestId);
  }

  let expectedHostname: string;
  try {
    expectedHostname = new URL(baseURL).hostname;
  } catch {
    return jsonError(503, "auth_abuse_protection_unavailable", requestId);
  }

  let response: Response;
  try {
    const body = new URLSearchParams({
      idempotency_key: crypto.randomUUID(),
      response: token,
      secret,
    });
    response = await fetcher(siteverifyURL, {
      body,
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return jsonError(503, "auth_challenge_unavailable", requestId);
  }

  if (!response.ok) {
    return jsonError(503, "auth_challenge_unavailable", requestId);
  }

  let verification: TurnstileSiteverifyResponse;
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonError(503, "auth_challenge_unavailable", requestId);
    }
    verification = body as TurnstileSiteverifyResponse;
  } catch {
    return jsonError(503, "auth_challenge_unavailable", requestId);
  }

  if (verification.success === false) {
    return jsonError(403, "auth_challenge_failed", requestId);
  }
  if (verification.success !== true) {
    return jsonError(503, "auth_challenge_unavailable", requestId);
  }
  if (
    verification.action !== action ||
    verification.hostname !== expectedHostname
  ) {
    return jsonError(403, "auth_challenge_failed", requestId);
  }

  if (emailSendingActions.has(action)) {
    const emailRateLimitResponse = await checkEmailSendRateLimit(
      request,
      bindings,
      requestId,
      secret
    );
    if (emailRateLimitResponse !== undefined) {
      return emailRateLimitResponse;
    }
  }
};
