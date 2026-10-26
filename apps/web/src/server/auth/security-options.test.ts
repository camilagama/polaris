import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBetterAuth } from "../auth";
import { SIGN_UP_LEGAL_ACCEPTANCE } from "./legal-acceptance-test-support";
import {
  betterAuthSecurityOptions,
  sessionCookieName as sessionCookieNameFor,
} from "./security-options";

const httpsBaseURL = "https://polaris.example.invalid";
const testSecret = "test-only-better-auth-secret-32-bytes";
const password = "uma frase longa e unica para os testes de seguranca 42";
const email = "security-options@example.invalid";
const sessionCookieName = /^__Secure-better-auth\.session_token=/;
const secureAttribute = /;\s*Secure/i;
const httpOnlyAttribute = /;\s*HttpOnly/i;
const sameSiteLaxAttribute = /;\s*SameSite=Lax/i;
const rootPathAttribute = /;\s*Path=\//i;
const domainAttribute = /;\s*Domain=/i;

interface MemoryDatabase extends Record<string, Record<string, unknown>[]> {
  account: Record<string, unknown>[];
  session: Record<string, unknown>[];
  user: Record<string, unknown>[];
  verification: Record<string, unknown>[];
}

function stubPwnedPasswordRange() {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://api.pwnedpasswords.com/range/")) {
      throw new Error("Unexpected outbound request during auth test.");
    }
    return Promise.resolve(new Response(`${"0".repeat(35)}:0\r\n`));
  });
}

function createHarness(
  options: {
    baseURL?: string;
    runInBackground?: (promise: Promise<unknown>) => void;
    sendVerificationEmail?: () => Promise<void>;
  } = {}
) {
  const baseURL = options.baseURL ?? httpsBaseURL;
  const database: MemoryDatabase = {
    account: [],
    session: [],
    user: [],
    verification: [],
  };
  const verificationEmails: Array<{ token: string; url: string }> = [];
  const auth = createBetterAuth({
    auditEventWriter: () => Promise.resolve(),
    baseURL,
    databaseAdapter: memoryAdapter(database),
    emailDelivery: {
      sendPasswordReset: () => Promise.resolve(),
      sendVerificationEmail: ({ token, url }) => {
        verificationEmails.push({ token, url });
        return options.sendVerificationEmail?.() ?? Promise.resolve();
      },
    },
    ...(options.runInBackground
      ? { runInBackground: options.runInBackground }
      : {}),
    secret: testSecret,
  });

  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
  ) =>
    auth.handler(
      new Request(`${baseURL}/api/auth${path}`, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          origin: new URL(baseURL).origin,
          ...headers,
        },
        method: "POST",
      })
    );

  return { auth, baseURL, database, post, verificationEmails };
}

async function signUpAndVerify(harness: ReturnType<typeof createHarness>) {
  const signUp = await harness.post("/sign-up/email", {
    email,
    legalAcceptance: SIGN_UP_LEGAL_ACCEPTANCE,
    name: "Security Options",
    password,
  });
  expect(signUp.status).toBe(200);
  const [verification] = harness.verificationEmails;
  const verify = await harness.auth.handler(
    new Request(
      `${harness.baseURL}/api/auth/verify-email?token=${encodeURIComponent(verification?.token ?? "")}`,
      { headers: { origin: new URL(harness.baseURL).origin } }
    )
  );
  expect(verify.status).toBe(200);
}

