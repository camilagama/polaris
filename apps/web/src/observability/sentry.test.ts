import type { ErrorInfo } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  breadcrumbsIntegration: vi.fn((options: unknown) => ({
    name: "Breadcrumbs",
    options,
  })),
  captureReactException: vi.fn(),
  init: vi.fn(),
}));
vi.mock("@sentry/react", () => sdk);

/** A made-up DSN: the key is invented and the project does not exist. */
const FAKE_DSN = "https://chavefalsa@o1.ingest.sentry.io/1";
const SHA = "9b3d37ed5c223fba78109e32e9196bb294b35358";
const FORBIDDEN_IN_SENT = /maria|abc123|"cookies"/;
const validEnv = {
  VITE_SENTRY_DSN: FAKE_DSN,
  VITE_SENTRY_ENVIRONMENT: "staging",
  VITE_SENTRY_RELEASE: SHA,
};

async function freshModule() {
  vi.resetModules();
  return { ...(await import("./sentry")), ...(await import("./sentry-sdk")) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("without a DSN", () => {
  it.each([
    {},
    { VITE_SENTRY_DSN: "" },
    { VITE_SENTRY_DSN: "   " },
    { VITE_SENTRY_ENVIRONMENT: "production" },
  ])("the SDK is not initialized for %j", async (env) => {
    const { initSentry, sentryOptions } = await freshModule();

    expect(sentryOptions(env)).toBeNull();
    expect(await initSentry(env)).toBe(false);
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("reporting a render error is a no-op, and never throws", async () => {
    const { initSentry, reportRenderError } = await freshModule();
    await initSentry({});

    reportRenderError(new Error("falha"), {} as ErrorInfo);

    expect(sdk.captureReactException).not.toHaveBeenCalled();
  });
});

describe("with a DSN that cannot be trusted", () => {
  it.each([
    { ...validEnv, VITE_SENTRY_DSN: "https://chavefalsa@example.com/1" },
    { ...validEnv, VITE_SENTRY_DSN: "http://chavefalsa@o1.ingest.sentry.io/1" },
    { ...validEnv, VITE_SENTRY_DSN: "lixo" },
    { ...validEnv, VITE_SENTRY_ENVIRONMENT: undefined },
    { ...validEnv, VITE_SENTRY_ENVIRONMENT: "" },
    { ...validEnv, VITE_SENTRY_ENVIRONMENT: "qa" },
  ])("the SDK stays off for %j", async (env) => {
    const { initSentry } = await freshModule();

    expect(await initSentry(env)).toBe(false);
    expect(sdk.init).not.toHaveBeenCalled();
  });
});

describe("with a valid DSN", () => {
  it("starts the SDK once, with the environment and the commit SHA of the build", async () => {
    const { initSentry } = await freshModule();

    expect(await initSentry(validEnv)).toBe(true);
    expect(await initSentry(validEnv)).toBe(true);

    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.init.mock.calls[0]?.[0]).toMatchObject({
      dsn: FAKE_DSN,
      environment: "staging",
      release: SHA,
    });
  });

  it.each(["local", "staging", "production"])(
    "accepts the environment %s",
    async (environment) => {
      const { sentryOptions } = await freshModule();

      expect(
        sentryOptions({ ...validEnv, VITE_SENTRY_ENVIRONMENT: environment })
      ).toMatchObject({ environment });
    }
  );

  it("sends errors only: no replay, no profiling, no tracing, no data collected on its own", async () => {
    const { initSentry } = await freshModule();
    await initSentry(validEnv);
    const options = sdk.init.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(options.dataCollection).toEqual({
      cookies: false,
      httpBodies: [],
      httpHeaders: false,
      stackFrameVariables: false,
      urlQueryParams: false,
      userInfo: false,
    });
    expect(options.tracePropagationTargets).toEqual([]);
    for (const key of [
      "tracesSampleRate",
      "tracesSampler",
      "profilesSampleRate",
      "profileSessionSampleRate",
      "replaysSessionSampleRate",
      "replaysOnErrorSampleRate",
    ]) {
      expect(options[key], key).toBeUndefined();
    }
    const integrations = (
      options.integrations as (defaults: { name: string }[]) => {
        name: string;
      }[]
    )([
      { name: "Breadcrumbs" },
      { name: "BrowserSession" },
      { name: "Console" },
      { name: "CultureContext" },
      { name: "GlobalHandlers" },
    ]).map((item) => item.name);
    expect(integrations).toEqual(["GlobalHandlers", "Breadcrumbs"]);
    expect(sdk.breadcrumbsIntegration).toHaveBeenCalledWith({
      dom: false,
      fetch: true,
      history: true,
      sentry: false,
      xhr: true,
    });
  });

  it("sanitizes events and breadcrumbs before they leave", async () => {
    const { sentryOptions } = await freshModule();
    const options = sentryOptions(validEnv);
    const sent = options?.beforeSend?.(
      {
        message: "cliente maria@example.com.br",
        request: { cookies: { a: "b" }, url: "/x?token=abc123" },
        type: undefined,
      },
      {}
    );
    const crumb = options?.beforeBreadcrumb?.(
      { category: "console", message: "x" },
      undefined
    );

    expect(JSON.stringify(sent)).not.toMatch(FORBIDDEN_IN_SENT);
    expect(crumb).toBeNull();
  });

  it("drops a release that is not a commit SHA", async () => {
    const { sentryOptions } = await freshModule();

    expect(
      sentryOptions({ ...validEnv, VITE_SENTRY_RELEASE: "v1.0 beta" })?.release
    ).toBeUndefined();
  });

  it("reports a render error with React's component stack", async () => {
    const { initSentry, reportRenderError } = await freshModule();
    await initSentry(validEnv);
    const error = new Error("falha");
    const info = { componentStack: "\n at Tela" } as ErrorInfo;

    reportRenderError(error, info);

    expect(sdk.captureReactException).toHaveBeenCalledWith(error, info);
  });
});
