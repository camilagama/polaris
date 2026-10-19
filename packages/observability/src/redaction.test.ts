import { describe, expect, it } from "vitest";
import { redact, redactText } from "./redaction";

/**
 * The policy of PR116: for each kind of data, an event that carries it under an
 * obvious key and under an innocent key leaves without it. `leaks` looks for the
 * raw datum (and the digits of a number) in the JSON of the redacted event.
 */

const samples = {
  card: {
    key: "cardNumber",
    // Luhn-valid test numbers
    raw: ["4111 1111 1111 1111", "5555-5555-5555-4444", "378282246310005"],
  },
  cnpj: {
    key: "cnpj",
    raw: ["11.222.333/0001-81", "11222333000181"],
  },
  cpf: {
    key: "cpf",
    raw: ["123.456.789-09", "12345678909"],
  },
  email: {
    key: "email",
    raw: ["maria.silva+loja@example.com.br", "ZE@Example.org"],
  },
  ip: {
    key: "clientIp",
    raw: [
      "203.0.113.42",
      "2001:db8:85a3::8a2e:370:7334",
      "::1",
      "fe80::1ff:fe23:4567:890a",
    ],
  },
  phone: {
    key: "phone",
    raw: [
      "(11) 99999-8888",
      "+55 11 99999-8888",
      "11 5555-4444",
      "+5511999998888",
      "99999-8888",
    ],
  },
  secret: {
    key: "token",
    raw: [
      "Bearer abcdef0123456789",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl",
      "sk_live_51HxAbCdEfGhIjKlMn",
      "$aact_hmlg_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6",
      "password=hunter2hunter2",
      "Xk3Jd9Qp2LmN8vRt5YbW7cZa1EfG4hUi",
    ],
  },
} as const;

