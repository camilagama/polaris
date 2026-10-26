import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { type Context, Hono } from "hono";
import {
  type AuthAbuseProtector,
  isAuthAbuseProtectionApplicable,
  isSocialAuthRateLimitApplicable,
  protectAuthLinkRequest,
  protectAuthRequest,
  protectSocialAuthRequest,
} from "./auth/abuse-protection";
import {
  handleBetterAuthRequest,
  handleEmailVerificationRequest,
  handleLoginUnlockRequest,
  isEmailPasswordAuthEnabled,
} from "./auth/handler";
import type { ServerEnv, WorkerBindings } from "./environment";
import { originCheckMiddleware } from "./middleware/origin-check";
import {
  mediaUploadRateLimitMiddleware,
  rpcRateLimitMiddleware,
} from "./middleware/rate-limit";
import { requestIdMiddleware } from "./middleware/request-id";
import {
  markMatchedProcedure,
  routeTimingMiddleware,
} from "./middleware/route-timing";
import { securityHeadersMiddleware } from "./middleware/security-headers";
import {
  logServerError,
  logServerErrorFromContext,
  logServerEvent,
} from "./observability/server-log";
import { authMethodsRoutes } from "./routes/auth-methods";
import { createBillingWebhookRoutes } from "./routes/billing-webhooks";
import { createClosedExportRoutes } from "./routes/closed-exports";
import { createDataExportRoutes } from "./routes/data-exports";
import { createMediaRoutes } from "./routes/media";
import { systemRoutes } from "./routes/system";
import { logLimitRefusal } from "./rpc/limit-refusal-log";
import { rpcRouter as defaultRpcRouter } from "./rpc/router";

type BackgroundTaskRunner = (promise: Promise<unknown>) => void;

type AuthRequestHandler = (
  request: Request,
  bindings: WorkerBindings,
  requestId: string,
  runInBackground?: BackgroundTaskRunner
) => Promise<Response>;

interface ServerAppOptions {
  authAbuseProtector?: AuthAbuseProtector;
  authHandler?: AuthRequestHandler;
  /** The routes of the links of the e-mails (`/api/login-unlock`, `/api/email-verification`). */
  authLinkHandlers?: {
    emailVerification: AuthRequestHandler;
    loginUnlock: AuthRequestHandler;
  };
  rpcRouter?: typeof defaultRpcRouter;
}

function backgroundTaskRunner(context: Context<ServerEnv>) {
  return (promise: Promise<unknown>): void => {
    try {
      context.executionCtx.waitUntil(promise);
    } catch {
      // No ExecutionContext (unit tests): detach the task without an unhandled rejection.
      promise.catch(() => undefined);
    }
  };
}

/**
 * The router wraps an unexpected fault in a 503 `server_busy`; the log keeps the class and the SQLSTATE of the
 * fault itself on top, as it did when the fault went out as a 500.
 */
function loggedFault(error: unknown): unknown {
  if (
    error instanceof ORPCError &&
    error.cause !== undefined &&
    (error.data as { reason?: unknown } | undefined)?.reason === "server_busy"
  ) {
    return error.cause;
  }
  return error;
}

