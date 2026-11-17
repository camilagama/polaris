import type { ActivationEmailEventRecorder } from "@polaris/db/activation-email-events";
import { normalizeActivationAddress } from "@polaris/domain/activation/notices";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activationSuppressionHmac,
  activationSuppressionKeyId,
} from "../activation/notice-consumer";
import { createServerApp } from "../app";
import type { ServerEnv, WorkerBindings } from "../environment";
import { requestIdMiddleware } from "../middleware/request-id";
import { createResendWebhookRoutes } from "./resend-webhooks";

const NOW = new Date("2026-11-17T15:00:00.000Z");
const NOW_SECONDS = String(Math.floor(NOW.getTime() / 1000));
const KEY_TEXT = "webhook-signing-key-0123456789-abc";
const WEBHOOK_SECRET = `whsec_${btoa(KEY_TEXT)}`;
const SUPPRESSION_SECRET = "suppression-secret-0123456789-abcdefgh";
const EVENT_ID = "msg_2abcDEF123456789";
const ADDRESS = "ana@exemplo.com";

const BINDINGS = {
  ACTIVATION_SUPPRESSION_HMAC_SECRET: SUPPRESSION_SECRET,
  BILLING_HYPERDRIVE: { connectionString: "postgresql://billing.invalid/db" },
  RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
} as unknown as WorkerBindings;

const encoder = new TextEncoder();

