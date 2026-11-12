import type { ActivationNoticeRecipientClient } from "@polaris/db/activation-notice-recipient";
import type {
  ActivationNoticeReread,
  ActivationNoticeStore,
} from "@polaris/db/activation-notice-store";
import { ACTIVATION_NOTICE_REREAD_REASONS } from "@polaris/domain/activation/notices";
import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import type { QueueEnvelope } from "@polaris/domain/events/queue-envelope";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ClosureNoticeSender,
  ClosureNoticeSendResult,
} from "../privacy/closure-notice-email";
import { PermanentHandlerError } from "../queue/consumer";
import { createUnsubscribeToken } from "../tips-stop/unsubscribe-token";
import {
  type ActivationNoticeDependencies,
  ActivationNoticeRetryError,
  activationNoticeDependenciesOf,
  activationNoticeEmailConfig,
  activationNoticeIdempotencyKey,
  activationSuppressionHmac,
  activationSuppressionSecretsOf,
  handleActivationNotice,
} from "./notice-consumer";

const NOTICE = "0199f0aa-2b3c-7d4e-8f90-123456789abc";
const ORG = "org_1";
const USER = "user_1";
const STORE_NAME = "Loja da Ana";
const ADDRESS = "ana@exemplo.com";
const NOW = new Date("2026-11-12T17:00:00.000Z");
const HOUR_MS = 3_600_000;

const SECRETS = {
  ACTIVATION_SUPPRESSION_HMAC_SECRET: "suppression-secret-0123456789-abcdefgh",
  BETTER_AUTH_SECRET: "better-auth-secret-0123456789-abcdefghij",
  BILLING_PAYER_KEY: "billing-payer-key-0123456789-abcdefghijkl",
  OFFLINE_LEASE_SECRET: "offline-lease-secret-0123456789-abcdefghi",
  SYNC_PAYLOAD_HASH_SECRET: "sync-payload-secret-0123456789-abcdefghi",
  UNSUBSCRIBE_TOKEN_SECRET: "unsubscribe-secret-0123456789-abcdefghij",
};

type EmailBindingsInput = Parameters<typeof activationNoticeEmailConfig>[0];
type WiringBindings = Parameters<typeof activationNoticeDependenciesOf>[0];

function bindingsWith(
  overrides: Record<string, string | undefined> = {}
): EmailBindingsInput {
  const merged: Record<string, string | undefined> = {
    ACTIVATION_EMAIL_FROM: "Polaris <dicas@example.invalid>",
    BETTER_AUTH_BASE_URL: "https://app.example",
    BILLING_SUPPORT_EMAIL: "suporte@araute.app",
    RESEND_API_KEY: "re_test_key_not_real",
    ...SECRETS,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined)
  ) as EmailBindingsInput;
}

function configured() {
  const config = activationNoticeEmailConfig(bindingsWith(), true);
  if (!config) {
    throw new Error("the fixture configuration must be valid");
  }
  return config;
}

function envelope(overrides: Partial<QueueEnvelope> = {}): QueueEnvelope {
  return {
    attempt: 1,
    correlationId: "corr_1",
    event: { noticeId: NOTICE },
    eventId: "0199f0aa-0000-7000-8000-000000000001",
    idempotencyKey: outboxIdempotencyKey("activation.notice", NOTICE),
    organizationId: ORG,
    type: "activation.notice",
    version: 1,
    ...overrides,
  };
}

interface SetupOptions {
  address?: string | null;
  claim?: { firstAttemptedAt: Date | null; userId: string } | null;
  email?: ActivationNoticeDependencies["email"];
  now?: Date;
  reread?: ActivationNoticeReread;
  result?: ClosureNoticeSendResult;
  suppressed?: boolean;
  switchedOn?: boolean;
}

