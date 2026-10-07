import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthEmailDelivery } from "../auth";
import { createResendAuthEmailDelivery } from "./email";

const apiKey = "re_test_api_key";
const from = "Polaris <auth@example.invalid>";
const recipient = "person@example.invalid";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function testUser(): Parameters<
  AuthEmailDelivery["sendVerificationEmail"]
>[0]["user"] {
  return {
    id: "user-test-id",
    email: recipient,
    emailVerified: false,
    name: "Polaris Test User",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    image: null,
  };
}

describe("Resend authentication email delivery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends minimal verification email with a token-derived idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValue(Response.json({ id: "resend-email-id" }));
    vi.stubGlobal("fetch", fetcher);
    const delivery = createResendAuthEmailDelivery({ apiKey, from });
    const token = "verification-secret-token";
    const url = `https://polaris.example.invalid/api/auth/verify-email?token=${token}`;

    await delivery.sendVerificationEmail(
      { user: testUser(), token, url },
      new Request("https://polaris.example.invalid/api/auth/sign-up/email")
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [target, init] = fetcher.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as {
      from: string;
      html: string;
      subject: string;
      text: string;
      to: string[];
    };

    expect(String(target)).toBe("https://api.resend.com/emails");
    expect(headers.get("authorization")).toBe(`Bearer ${apiKey}`);
    expect(headers.get("idempotency-key")).toBe(
      `polaris-verification-${await sha256Hex(token)}`
    );
    expect(headers.get("idempotency-key")).not.toContain(token);
    expect(body.from).toBe(from);
    expect(body.to).toEqual([recipient]);
    expect(body.subject).toBe("Confirme seu email do Polaris");
    expect(body.html).toContain(url);
    expect(body.text).toContain(url);
  });

  it("sends password reset with a separate idempotency namespace", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValue(Response.json({ id: "resend-email-id" }));
    vi.stubGlobal("fetch", fetcher);
    const delivery = createResendAuthEmailDelivery({ apiKey, from });
    const token = "reset-secret-token";
    const url = `https://polaris.example.invalid/api/auth/reset-password/${token}`;

    await delivery.sendPasswordReset(
      { user: testUser(), token, url },
      new Request(
        "https://polaris.example.invalid/api/auth/request-password-reset"
      )
    );

    const [target, init] = fetcher.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as {
      html: string;
      subject: string;
      text: string;
    };

    expect(String(target)).toBe("https://api.resend.com/emails");
    expect(headers.get("idempotency-key")).toBe(
      `polaris-password-reset-${await sha256Hex(token)}`
    );
    expect(body.subject).toBe("Redefina sua senha do Polaris");
    expect(body.html).toContain(url);
    expect(body.html).toContain("expira em 1 hora");
    expect(body.text).toContain(url);
  });

  it("keeps a generic response and log when the provider rejects a send", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValue(
      Response.json(
        { message: "provider detail containing sensitive account data" },
        { status: 403 }
      )
    );
    vi.stubGlobal("fetch", fetcher);
    const loggerSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const delivery = createResendAuthEmailDelivery({ apiKey, from });

    await expect(
      delivery.sendPasswordReset(
        {
          user: testUser(),
          token: "reset-secret-token",
          url: "https://polaris.example.invalid/reset-password/reset-secret-token",
        },
        new Request(
          "https://polaris.example.invalid/api/auth/request-password-reset"
        )
      )
    ).resolves.toBeUndefined();

    expect(loggerSpy.mock.calls).toEqual([
      ["auth_email_delivery_failed", "password-reset"],
    ]);
    expect(JSON.stringify(loggerSpy.mock.calls)).not.toContain(
      "provider detail containing sensitive account data"
    );
  });
});