const leakedFromObjects = /maria@|abcdef0123456789|pw99|abc123|hunter2/;
const markerPrefix = /^\[REDACTED:/;

type Kind = keyof typeof samples;
const kinds = Object.keys(samples) as Kind[];

function leaks(event: unknown, raw: string): boolean {
  const json = JSON.stringify(event);
  const digits = raw.replaceAll(/\D/g, "");
  return json.includes(raw) || (digits.length >= 8 && json.includes(digits));
}

describe("the sample table", () => {
  it("covers every category the policy names", () => {
    expect([...kinds].sort()).toEqual([
      "card",
      "cnpj",
      "cpf",
      "email",
      "ip",
      "phone",
      "secret",
    ]);
  });
});

describe("redaction by key name", () => {
  const sensitiveKeys: Record<string, readonly string[]> = {
    card: ["card", "cardNumber", "cartao", "creditCard", "cvv", "CVC", "pan"],
    cnpj: ["cnpj", "CNPJ", "empresaCnpj"],
    cpf: ["cpf", "customerCpf", "CPF"],
    email: [
      "email",
      "E-Mail",
      "customer_email",
      "userEmail",
      "mail",
      "emailAddress",
    ],
    ip: [
      "ip",
      "IP",
      "ipAddress",
      "clientIp",
      "client_ip",
      "remoteIP",
      "cfConnectingIp",
      "x-forwarded-for",
      "X-Real-IP",
    ],
    phone: [
      "phone",
      "telefone",
      "celular",
      "whatsapp",
      "phoneNumber",
      "customerPhone",
      "tel",
    ],
    secret: [
      "password",
      "senha",
      "newPassword",
      "token",
      "accessToken",
      "refresh_token",
      "Authorization",
      "cookie",
      "Set-Cookie",
      "secret",
      "clientSecret",
      "segredo",
      "apiKey",
      "api_key",
      "privateKey",
      "chave",
      "key",
    ],
  };

  for (const [category, keys] of Object.entries(sensitiveKeys)) {
    it(`masks ${category}, whatever the value looks like`, () => {
      for (const key of keys) {
        const out = redact({ [key]: "plain-looking-value" });
        expect(out[key], key).toBe(`[REDACTED:${category}]`);
      }
    });
  }

  it("masks a number under a sensitive key, keeps a boolean or null", () => {
    expect(
      redact({
        hasPassword: true,
        phone: 11_999_998_888,
        token: null,
      })
    ).toEqual({ hasPassword: true, phone: "[REDACTED:phone]", token: null });
  });

  it("keeps the canonical and the innocent names", () => {
    const fields = {
      actorId: "user_123",
      company: "Loja do Zé",
      durationMs: 12,
      errorClass: "DatabaseError",
      hotel: "x",
      organizationId: "org_1",
      requestId: "req-1",
      route: "/api/sales/:id",
      sqlState: "23505",
      zip: "01001-000",
    };

    expect(redact(fields)).toEqual(fields);
  });
});

describe("redaction by value pattern", () => {
  for (const kind of kinds) {
    const { raw } = samples[kind];

    it(`masks ${kind} under an innocent key`, () => {
      for (const datum of raw) {
        const out = redact({
          note: datum,
          nested: { detail: { text: `before ${datum} after` } },
          list: ["x", datum, { more: [datum] }],
        });
        expect(leaks(out, datum), datum).toBe(false);
        expect(JSON.stringify(out), datum).toContain(`[REDACTED:${kind}]`);
        // the text around the datum survives
        expect(JSON.stringify(out)).toContain("before");
      }
    });

    it(`masks ${kind} under its obvious key`, () => {
      for (const datum of raw) {
        const out = redact({ [samples[kind].key]: datum });
        expect(leaks(out, datum), datum).toBe(false);
      }
    });
  }

  it("masks a datum inside a sentence and the digits of a document inside a URL", () => {
    expect(
      redactText("contact maria@example.com or 11 98888-7777 at 203.0.113.9")
    ).toBe("contact [REDACTED:email] or [REDACTED:phone] at [REDACTED:ip]");
    expect(redactText("/clientes/12345678909?x=1")).not.toContain(
      "12345678909"
    );
  });

  it("masks a cookie header and a set-cookie line", () => {
    const text = "better-auth.session_token=abc123def456; Path=/; HttpOnly";
    expect(redactText(text)).not.toContain("abc123def456");
    expect(redactText("session_id=0123456789abcdef; theme=dark")).not.toContain(
      "0123456789abcdef"
    );
  });

  it("masks keys that are data", () => {
    const out = redact({ "maria@example.com": 1, "joao@example.com": 2 });

    expect(JSON.stringify(out)).not.toContain("example.com");
    expect(Object.keys(out)).toHaveLength(2);
  });

  it("keeps what is not personal data", () => {
    const safe = [
      "2026-10-18T12:34:56.789Z",
      "12:30:45",
      "0190b2c4-7d5a-7e2f-9a11-123456789012",
      "01J9ZQ4M8K3T2X5Y7V6W0N1B2C",
      "outbox.dispatch",
      "v1.2.3",
      "23505",
      "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      "1760000000000",
      "GET /api/sales/:id",
      "scheduled_job_run",
      "1.2.3",
      "Error::Foo",
      "/produtos/categorias",
      "ScheduledJobRunOutcomeHandler2Failure.reconcileStagedMedia",
      "/api/v1/organizations/01J9ZQ4M8K3T2X5Y7V6W0N1B2C/sales",
      "Basic information about the task",
      "3 tokens used, 2 keys listed",
    ];

    for (const text of safe) {
      expect(redactText(text), text).toBe(text);
    }
  });

  it("does not mask a UUID whose last block is all digits", () => {
    const id = "00000000-0000-7000-8000-123456789012";

    expect(redactText(id)).toBe(id);
    expect(redactText(`request ${id}`)).toBe(`request ${id}`);
  });

  it("does not take a card-shaped number that fails the Luhn check", () => {
    expect(redactText("4111 1111 1111 1112")).not.toContain("[REDACTED:card]");
  });

  it("is idempotent", () => {
    const once = redact({ note: "maria@example.com 203.0.113.9", token: "x" });

    expect(redact(once)).toEqual(once);
  });

  it("keeps numbers and booleans under innocent keys", () => {
    expect(redact({ removed: 3, ok: true, none: null })).toEqual({
      none: null,
      ok: true,
      removed: 3,
    });
  });
});

describe("redaction of what the audit tried", () => {
  const leaking: [string, string[]][] = [
    [
      "Authorization: Bearer 0190b2c4-7d5a-7e2f-9a11-123456789012",
      ["0190b2c4-7d5a"],
    ],
    ["session_id=0190b2c4-7d5a-7e2f-9a11-123456789012", ["0190b2c4-7d5a"]],
    ['{"password":"hunter2"}', ["hunter2"]],
    ['{"access_token": "abcdef123456"}', ["abcdef123456"]],
    ['{"client_secret":"abc123xyz"}', ["abc123xyz"]],
    ['{"apiKey":"abcdef123"}', ["abcdef123"]],
    ["Authorization: Basic dXNlcjpwYXNz", ["dXNlcjpwYXNz"]],
    ["Authorization: Token abcdef123456", ["abcdef123456"]],
    ["Cookie: a=1; sid=Zk93nd02mdkE; theme=x", ["Zk93nd02mdkE", "theme=x"]],
    ["pass=abc123 pwd=xyz789", ["abc123", "xyz789"]],
    ["postgresql://polaris:polaris@localhost:5432/db", ["polaris:polaris"]],
    ["postgres://user:pw12@db:5432/x", ["pw12"]],
    ["redis://:secretpw@host:6379", ["secretpw"]],
    [
      "postgresql://neondb_owner:npg_AbC123@ep-x.neon.tech/db",
      ["npg_AbC123", "neondb_owner"],
    ],
    ["AKIAIOSFODNN7EXAMPLE", ["AKIAIOSFODNN7EXAMPLE"]],
    ["１２３.４５６.７８９-０９", ["７８９"]],
    ["（１１）９８８８８-７７７７", ["８８８"]],
    ["ｍａｒｉａ＠example.com", ["example.com"]],
    ["123.456.\u200b789-09", ["789-09"]],
    ["12.ABC.345/01DE-35", ["ABC.345"]],
    ["12ABC34501DE35", ["12ABC34501DE35"]],
    ["5511988887777", ["988887777"]],
    ["wa.me/5511988887777", ["988887777"]],
    ["123 456 789 09", ["456 789"]],
    ["203.000.113.009", ["113.009"]],
    ["4111  1111  1111  1111", ["1111  1111"]],
    ["4111.1111.1111.1111", ["1111.1111"]],
    ["4111/1111/1111/1111", ["1111/1111"]],
  ];

  for (const [text, secrets] of leaking) {
    it(`masks ${JSON.stringify(text)}`, () => {
      const out = redactText(text);
      for (const secret of secrets) {
        expect(out).not.toContain(secret);
      }
      expect(out).toContain("[REDACTED:");
    });
  }

  it("keeps the words around a masked value", () => {
    expect(redactText("falhou com password=hunter2 ao conectar")).toContain(
      "ao conectar"
    );
    expect(redactText("falhou com password=hunter2 ao conectar")).not.toContain(
      "hunter2"
    );
  });

  it("finishes in a bounded time on text built to make a pattern backtrack", () => {
    const hostile = [
      "password.".repeat(5000),
      "a".repeat(200_000),
      "a.".repeat(100_000),
      "a-".repeat(100_000),
      "1-".repeat(100_000),
      "token".repeat(50_000),
      "@".repeat(100_000),
      "a@".repeat(50_000),
      `${"x".repeat(100_000)}@`,
      "1.".repeat(100_000),
      ":".repeat(100_000),
      "4".repeat(100_000),
    ];
    const started = performance.now();

    for (const text of hostile) {
      redactText(text);
    }

    // generous: the point is milliseconds, not the tens of seconds an unbounded pattern took
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it("cuts a long text and says so, without losing what is before the cut", () => {
    const out = redactText(`${"ok ".repeat(2000)}maria@example.com`);

    expect(out).toContain("[TRUNCATED]");
    expect(out.startsWith("ok ok")).toBe(true);
    expect(out).not.toContain("maria@example.com");
  });

  it("keeps a bounded number of entries per container", () => {
    const many = Array.from({ length: 1000 }, (_, index) => index);
    const out = redact({
      list: many,
      object: Object.fromEntries(many.map((index) => [`k${index}`, index])),
      set: new Set(many),
    }) as {
      list: unknown[];
      object: Record<string, unknown>;
      set: unknown[];
    };

    expect(out.list).toHaveLength(101);
    expect(out.list.at(-1)).toBe("[TRUNCATED:900]");
    expect(Object.keys(out.object)).toHaveLength(101);
    expect(out.object["[TRUNCATED]"]).toBe(900);
    expect(out.set).toHaveLength(101);
  });

  it("does not turn bytes into a million keys, and reads boxed strings and web objects", () => {
    const out = redact({
      bytes: new Uint8Array(1_000_000),
      // biome-ignore lint/style/useConsistentBuiltinInstantiation: a boxed string is the case under test
      boxed: new String("maria@example.com"),
      headers: new Headers({
        authorization: "Bearer abcdef0123456789",
        accept: "application/json",
      }),
      url: new URL("https://u:pw99@example.com/a?token=abc123"),
      query: new URLSearchParams("password=hunter2&page=2"),
    });

    expect(out.bytes).toBe("[BINARY:1000000]");
    expect(JSON.stringify(out)).not.toMatch(leakedFromObjects);
    expect(out.headers).toMatchObject({ accept: "application/json" });
    expect(out.query).toMatchObject({ page: "2" });
  });

  it("keeps a counter that has a sensitive word, and a name that only starts with one", () => {
    expect(
      redact({
        emailProvider: "resend",
        emailsSent: 3,
        idempotencyKey: "abc",
        ipCount: 4,
        objectKey: "media/1",
        phoneCount: 2,
        removedKeys: 5,
        tokenCount: 3,
      })
    ).toEqual({
      emailProvider: "resend",
      emailsSent: 3,
      idempotencyKey: "abc",
      ipCount: 4,
      objectKey: "media/1",
      phoneCount: 2,
      removedKeys: 5,
      tokenCount: 3,
    });
    // the string under the same name is still masked
    expect(redact({ tokenCount: "abc" }).tokenCount).toBe("[REDACTED:secret]");
  });

  it("masks the key names the audit listed", () => {
    for (const key of [
      "session",
      "sessionId",
      "sid",
      "csrf",
      "otp",
      "pin",
      "signature",
      "hmac",
      "connectionString",
      "databaseUrl",
      "DATABASE_URL",
      "dsn",
      "pass",
      "documento",
      "msisdn",
      "remoteAddr",
      "remoteAddress",
      "magicLink",
      "verificationCode",
    ]) {
      expect(redact({ [key]: "x1" })[key], key).toMatch(markerPrefix);
    }
  });
});

describe("redaction at depth", () => {
  it("reaches arrays of objects, Maps and Sets", () => {
    const out = redact({
      customers: [
        { contact: { email: "a@b.co" } },
        { note: "cpf 123.456.789-09" },
      ],
      map: new Map([
        ["password", "p"],
        ["free", "maria@example.com"],
      ]),
      set: new Set(["203.0.113.1"]),
    });

    const json = JSON.stringify(out);
    for (const raw of [
      "a@b.co",
      "123.456.789-09",
      "maria@example.com",
      "203.0.113.1",
    ]) {
      expect(json).not.toContain(raw);
    }
    expect((out.map as Record<string, unknown>).password).toBe(
      "[REDACTED:secret]"
    );
  });

  it("walks error.cause chains and nested keys of an error", () => {
    const root = Object.assign(
      new Error("connect failed for maria@example.com"),
      {
        code: "ECONNRESET",
        password: "hunter2",
      }
    );
    const error = new Error("outer 203.0.113.7", {
      cause: new Error("middle", { cause: root }),
    });

    const out = redact({ error });
    const json = JSON.stringify(out);

    expect(json).not.toContain("maria@example.com");
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("203.0.113.7");
    expect(json).toContain("ECONNRESET");
    expect(json).toContain("outer");
  });

  it("walks AggregateError members", () => {
    const out = redact({
      error: new AggregateError([new Error("bad 11 98888-7777")], "many"),
    });

    expect(JSON.stringify(out)).not.toContain("98888-7777");
  });

  it("survives a cycle and a very deep object", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    let deep: Record<string, unknown> = { leaf: "maria@example.com" };
    for (let i = 0; i < 40; i += 1) {
      deep = { next: deep };
    }

    const out = redact({ loop, deep });

    expect(JSON.stringify(out)).toContain("[CIRCULAR]");
    expect(JSON.stringify(out)).toContain("[TRUNCATED]");
    expect(JSON.stringify(out)).not.toContain("maria@example.com");
  });

  it("repeats a shared reference without calling it a cycle", () => {
    const shared = { count: 1 };

    expect(redact({ a: shared, b: shared })).toEqual({
      a: { count: 1 },
      b: { count: 1 },
    });
  });

  it("turns what is not data into something safe", () => {
    const out = redact({
      big: 10n,
      date: new Date("2026-10-18T00:00:00.000Z"),
      fn: () => "x",
      symbol: Symbol("x"),
    });

    expect(out).toMatchObject({ big: "10", date: "2026-10-18T00:00:00.000Z" });
    expect(out.fn).toBeUndefined();
    expect(out.symbol).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const input = { nested: { email: "a@b.co" }, token: "t" };
    const snapshot = structuredClone(input);

    redact(input);

    expect(input).toEqual(snapshot);
  });

  it("handles a key named like a prototype slot", () => {
    const hostile = JSON.parse('{"__proto__": {"password": "x"}, "ok": 1}');

    const out = redact(hostile);

    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.ok).toBe(1);
    expect(({} as Record<string, unknown>).password).toBeUndefined();
  });
});