async function sign(
  body: string,
  options: { id?: string; timestamp?: string } = {}
): Promise<Record<string, string>> {
  const id = options.id ?? EVENT_ID;
  const timestamp = options.timestamp ?? NOW_SECONDS;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(KEY_TEXT),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${id}.${timestamp}.${body}`)
    )
  );
  return {
    "svix-id": id,
    "svix-signature": `v1,${btoa(String.fromCharCode(...mac))}`,
    "svix-timestamp": timestamp,
  };
}

function fakeRecorder(
  options: { duplicate?: boolean; fail?: boolean; stopped?: boolean } = {}
) {
  const record = vi.fn(() =>
    options.fail
      ? Promise.reject(new Error("database down"))
      : Promise.resolve(
          options.duplicate
            ? { duplicate: true as const }
            : {
                duplicate: false as const,
                stopped: options.stopped ?? false,
                suppressed: 1,
              }
        )
  );
  const close = vi.fn(() => Promise.resolve());
  return { close, record } satisfies ActivationEmailEventRecorder;
}

function setup(
  options: {
    bindings?: Partial<Record<keyof WorkerBindings, unknown>>;
    recorder?: ReturnType<typeof fakeRecorder>;
  } = {}
) {
  const recorder = options.recorder ?? fakeRecorder();
  const createRecorder = vi.fn(() => recorder);
  const app = new Hono<ServerEnv>();
  app.use("*", requestIdMiddleware);
  app.route("/", createResendWebhookRoutes({ createRecorder, now: () => NOW }));
  const bindings = { ...BINDINGS, ...options.bindings } as WorkerBindings;
  const send = (body: string, headers: Record<string, string>) =>
    app.fetch(
      new Request("https://polaris.example.invalid/webhooks/email/resend", {
        body,
        headers,
        method: "POST",
      }),
      bindings
    );
  const sendSigned = async (body: string) => send(body, await sign(body));
  return { createRecorder, recorder, send, sendSigned };
}

function eventOf(type: string, data: unknown): string {
  return JSON.stringify({ created_at: "2026-11-17T14:59:00Z", data, type });
}

const complained = (data: unknown) => eventOf("email.complained", data);
const bounced = (data: unknown) => eventOf("email.bounced", data);

function spyConsole() {
  return [
    vi.spyOn(console, "error").mockImplementation(() => undefined),
    vi.spyOn(console, "info").mockImplementation(() => undefined),
    vi.spyOn(console, "log").mockImplementation(() => undefined),
    vi.spyOn(console, "warn").mockImplementation(() => undefined),
  ];
}

function logged(spies: ReturnType<typeof spyConsole>): string {
  return JSON.stringify(spies.map((spy) => spy.mock.calls));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the signature comes before the database", () => {
  const body = complained({ to: [ADDRESS] });

  async function refused(
    mutate: (headers: Record<string, string>) => Record<string, string>,
    payload = body
  ) {
    const fixture = setup();
    const response = await fixture.send(payload, mutate(await sign(body)));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
    expect(fixture.createRecorder).not.toHaveBeenCalled();
    expect(fixture.recorder.record).not.toHaveBeenCalled();
  }

  it("refuses a delivery without the headers", async () => {
    await refused(() => ({}));
  });

  it("refuses a wrong signature", async () => {
    await refused((headers) => ({
      ...headers,
      "svix-signature": `v1,${btoa("x".repeat(32))}`,
    }));
  });

  it("refuses a body changed by one byte", async () => {
    await refused((headers) => headers, `${body} `);
  });

  it.each([-301, 301])(
    "refuses a timestamp %i seconds from now, in the past and in the future",
    async (offset) => {
      const timestamp = String(Number(NOW_SECONDS) + offset);
      const fixture = setup();
      const response = await fixture.send(
        body,
        await sign(body, { timestamp })
      );
      expect(response.status).toBe(401);
      expect(fixture.createRecorder).not.toHaveBeenCalled();
    }
  );

  it("refuses a timestamp of more than 10 digits", async () => {
    const fixture = setup();
    const response = await fixture.send(
      body,
      await sign(body, { timestamp: `${NOW_SECONDS}0` })
    );
    expect(response.status).toBe(401);
    expect(fixture.createRecorder).not.toHaveBeenCalled();
  });

  it("accepts one valid signature among several", async () => {
    const fixture = setup();
    const headers = await sign(body);
    const response = await fixture.send(body, {
      ...headers,
      "svix-signature": `v1,${btoa("y".repeat(32))} ${headers["svix-signature"]}`,
    });
    expect(response.status).toBe(200);
    expect(fixture.recorder.record).toHaveBeenCalledOnce();
  });

  it("logs the refusal without the reason, a header or the body", async () => {
    const spies = spyConsole();
    const fixture = setup();
    await fixture.send(body, {});
    const text = logged(spies);
    expect(text).toContain("resend_webhook_rejected");
    expect(text).not.toContain(ADDRESS);
    expect(text).not.toContain("svix");
  });
});

describe("a delivery that cannot be served is answered 503 before the body is read", () => {
  it.each([
    ["the webhook's secret is missing", { RESEND_WEBHOOK_SECRET: undefined }],
    [
      "the webhook's secret is not a whsec_ one",
      { RESEND_WEBHOOK_SECRET: "x".repeat(40) },
    ],
    ["the database is not bound", { BILLING_HYPERDRIVE: undefined }],
    [
      "the suppression's secret is missing",
      { ACTIVATION_SUPPRESSION_HMAC_SECRET: undefined },
    ],
  ])("when %s", async (_label, bindings) => {
    const fixture = setup({ bindings });
    const body = complained({ to: [ADDRESS] });
    const response = await fixture.sendSigned(body);
    expect(response.status).toBe(503);
    expect(fixture.createRecorder).not.toHaveBeenCalled();
  });

  it("answers 413 to a body over 64 KiB, signed or not", async () => {
    const fixture = setup();
    const big = "x".repeat(65 * 1024);
    const response = await fixture.sendSigned(big);
    expect(response.status).toBe(413);
    expect(fixture.createRecorder).not.toHaveBeenCalled();
  });
});

describe("a complaint always stops the series (the shape of the payload cannot drop it)", () => {
  async function expectStopped(body: string, hmacCount: number) {
    const spies = spyConsole();
    const fixture = setup({ recorder: fakeRecorder({ stopped: true }) });
    const response = await fixture.sendSigned(body);
    expect(response.status).toBe(200);
    expect(fixture.recorder.record).toHaveBeenCalledOnce();
    const [call] = fixture.recorder.record.mock.calls as unknown as [
      [{ eventId: string; hmacs: Uint8Array[]; keyId: string; kind: string }],
    ];
    expect(call[0].kind).toBe("complaint");
    expect(call[0].eventId).toBe(EVENT_ID);
    expect(call[0].hmacs).toHaveLength(hmacCount);
    expect(call[0].keyId).toBe(
      await activationSuppressionKeyId(SUPPRESSION_SECRET)
    );
    expect(fixture.recorder.close).toHaveBeenCalledOnce();
    return logged(spies);
  }

  it("records a complaint with the addressee as a list of texts", async () => {
    const text = await expectStopped(complained({ to: [ADDRESS] }), 1);
    expect(text).not.toContain("@");
    expect(text).toContain("activation_series_stopped");
  });

  it("records a complaint with the addressee as one text", async () => {
    await expectStopped(complained({ to: ADDRESS }), 1);
  });

  it("hashes the normalized address with the current secret", async () => {
    const fixture = setup();
    await fixture.sendSigned(complained({ to: ["Ana <ANA@Exemplo.com> "] }));
    const [call] = fixture.recorder.record.mock.calls as unknown as [
      [{ hmacs: Uint8Array[] }],
    ];
    const normalized = normalizeActivationAddress(ADDRESS) as string;
    expect(call[0].hmacs[0]).toEqual(
      await activationSuppressionHmac(SUPPRESSION_SECRET, normalized)
    );
  });

  it.each([
    ["an empty data", complained({}), 0],
    ["no data at all", JSON.stringify({ type: "email.complained" }), 0],
    ["data that is a text", complained("x"), 0],
    ["no to", complained({ email_id: "abc" }), 0],
    [
      "a to that is a list of objects",
      complained({ to: [{ email: ADDRESS }] }),
      0,
    ],
    ["a to that is an empty list", complained({ to: [] }), 0],
    ["a to that is a number", complained({ to: 7 }), 0],
    [
      "an addressee that cannot be normalized",
      complained({ to: ["não é endereço"] }),
      0,
    ],
  ])("records the stop with no HMAC for %s", async (_label, body, count) => {
    const text = await expectStopped(body, count);
    expect(text).not.toContain(ADDRESS);
    if (!text.includes("não é endereço")) {
      expect(text).toContain("resend_complaint_unparseable");
    }
  });

  it("keeps the stop when there are more than 50 addresses, with the first 50 HMACs", async () => {
    const many = Array.from(
      { length: 60 },
      (_, index) => `p${index}@exemplo.com`
    );
    await expectStopped(complained({ to: many }), 50);
  });

  it("answers a repeated delivery 200 with duplicate, and the database decides", async () => {
    const fixture = setup({ recorder: fakeRecorder({ duplicate: true }) });
    const response = await fixture.sendSigned(complained({ to: [ADDRESS] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ duplicate: true });
  });

  it("answers 503 when the database fails, so the provider sends it again", async () => {
    const spies = spyConsole();
    const fixture = setup({ recorder: fakeRecorder({ fail: true }) });
    const response = await fixture.sendSigned(complained({ to: [ADDRESS] }));
    expect(response.status).toBe(503);
    expect(fixture.recorder.close).toHaveBeenCalledOnce();
    expect(logged(spies)).not.toContain(ADDRESS);
  });
});

describe("a bounce suppresses the address unless it is explicitly transient", () => {
  it.each([
    ["Permanent", { bounce: { type: "Permanent" }, to: [ADDRESS] }],
    ["an absent type", { to: [ADDRESS] }],
    ["an unknown type", { bounce: { type: "Undetermined" }, to: [ADDRESS] }],
    ["a type that is not a text", { bounce: { type: 5 }, to: [ADDRESS] }],
  ])("records it for %s", async (_label, data) => {
    const fixture = setup();
    const response = await fixture.sendSigned(bounced(data));
    expect(response.status).toBe(200);
    const [call] = fixture.recorder.record.mock.calls as unknown as [
      [{ hmacs: Uint8Array[]; kind: string }],
    ];
    expect(call[0].kind).toBe("bounce");
    expect(call[0].hmacs).toHaveLength(1);
  });

  it.each(["Transient", "transient"])(
    "ignores a bounce of type %s with a 200 and no write",
    async (type) => {
      const fixture = setup();
      const response = await fixture.sendSigned(
        bounced({ bounce: { type }, to: [ADDRESS] })
      );
      expect(response.status).toBe(200);
      expect(fixture.createRecorder).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["no to", { bounce: { type: "Permanent" } }],
    ["a to of objects", { to: [{ email: ADDRESS }] }],
    ["an addressee that cannot be normalized", { to: ["x"] }],
    [
      "more than 50 addresses",
      { to: Array.from({ length: 51 }, (_, i) => `p${i}@exemplo.com`) },
    ],
  ])("answers 200 and writes nothing for %s", async (_label, data) => {
    const spies = spyConsole();
    const fixture = setup();
    const response = await fixture.sendSigned(bounced(data));
    expect(response.status).toBe(200);
    expect(fixture.createRecorder).not.toHaveBeenCalled();
    expect(logged(spies)).not.toContain("exemplo.com");
  });
});

describe("the other deliveries touch nothing", () => {
  it.each([
    "email.delivered",
    "email.suppressed",
    "email.failed",
    "email.delivery_delayed",
    "email.opened",
    "email.clicked",
    "domain.updated",
  ])("answers 200 to %s with no write", async (type) => {
    const fixture = setup();
    const response = await fixture.sendSigned(eventOf(type, { to: [ADDRESS] }));
    expect(response.status).toBe(200);
    expect(fixture.createRecorder).not.toHaveBeenCalled();
  });

  it("answers 200 to an object with no type, writing nothing", async () => {
    const fixture = setup();
    const response = await fixture.sendSigned("{}");
    expect(response.status).toBe(200);
    expect(fixture.createRecorder).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "{ not json ana@exemplo.com"],
    ["JSON that is not an object", "[1,2]"],
  ])(
    "answers 200 to a signed body that is %s, logging no part of it",
    async (_label, body) => {
      const spies = spyConsole();
      const fixture = setup();
      const response = await fixture.sendSigned(body);
      expect(response.status).toBe(200);
      expect(fixture.createRecorder).not.toHaveBeenCalled();
      const text = logged(spies);
      expect(text).toContain("resend_webhook_unreadable");
      expect(text).not.toContain("ana@");
      expect(text).not.toContain("not json");
    }
  );
});

describe("the endpoint in the application", () => {
  it("is mounted outside the origin guard and refuses an unsigned delivery with 401", async () => {
    const app = createServerApp();
    const response = await app.fetch(
      new Request("https://polaris.example.invalid/webhooks/email/resend", {
        body: "{}",
        method: "POST",
      }),
      BINDINGS
    );
    expect(response.status).toBe(401);
  });
});