describe("Better Auth security options", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pins cookie attributes, trusted origin and the client IP header", () => {
    expect(betterAuthSecurityOptions(`${httpsBaseURL}/ignored/path`)).toEqual({
      advanced: {
        defaultCookieAttributes: {
          httpOnly: true,
          path: "/",
          sameSite: "lax",
          secure: true,
        },
        ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
        useSecureCookies: true,
      },
      trustedOrigins: [httpsBaseURL],
    });
  });

  it("allows plain HTTP only for loopback development", () => {
    expect(
      betterAuthSecurityOptions("http://127.0.0.1:5173").advanced
    ).toMatchObject({
      defaultCookieAttributes: { secure: false },
      useSecureCookies: false,
    });
    expect(() =>
      betterAuthSecurityOptions("http://polaris.example.invalid")
    ).toThrow("auth_base_url_must_be_https");
  });

  it("names the session cookie by the base URL, the way useSecureCookies does", () => {
    expect(sessionCookieNameFor(httpsBaseURL)).toBe(
      "__Secure-better-auth.session_token"
    );
    expect(sessionCookieNameFor("http://localhost:8787")).toBe(
      "better-auth.session_token"
    );
    expect(sessionCookieNameFor(undefined)).toBeUndefined();
    expect(sessionCookieNameFor("not a url")).toBeUndefined();
  });

  it("registers a background task handler only when one is supplied", () => {
    const handler = () => undefined;

    expect(
      betterAuthSecurityOptions(httpsBaseURL, handler).advanced
    ).toMatchObject({ backgroundTasks: { handler } });
    expect(betterAuthSecurityOptions(httpsBaseURL).advanced).not.toHaveProperty(
      "backgroundTasks"
    );
  });

  it("issues Secure, HttpOnly, SameSite=Lax, path-scoped cookies with the __Secure- prefix over HTTPS", async () => {
    stubPwnedPasswordRange();
    const fresh = createHarness();
    await signUpAndVerify(fresh);
    const login = await fresh.post("/sign-in/email", { email, password });
    const sessionCookie = login.headers
      .getSetCookie()
      .find((value) => value.includes("session_token"));

    expect(login.status).toBe(200);
    expect(sessionCookie).toMatch(sessionCookieName);
    // the name the rate limiter reads is the name Better Auth set
    expect(sessionCookie?.split("=", 1)[0]).toBe(
      sessionCookieNameFor(httpsBaseURL)
    );
    expect(sessionCookie).toMatch(secureAttribute);
    expect(sessionCookie).toMatch(httpOnlyAttribute);
    expect(sessionCookie).toMatch(sameSiteLaxAttribute);
    expect(sessionCookie).toMatch(rootPathAttribute);
    expect(sessionCookie).not.toMatch(domainAttribute);
  });

  it("records the Cloudflare client IP and ignores a spoofed X-Forwarded-For", async () => {
    stubPwnedPasswordRange();
    const harness = createHarness();
    await signUpAndVerify(harness);

    const login = await harness.post(
      "/sign-in/email",
      { email, password },
      {
        "cf-connecting-ip": "203.0.113.7",
        "x-forwarded-for": "198.51.100.99",
      }
    );

    expect(login.status).toBe(200);
    expect(harness.database.session.at(-1)?.ipAddress).toBe("203.0.113.7");
  });

  it("never falls back to X-Forwarded-For when Cloudflare sent no client IP", async () => {
    stubPwnedPasswordRange();
    const harness = createHarness();
    await signUpAndVerify(harness);

    await harness.post(
      "/sign-in/email",
      { email, password },
      { "x-forwarded-for": "198.51.100.99" }
    );

    expect(harness.database.session.at(-1)?.ipAddress).not.toBe(
      "198.51.100.99"
    );
  });

  it("answers sign-up before the verification e-mail is delivered when a background runner is set", async () => {
    stubPwnedPasswordRange();
    let releaseDelivery: () => void = () => undefined;
    const delivery = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const background: Promise<unknown>[] = [];
    const harness = createHarness({
      runInBackground: (promise) => background.push(promise),
      sendVerificationEmail: () => delivery,
    });

    const signUp = await harness.post("/sign-up/email", {
      email,
      legalAcceptance: SIGN_UP_LEGAL_ACCEPTANCE,
      name: "Background Email",
      password,
    });

    expect(signUp.status).toBe(200);
    expect(harness.verificationEmails).toHaveLength(1);
    expect(background).toHaveLength(1);

    let settled = false;
    background[0]?.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseDelivery();
    await background[0];
    expect(settled).toBe(true);
  });

  it("swallows delivery failures of background e-mail without failing the request", async () => {
    stubPwnedPasswordRange();
    const logger = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const background: Promise<unknown>[] = [];
    const harness = createHarness({
      runInBackground: (promise) => background.push(promise),
      sendVerificationEmail: () => Promise.reject(new Error("provider down")),
    });

    const signUp = await harness.post("/sign-up/email", {
      email,
      legalAcceptance: SIGN_UP_LEGAL_ACCEPTANCE,
      name: "Background Failure",
      password,
    });
    await Promise.all(background);

    expect(signUp.status).toBe(200);
    logger.mockRestore();
  });
});