function setup(options: SetupOptions = {}) {
  const claim =
    options.claim === undefined
      ? { firstAttemptedAt: null, userId: USER }
      : options.claim;
  const reread: ActivationNoticeReread =
    options.reread === undefined
      ? { hasProduct: true, step: "a2", store: STORE_NAME }
      : options.reread;
  const address = options.address === undefined ? ADDRESS : options.address;
  const send = vi.fn<ClosureNoticeSender>(() =>
    Promise.resolve(options.result ?? { outcome: "sent" })
  );
  const refusingSend = vi.fn<ClosureNoticeSender>(() => {
    throw new Error("must not send");
  });
  const recipients = {
    recipient: vi.fn((_notice: string, _org: string) =>
      Promise.resolve(address)
    ),
  };
  const notices = {
    claim: vi.fn((_notice: string, _org: string) => Promise.resolve(claim)),
    isSuppressed: vi.fn((_hmacs: readonly Uint8Array[]) =>
      Promise.resolve(options.suppressed ?? false)
    ),
    markAttempted: vi.fn((_notice: string, _org: string) =>
      Promise.resolve(true)
    ),
    markFailed: vi.fn((_notice: string, _org: string, _code: string) =>
      Promise.resolve(true)
    ),
    markSent: vi.fn((_notice: string, _org: string) => Promise.resolve(true)),
    markSkipped: vi.fn((_notice: string, _org: string, _reason: string) =>
      Promise.resolve(true)
    ),
    stillOwed: vi.fn((_notice: string, _org: string, _now: Date) =>
      Promise.resolve(reread)
    ),
  } satisfies Pick<
    ActivationNoticeStore,
    | "claim"
    | "isSuppressed"
    | "markAttempted"
    | "markFailed"
    | "markSent"
    | "markSkipped"
    | "stillOwed"
  >;
  const now = options.now ?? NOW;
  const dependencies: ActivationNoticeDependencies = {
    email: options.email === undefined ? configured() : options.email,
    notices,
    now: () => now,
    recipients,
    send,
    switchedOn: options.switchedOn ?? true,
  };
  return {
    dependencies,
    notices,
    recipients,
    refusingDependencies: { ...dependencies, send: refusingSend },
    refusingSend,
    send,
  };
}

function spyConsole() {
  return {
    error: vi.spyOn(console, "error").mockImplementation(() => undefined),
    info: vi.spyOn(console, "info").mockImplementation(() => undefined),
    log: vi.spyOn(console, "log").mockImplementation(() => undefined),
    warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
  };
}

function everythingLogged(spies: ReturnType<typeof spyConsole>): string {
  return JSON.stringify([
    spies.log.mock.calls,
    spies.info.mock.calls,
    spies.warn.mock.calls,
    spies.error.mock.calls,
  ]);
}

function expectNoPersonalData(text: string) {
  expect(text).not.toContain("@");
  expect(text).not.toContain("R$");
  expect(text).not.toContain(STORE_NAME);
  expect(text).not.toContain(ADDRESS);
}

async function skippedWith(
  options: SetupOptions,
  reason: string
): Promise<ReturnType<typeof setup>> {
  const fixture = setup(options);
  const outcome = await handleActivationNotice(
    fixture.refusingDependencies,
    envelope()
  );
  expect(outcome).toBe("skipped");
  expect(fixture.notices.markSkipped).toHaveBeenCalledWith(NOTICE, ORG, reason);
  expect(fixture.refusingSend).not.toHaveBeenCalled();
  expect(fixture.notices.markSent).not.toHaveBeenCalled();
  expect(fixture.notices.markAttempted).not.toHaveBeenCalled();
  return fixture;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the consumer of an activation notice: the envelope", () => {
  it("refuses, for good, an event whose ID is not a UUID or whose outbox key names another notice", async () => {
    spyConsole();
    const { dependencies, notices } = setup();
    for (const wrong of [
      envelope({
        event: { noticeId: "not-a-uuid" },
        idempotencyKey: outboxIdempotencyKey("activation.notice", "not-a-uuid"),
      }),
      envelope({
        idempotencyKey: outboxIdempotencyKey(
          "activation.notice",
          "0199f0aa-2b3c-7d4e-8f90-000000000000"
        ),
      }),
      envelope({ event: {} }),
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one refusal at a time, for a clear failure
      const failure = await handleActivationNotice(dependencies, wrong).then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(PermanentHandlerError);
      expect((failure as Error).message).toBe(
        "activation_notice_event_invalid"
      );
    }
    expect(notices.claim).not.toHaveBeenCalled();
    expect(notices.markSkipped).not.toHaveBeenCalled();
  });
});