export function createServerApp({
  authAbuseProtector = protectAuthRequest,
  authHandler = handleBetterAuthRequest,
  authLinkHandlers = {
    emailVerification: handleEmailVerificationRequest,
    loginUnlock: handleLoginUnlockRequest,
  },
  rpcRouter = defaultRpcRouter,
}: ServerAppOptions = {}) {
  const app = new Hono<ServerEnv>();
  const rpcHandler = new RPCHandler(rpcRouter, {
    clientInterceptors: [
      // Expected failures (4xx) are part of the contract; only server faults are logged.
      onError((error, options) => {
        const { requestId } = options.context as { requestId?: string };
        logLimitRefusal(error, requestId);
        if (error instanceof ORPCError && error.status < 500) {
          return;
        }
        logServerError({
          error: loggedFault(error),
          method: "POST",
          requestId: requestId ?? "unknown",
          route: `/rpc/${options.path.join("/")}`,
          status: error instanceof ORPCError ? error.status : 500,
        });
      }),
    ],
  });

  app.use("*", requestIdMiddleware);
  app.use("*", routeTimingMiddleware);
  app.use("*", securityHeadersMiddleware);
  app.use("/rpc/*", originCheckMiddleware);
  app.use("/api/*", originCheckMiddleware);
  app.use("/rpc/*", rpcRateLimitMiddleware);
  app.use("/api/products/:productId/media", mediaUploadRateLimitMiddleware);
  app.use("/rpc/*", async (context, next) => {
    const { matched, response } = await rpcHandler.handle(context.req.raw, {
      context: {
        bindings: context.env,
        request: context.req.raw,
        requestId: context.get("requestId"),
      },
      prefix: "/rpc",
    });

    if (matched) {
      markMatchedProcedure(context);
      return context.newResponse(response.body, response);
    }

    await next();
  });

  const authRoute = async (context: Context<ServerEnv>) => {
    const secret = context.env.BETTER_AUTH_SECRET;
    const baseURL = context.env.BETTER_AUTH_BASE_URL;

    if (!secret || secret.length < 32 || !baseURL) {
      return context.json(
        {
          error: { code: "auth_unavailable" },
          requestId: context.get("requestId"),
        },
        503
      );
    }

    if (isSocialAuthRateLimitApplicable(context.req.raw)) {
      const socialResponse = await protectSocialAuthRequest(
        context.req.raw,
        context.env,
        context.get("requestId"),
        // The callback turns a failing limiter into a redirect, which a 5xx alert no longer sees: say it here.
        () => logServerEvent("auth_social_rate_limit_unavailable", context)
      );
      if (socialResponse !== undefined) {
        return context.newResponse(socialResponse.body, socialResponse);
      }
    }

    if (
      isAuthAbuseProtectionApplicable(context.req.raw) &&
      isEmailPasswordAuthEnabled(context.env)
    ) {
      const abuseResponse = await authAbuseProtector(
        context.req.raw,
        context.env,
        context.get("requestId")
      );
      if (abuseResponse !== undefined) {
        return context.newResponse(abuseResponse.body, abuseResponse);
      }
    }

    return await authHandler(
      context.req.raw,
      context.env,
      context.get("requestId"),
      backgroundTaskRunner(context)
    );
  };
  app.get("/api/auth/*", authRoute);
  app.post("/api/auth/*", authRoute);

  // The links of the e-mails post their token here (ADR 0100): the origin check of `/api/*`, then the
  // limit per IP. Off (503) while the password is.
  const authLinkRoute =
    (handler: AuthRequestHandler) => async (context: Context<ServerEnv>) => {
      if (!isEmailPasswordAuthEnabled(context.env)) {
        return context.json(
          {
            error: { code: "auth_email_unavailable" },
            requestId: context.get("requestId"),
          },
          503,
          { "cache-control": "no-store" }
        );
      }
      const limited = await protectAuthLinkRequest(
        context.req.raw,
        context.env,
        context.get("requestId")
      );
      if (limited !== undefined) {
        return context.newResponse(limited.body, limited);
      }
      return await handler(
        context.req.raw,
        context.env,
        context.get("requestId"),
        backgroundTaskRunner(context)
      );
    };
  app.post("/api/login-unlock", authLinkRoute(authLinkHandlers.loginUnlock));
  app.post(
    "/api/email-verification",
    authLinkRoute(authLinkHandlers.emailVerification)
  );

  app.route("/", authMethodsRoutes);
  app.route("/", systemRoutes);
  app.route("/", createMediaRoutes());
  app.route("/", createDataExportRoutes());
  app.route("/", createClosedExportRoutes());
  // Provider webhooks sit outside /api and /rpc (browser origin checks): they
  // prove themselves by the provider signature their adapter verifies.
  app.route("/", createBillingWebhookRoutes());

  app.notFound((context) =>
    context.json(
      {
        error: { code: "not_found" },
        requestId: context.get("requestId"),
      },
      404
    )
  );

  app.onError((error, context) => {
    logServerErrorFromContext(context, error, 500);
    return context.json(
      {
        error: { code: "internal_error" },
        requestId: context.get("requestId"),
      },
      500
    );
  });

  return app;
}

export const app = createServerApp();