describe("the consumer of an activation notice: the switch", () => {
  it("AC-7c.2: with the switch off it only closes the notice as switched_off and reads nothing else", async () => {
    spyConsole();
    const { dependencies, notices, recipients, send } = setup({
      switchedOn: false,
    });

    const outcome = await handleActivationNotice(dependencies, envelope());

    expect(outcome).toBe("skipped");
    expect(notices.markSkipped).toHaveBeenCalledWith(
      NOTICE,
      ORG,
      "switched_off"
    );
    expect(notices.claim).not.toHaveBeenCalled();
    expect(notices.stillOwed).not.toHaveBeenCalled();
    expect(recipients.recipient).not.toHaveBeenCalled();
    expect(notices.isSuppressed).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("AC-7c.2: the wiring with ACTIVATION_EMAILS_ENABLED not true opens no authentication connection", () => {
    spyConsole();
    const { notices } = setup();
    const openRecipients =
      vi.fn<(connectionString: string) => ActivationNoticeRecipientClient>();
    const wiring = {
      ...bindingsWith(),
      ACTIVATION_EMAILS_ENABLED: "false",
      AUTH_HYPERDRIVE: { connectionString: "x" },
    } as unknown as WiringBindings;

    const wired = activationNoticeDependenciesOf(
      wiring,
      notices,
      openRecipients
    );

    expect(openRecipients).not.toHaveBeenCalled();
    expect(wired.dependencies.switchedOn).toBe(false);
    expect(wired.dependencies.email).toBeNull();
  });
});

describe("the consumer of an activation notice: not due and the re-read", () => {
  it("does nothing when the claim finds the notice not owed (not_due)", async () => {
    spyConsole();
    const { dependencies, notices, recipients, send } = setup({ claim: null });

    expect(await handleActivationNotice(dependencies, envelope())).toBe(
      "not_due"
    );

    expect(notices.claim).toHaveBeenCalledWith(NOTICE, ORG);
    expect(notices.stillOwed).not.toHaveBeenCalled();
    expect(notices.markSkipped).not.toHaveBeenCalled();
    expect(notices.markSent).not.toHaveBeenCalled();
    expect(notices.markFailed).not.toHaveBeenCalled();
    expect(recipients.recipient).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("does nothing when the re-read finds the notice not owed (not_due)", async () => {
    spyConsole();
    const { dependencies, notices, recipients, send } = setup({ reread: null });

    expect(await handleActivationNotice(dependencies, envelope())).toBe(
      "not_due"
    );

    expect(notices.stillOwed).toHaveBeenCalledWith(NOTICE, ORG, NOW);
    expect(notices.markSkipped).not.toHaveBeenCalled();
    expect(notices.markSent).not.toHaveBeenCalled();
    expect(recipients.recipient).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(ACTIVATION_NOTICE_REREAD_REASONS)(
    "skips with the code %s that the database's re-read gave, before any address is read",
    async (code) => {
      spyConsole();
      const fixture = await skippedWith({ reread: { skip: code } }, code);
      expect(fixture.recipients.recipient).not.toHaveBeenCalled();
      expect(fixture.notices.isSuppressed).not.toHaveBeenCalled();
    }
  );

  it("drops a tip requeued with a due_at 10 days old: the expiry comes from the re-read, not from the Worker", async () => {
    spyConsole();
    const fixture = await skippedWith(
      { reread: { skip: "expired" } },
      "expired"
    );
    expect(fixture.notices.stillOwed).toHaveBeenCalledWith(NOTICE, ORG, NOW);
    expect(fixture.recipients.recipient).not.toHaveBeenCalled();
  });

  it("skips A1 as state_changed when the store has a product by the time of the send", async () => {
    spyConsole();
    const fixture = await skippedWith(
      { reread: { hasProduct: true, step: "a1", store: STORE_NAME } },
      "state_changed"
    );
    expect(fixture.recipients.recipient).not.toHaveBeenCalled();
  });
});

describe("the consumer of an activation notice: the configuration", () => {
  it("R-4: with the switch on and everything set it still skips as email_not_configured while the stop is not in force, and logs an error", async () => {
    const spies = spyConsole();
    const { notices } = setup();
    const openRecipients =
      vi.fn<(connectionString: string) => ActivationNoticeRecipientClient>();
    const wiring = {
      ...bindingsWith(),
      ACTIVATION_EMAILS_ENABLED: "true",
      AUTH_HYPERDRIVE: { connectionString: "postgresql://auth.invalid/db" },
    } as unknown as WiringBindings;
    const send = vi.fn<ClosureNoticeSender>(() => {
      throw new Error("must not send");
    });

    const wired = activationNoticeDependenciesOf(
      wiring,
      notices,
      openRecipients
    );
    const outcome = await handleActivationNotice(
      { ...wired.dependencies, now: () => NOW, send },
      envelope()
    );

    expect(wired.dependencies.switchedOn).toBe(true);
    expect(openRecipients).not.toHaveBeenCalled();
    expect(outcome).toBe("skipped");
    expect(notices.markSkipped).toHaveBeenCalledWith(
      NOTICE,
      ORG,
      "email_not_configured"
    );
    expect(send).not.toHaveBeenCalled();
    expect(everythingLogged(spies)).toContain(
      "activation_notice_email_misconfigured"
    );
    expect(spies.error).toHaveBeenCalled();
  });

  it("is off by default (the stop is not in force in the code) and on when told so", () => {
    expect(activationNoticeEmailConfig(bindingsWith())).toBeNull();
    expect(activationNoticeEmailConfig(bindingsWith(), true)).toMatchObject({
      appBaseUrl: "https://app.example",
      supportEmail: "suporte@araute.app",
    });
  });

  it("skips as email_not_configured, logging the incident, when the configuration is null", async () => {
    const spies = spyConsole();
    const fixture = await skippedWith({ email: null }, "email_not_configured");
    expect(fixture.recipients.recipient).not.toHaveBeenCalled();
    expect(fixture.notices.claim).toHaveBeenCalled();
    expect(everythingLogged(spies)).toContain(
      "activation_notice_email_misconfigured"
    );
    expectNoPersonalData(everythingLogged(spies));
  });

  const missing: [string, Record<string, string | undefined>][] = [
    ["RESEND_API_KEY is missing", { RESEND_API_KEY: undefined }],
    ["ACTIVATION_EMAIL_FROM is missing", { ACTIVATION_EMAIL_FROM: undefined }],
    [
      "only AUTH_EMAIL_FROM is set: it is not the sender of the series",
      {
        ACTIVATION_EMAIL_FROM: undefined,
        AUTH_EMAIL_FROM: "Polaris <auth@example.invalid>",
      },
    ],
    [
      "BILLING_SUPPORT_EMAIL (the Reply-To) is missing: nothing goes out without it",
      { BILLING_SUPPORT_EMAIL: undefined },
    ],
    [
      "BILLING_SUPPORT_EMAIL is a list",
      { BILLING_SUPPORT_EMAIL: "a@b.com,c@d.com" },
    ],
    [
      "the app's URL is http and not local",
      { BETTER_AUTH_BASE_URL: "http://app.example" },
    ],
    [
      "UNSUBSCRIBE_TOKEN_SECRET is missing",
      { UNSUBSCRIBE_TOKEN_SECRET: undefined },
    ],
    [
      "the suppression's secret is missing",
      { ACTIVATION_SUPPRESSION_HMAC_SECRET: undefined },
    ],
    [
      "the suppression's secret is under 32 characters",
      { ACTIVATION_SUPPRESSION_HMAC_SECRET: "x".repeat(31) },
    ],
    [
      "the previous suppression secret is set but short",
      { ACTIVATION_SUPPRESSION_HMAC_SECRET_PREVIOUS: "short" },
    ],
  ];

  it.each(missing)("is null when %s", (_label, overrides) => {
    expect(
      activationNoticeEmailConfig(bindingsWith(overrides), true)
    ).toBeNull();
  });

  it.each([
    "BETTER_AUTH_SECRET",
    "UNSUBSCRIBE_TOKEN_SECRET",
    "BILLING_PAYER_KEY",
    "SYNC_PAYLOAD_HASH_SECRET",
    "OFFLINE_LEASE_SECRET",
  ] as const)("is null when the suppression's secret equals %s", (name) => {
    expect(
      activationNoticeEmailConfig(
        bindingsWith({ ACTIVATION_SUPPRESSION_HMAC_SECRET: SECRETS[name] }),
        true
      )
    ).toBeNull();
  });

  it("keeps only the current secret when the previous one is the same", () => {
    const previous = SECRETS.ACTIVATION_SUPPRESSION_HMAC_SECRET;
    expect(
      activationSuppressionSecretsOf(
        bindingsWith({ ACTIVATION_SUPPRESSION_HMAC_SECRET_PREVIOUS: previous })
      )
    ).toEqual({ current: previous });
    expect(
      activationSuppressionSecretsOf(
        bindingsWith({
          ACTIVATION_SUPPRESSION_HMAC_SECRET_PREVIOUS:
            "previous-suppression-secret-0123456789-abc",
        })
      )
    ).toEqual({
      current: previous,
      previous: "previous-suppression-secret-0123456789-abc",
    });
  });
});

describe("the consumer of an activation notice: the hours", () => {
  it("skips as delivery_window_passed a notice first tried 23 hours and 1 ms ago, and sends one first tried exactly 23 hours ago", async () => {
    const spies = spyConsole();
    const fixture = await skippedWith(
      {
        claim: {
          firstAttemptedAt: new Date(NOW.getTime() - 23 * HOUR_MS - 1),
          userId: USER,
        },
      },
      "delivery_window_passed"
    );
    expect(fixture.recipients.recipient).not.toHaveBeenCalled();
    expect(everythingLogged(spies)).toContain(
      "activation_notice_delivery_window_passed"
    );

    const edge = setup({
      claim: {
        firstAttemptedAt: new Date(NOW.getTime() - 23 * HOUR_MS),
        userId: USER,
      },
    });
    expect(await handleActivationNotice(edge.dependencies, envelope())).toBe(
      "sent"
    );
    expect(edge.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    { at: "2026-11-12T10:59:59.999Z", label: "07:59:59.999", sends: false },
    { at: "2026-11-12T11:00:00.000Z", label: "08:00:00.000", sends: true },
    { at: "2026-11-12T22:59:59.999Z", label: "19:59:59.999", sends: true },
    { at: "2026-11-12T23:00:00.000Z", label: "20:00:00.000", sends: false },
  ])("at $label in São Paulo it sends: $sends", async ({ at, sends }) => {
    spyConsole();
    const now = new Date(at);
    if (sends) {
      const fixture = setup({ now });
      expect(
        await handleActivationNotice(fixture.dependencies, envelope())
      ).toBe("sent");
      expect(fixture.send).toHaveBeenCalledTimes(1);
    } else {
      const fixture = await skippedWith({ now }, "outside_send_hours");
      expect(fixture.recipients.recipient).not.toHaveBeenCalled();
    }
  });
});

describe("the consumer of an activation notice: the address", () => {
  it("AC-7c.7: reads the address only from the recipient of this notice and store", async () => {
    spyConsole();
    const { dependencies, recipients, send } = setup();

    await handleActivationNotice(dependencies, envelope());

    expect(recipients.recipient).toHaveBeenCalledTimes(1);
    expect(recipients.recipient).toHaveBeenCalledWith(NOTICE, ORG);
    expect(send.mock.calls[0]?.[0].to).toBe(ADDRESS);
  });

  it("skips as no_recipient when there is no address", async () => {
    spyConsole();
    const fixture = await skippedWith({ address: null }, "no_recipient");
    expect(fixture.recipients.recipient).toHaveBeenCalledWith(NOTICE, ORG);
    expect(fixture.notices.isSuppressed).not.toHaveBeenCalled();
  });

  it("skips as no_recipient when the address does not normalize", async () => {
    spyConsole();
    const fixture = await skippedWith(
      { address: "sem-arroba" },
      "no_recipient"
    );
    expect(fixture.notices.isSuppressed).not.toHaveBeenCalled();
  });

  it("skips as address_suppressed when the address is suppressed", async () => {
    spyConsole();
    const fixture = await skippedWith(
      { suppressed: true },
      "address_suppressed"
    );
    expect(fixture.notices.isSuppressed).toHaveBeenCalledTimes(1);
  });

  it("asks for one HMAC with the current secret only, 32 bytes, signed over the purpose and the normalized address", async () => {
    spyConsole();
    const secret = SECRETS.ACTIVATION_SUPPRESSION_HMAC_SECRET;
    const expected = await hmacOf(secret, "activation-suppression:v1:a@b.com");
    const bare = await hmacOf(secret, "a@b.com");
    for (const address of ["Nome <A@B.com>", "a@b.com "]) {
      const fixture = setup({ address, suppressed: true });
      // biome-ignore lint/performance/noAwaitInLoops: one address at a time
      await handleActivationNotice(fixture.dependencies, envelope());
      const [hmacs] = fixture.notices.isSuppressed.mock.calls[0] ?? [];
      expect(hmacs).toHaveLength(1);
      expect(hmacs?.[0]).toHaveLength(32);
      expect(Array.from(hmacs?.[0] ?? [])).toEqual(Array.from(expected));
      expect(Array.from(hmacs?.[0] ?? [])).not.toEqual(Array.from(bare));
    }
    expect(
      Array.from(await activationSuppressionHmac(secret, "a@b.com"))
    ).toEqual(Array.from(expected));
  });

  it("asks for two HMACs, the current and the previous secret's, when a valid previous one is set", async () => {
    spyConsole();
    const previous = "previous-suppression-secret-0123456789-abc";
    const email = activationNoticeEmailConfig(
      bindingsWith({ ACTIVATION_SUPPRESSION_HMAC_SECRET_PREVIOUS: previous }),
      true
    );
    const fixture = setup({ email, suppressed: true });
    await handleActivationNotice(fixture.dependencies, envelope());
    const [hmacs] = fixture.notices.isSuppressed.mock.calls[0] ?? [];
    expect(hmacs).toHaveLength(2);
    expect(Array.from(hmacs?.[0] ?? [])).toEqual(
      Array.from(
        await hmacOf(
          SECRETS.ACTIVATION_SUPPRESSION_HMAC_SECRET,
          "activation-suppression:v1:ana@exemplo.com"
        )
      )
    );
    expect(Array.from(hmacs?.[1] ?? [])).toEqual(
      Array.from(
        await hmacOf(previous, "activation-suppression:v1:ana@exemplo.com")
      )
    );
  });
});

async function hmacOf(secret: string, text: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))
  );
}

describe("the consumer of an activation notice: the send", () => {
  it.each([
    { hasProduct: false, step: "a1" as const },
    { hasProduct: false, step: "a2" as const },
    { hasProduct: true, step: "a2" as const },
    { hasProduct: false, step: "a3" as const },
    { hasProduct: true, step: "a3" as const },
  ])(
    "sends $step (product: $hasProduct) after writing the attempt, with the stop headers",
    async ({ hasProduct, step }) => {
      spyConsole();
      const { dependencies, notices, send } = setup({
        reread: { hasProduct, step, store: STORE_NAME },
      });

      const outcome = await handleActivationNotice(dependencies, envelope());

      expect(outcome).toBe("sent");
      expect(send).toHaveBeenCalledTimes(1);
      expect(notices.markAttempted.mock.invocationCallOrder[0]).toBeLessThan(
        send.mock.invocationCallOrder[0] ?? 0
      );
      expect(notices.markAttempted).toHaveBeenCalledWith(NOTICE, ORG);
      expect(notices.markSent).toHaveBeenCalledWith(NOTICE, ORG);
      expect(notices.markSkipped).not.toHaveBeenCalled();
      expect(notices.markFailed).not.toHaveBeenCalled();
      const message = send.mock.calls[0]?.[0];
      expect(message?.idempotencyKey).toBe(`activation-notice/${NOTICE}`);
      expect(message?.idempotencyKey).toBe(
        activationNoticeIdempotencyKey(NOTICE)
      );
      expect(message?.to).toBe(ADDRESS);
      expect(message?.subject.length).toBeGreaterThan(0);
      expect(message?.subject.length).toBeLessThanOrEqual(40);
      expect(message?.subject).not.toContain(STORE_NAME);
      expect(message?.html).toContain(STORE_NAME);
      const token = await createUnsubscribeToken(
        configured().unsubscribe,
        USER
      );
      expect(message?.headers).toEqual({
        "List-Unsubscribe": `<https://app.example/api/parar-dicas?t=${token}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      });
    }
  );
});

describe("the consumer of an activation notice: the provider's answer", () => {
  it.each([
    { label: "a 503", result: { code: null, outcome: "retry", status: 503 } },
    {
      label: "the network",
      result: { code: null, outcome: "retry", status: null },
    },
    {
      label: "a 409 for a request in flight",
      result: {
        code: "concurrent_idempotent_requests",
        outcome: "retry",
        status: 409,
      },
    },
  ] satisfies { label: string; result: ClosureNoticeSendResult }[])(
    "AC-7c.8: throws a retry error marking nothing on $label",
    async ({ result }) => {
      spyConsole();
      const { dependencies, notices } = setup({ result });

      const failure = await handleActivationNotice(
        dependencies,
        envelope()
      ).then(
        () => null,
        (error: unknown) => error
      );

      expect(failure).toBeInstanceOf(ActivationNoticeRetryError);
      expect((failure as ActivationNoticeRetryError).status).toBe(
        result.status
      );
      expect(notices.markAttempted).toHaveBeenCalledTimes(1);
      expect(notices.markSent).not.toHaveBeenCalled();
      expect(notices.markFailed).not.toHaveBeenCalled();
      expect(notices.markSkipped).not.toHaveBeenCalled();
    }
  );

  it("AC-7c.8: marks the notice sent when the provider already took a message under its key (409 invalid_idempotent_request)", async () => {
    spyConsole();
    const { dependencies, notices } = setup({
      result: {
        code: "invalid_idempotent_request",
        outcome: "retry",
        status: 409,
      },
    });

    expect(await handleActivationNotice(dependencies, envelope())).toBe("sent");

    expect(notices.markSent).toHaveBeenCalledWith(NOTICE, ORG);
    expect(notices.markFailed).not.toHaveBeenCalled();
  });

  it("AC-7c.8: marks the notice failed as email_rejected, with no retry, when the provider refuses", async () => {
    spyConsole();
    const { dependencies, notices, send } = setup({
      result: { code: "validation_error", outcome: "rejected", status: 422 },
    });

    expect(await handleActivationNotice(dependencies, envelope())).toBe(
      "failed"
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(notices.markFailed).toHaveBeenCalledWith(
      NOTICE,
      ORG,
      "email_rejected"
    );
    expect(notices.markSent).not.toHaveBeenCalled();
  });
});

describe("the consumer of an activation notice: the log", () => {
  const paths: [string, SetupOptions][] = [
    ["a sent tip", {}],
    ["a 503", { result: { code: null, outcome: "retry", status: 503 } }],
    [
      "a rejection",
      {
        result: { code: "validation_error", outcome: "rejected", status: 422 },
      },
    ],
    ["a skip for the suppression", { suppressed: true }],
    ["a skip for the hours", { now: new Date("2026-11-12T23:00:00.000Z") }],
    ["a skip for the re-read", { reread: { skip: "activated" } }],
    ["a skip for the configuration", { email: null }],
  ];

  it.each(paths)(
    "AC-7c.3: %s logs no address, no amount, and no store name, with only opaque IDs",
    async (_label, options) => {
      const spies = spyConsole();
      const { dependencies } = setup(options);

      await handleActivationNotice(dependencies, envelope()).catch(
        () => undefined
      );

      const logged = everythingLogged(spies);
      expect(logged).not.toBe("[[],[],[],[]]");
      expectNoPersonalData(logged);
      expect(logged).toContain(`"noticeId":"${NOTICE}"`);
      expect(logged).toContain(`"organizationId":"${ORG}"`);
    }
  );
});
